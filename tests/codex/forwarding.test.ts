import { describe, expect, it, vi } from "vitest";
import { SHARED_CODEX_AUTH_ID } from "../../src/db";
import { handleRequest } from "../../src/router";
import {
  admin,
  createKey,
  createUser,
  importSharedAuth,
  makeFixture
} from "../router/fixture";

describe("Codex forwarding", () => {
  it("forwards Codex speech to api.openai.com with the ChatGPT slot used by Responses", async () => {
    const fixture = makeFixture();
    const created = await createUser(fixture, "speech@example.com");
    const keyBody = await createKey(fixture, created.user.id, ["surface:codex:production"]);
    const imported = await admin(fixture, "https://api.trustedtunnel.app/admin/codex-auths/shared_default/import", {
      method: "POST",
      body: {
        access_token: "shared_access",
        expires_at: "2026-06-24T12:00:00.000Z",
        account_id: "acct_shared"
      }
    });
    expect(imported.status).toBe(201);

    const speech = await handleRequest(new Request("https://api.trustedtunnel.app/v1/audio/speech", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${keyBody.api_key}`,
        "Content-Type": "application/json"
      },
      body: "{}"
    }), fixture.env, fixture.ctx, fixture.deps);
    expect(speech.status).toBe(200);
    expect(fixture.fetchCalls).toHaveLength(1);
    expect(fixture.fetchCalls[0]).toMatchObject({
      url: "https://api.openai.com/v1/audio/speech",
      method: "POST",
      authorization: "Bearer shared_access"
    });
    expect(fixture.fetchCalls[0].headers.get("Chatgpt-Account-Id")).toBe("acct_shared");
    expect(fixture.fetchCalls[0].headers.get("X-Codex-Egress-Secret")).toBeNull();
    expect(fixture.fetchCalls[0].headers.get("Originator")).toBeNull();
  });

  it("forwards Codex realtime calls to api.openai.com with the ChatGPT slot used by Responses", async () => {
    const fixture = makeFixture();
    const created = await createUser(fixture, "realtime-calls@example.com");
    const keyBody = await createKey(fixture, created.user.id, ["surface:codex:production"]);
    const imported = await admin(fixture, "https://api.trustedtunnel.app/admin/codex-auths/shared_default/import", {
      method: "POST",
      body: {
        access_token: "shared_access",
        expires_at: "2026-06-24T12:00:00.000Z",
        account_id: "acct_shared"
      }
    });
    expect(imported.status).toBe(201);

    const body = [
      "--codex-realtime-call-boundary\r",
      "Content-Disposition: form-data; name=\"sdp\"\r",
      "Content-Type: application/sdp\r",
      "\r",
      "v=offer\r",
      "\r",
      "--codex-realtime-call-boundary\r",
      "Content-Disposition: form-data; name=\"session\"\r",
      "Content-Type: application/json\r",
      "\r",
      "{\"type\":\"quicksilver\",\"model\":\"gpt-realtime-1.5\"}\r",
      "--codex-realtime-call-boundary--\r",
      ""
    ].join("\n");
    const calls = await handleRequest(new Request(
      "https://api.trustedtunnel.app/v1/realtime/calls?intent=quicksilver&architecture=avas",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${keyBody.api_key}`,
          "Content-Type": "multipart/form-data; boundary=codex-realtime-call-boundary",
          "OpenAI-Alpha": "quicksilver=v1",
          Originator: "codex_cli_rs"
        },
        body
      }
    ), fixture.env, fixture.ctx, fixture.deps);
    expect(calls.status).toBe(200);
    expect(fixture.fetchCalls).toHaveLength(1);
    expect(fixture.fetchCalls[0]).toMatchObject({
      url: "https://api.openai.com/v1/realtime/calls?intent=quicksilver&architecture=avas",
      method: "POST",
      authorization: "Bearer shared_access"
    });
    expect(fixture.fetchCalls[0].headers.get("Chatgpt-Account-Id")).toBe("acct_shared");
    expect(fixture.fetchCalls[0].headers.get("X-Codex-Egress-Secret")).toBeNull();
    expect(fixture.fetchCalls[0].headers.get("OpenAI-Alpha")).toBe("quicksilver=v1");
    expect(fixture.fetchCalls[0].headers.get("Originator")).toBe("codex_cli_rs");
    expect(fixture.fetchCalls[0].headers.get("Authorization")).toBe("Bearer shared_access");
  });

  it("authenticates with one joined read and defers a throttled last-used write", async () => {
    const fixture = makeFixture();
    const user = await createUser(fixture, "auth-hot-path@example.com");
    const key = await createKey(fixture, user.user.id, ["surface:codex:production"]);
    await importSharedAuth(fixture);
    const preparedBefore = fixture.db.preparedSql.length;
    let releaseTouch: (() => void) | undefined;
    fixture.db.apiKeyTouchBarrier = new Promise<void>((resolve) => {
      releaseTouch = resolve;
    });

    const first = await handleRequest(new Request("https://api.trustedtunnel.app/v1/models", {
      headers: { Authorization: `Bearer ${key.api_key}` }
    }), fixture.env, fixture.ctx, fixture.deps);
    expect(first.status).toBe(200);
    expect(fixture.db.apiKeys.get(key.key.id)?.last_used_at).toBeNull();
    const authenticationSql = fixture.db.preparedSql.slice(preparedBefore);
    expect(authenticationSql.filter((sql) => sql.includes("FROM api_keys AS ak"))).toHaveLength(1);
    expect(authenticationSql).not.toContain("SELECT * FROM users WHERE id = ?");

    releaseTouch?.();
    await fixture.ctx.flush();
    expect(fixture.db.apiKeys.get(key.key.id)?.last_used_at).toBe("2026-06-24T00:00:00.000Z");
    const touchCount = fixture.db.preparedSql.filter((sql) => sql.startsWith("UPDATE api_keys SET last_used_at")).length;

    const second = await handleRequest(new Request("https://api.trustedtunnel.app/v1/models", {
      headers: { Authorization: `Bearer ${key.api_key}` }
    }), fixture.env, fixture.ctx, fixture.deps);
    expect(second.status).toBe(200);
    await fixture.ctx.flush();
    expect(fixture.db.preparedSql.filter((sql) => sql.startsWith("UPDATE api_keys SET last_used_at"))).toHaveLength(touchCount);
  });

  it("uses one shared_default Codex auth for multiple users and records per-key audit", async () => {
    const fixture = makeFixture();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    try {
      const alice = await createUser(fixture, "alice@example.com");
      const bob = await createUser(fixture, "bob@example.com");
      const aliceKey = await createKey(fixture, alice.user.id, ["surface:codex:production"]);
      const bobKey = await createKey(fixture, bob.user.id, ["surface:codex:production"]);

      const importResponse = await admin(fixture, "https://api.trustedtunnel.app/admin/codex-auths/shared_default/import", {
        method: "POST",
        body: {
          access_token: "shared_access",
          refresh_token: "shared_refresh",
          expires_at: "2026-06-24T12:00:00.000Z",
          account_id: "acct_shared",
          email: "admin@example.com"
        }
      });
      expect(importResponse.status).toBe(201);
      const importBody = await importResponse.json();
      expect(importBody).toMatchObject({
        auth: {
          id: SHARED_CODEX_AUTH_ID,
          kind: "shared",
          status: "active"
        },
        diagnostics: {
          auth_id: SHARED_CODEX_AUTH_ID,
          expires_at_defaulted: false,
          refresh_available: true
        }
      });
      expectPublicCodexAuthShape((importBody as { auth: unknown }).auth);
      expect(fixture.tokenAuthority.savedToken?.access_token).toBe("shared_access");

      const getSharedAuth = await admin(fixture, "https://admin.example.test/admin/codex-auths/shared_default", { method: "GET" });
      expect(getSharedAuth.status).toBe(200);
      const sharedAuthBody = await getSharedAuth.json();
      expect(sharedAuthBody).toMatchObject({
        auth: {
          id: SHARED_CODEX_AUTH_ID,
          kind: "shared",
          status: "active"
        }
      });
      expectPublicCodexAuthShape((sharedAuthBody as { auth: unknown }).auth);
      expect(JSON.stringify(sharedAuthBody)).not.toContain("shared_access");
      expect(JSON.stringify(sharedAuthBody)).not.toContain("shared_refresh");

      const refreshSharedAuth = await admin(fixture, "https://api.trustedtunnel.app/admin/codex-auths/shared_default/refresh", { method: "POST" });
      expect(refreshSharedAuth.status).toBe(200);
      const refreshBody = await refreshSharedAuth.json();
      expect(refreshBody).toMatchObject({
        auth: {
          id: SHARED_CODEX_AUTH_ID,
          kind: "shared",
          status: "active",
          upstream_account_id: "acct_shared",
          upstream_email: "admin@example.com",
          expires_at: "2026-06-24T01:00:00.000Z",
          last_refresh_at: "2026-06-24T00:00:00.000Z"
        },
        diagnostics: {
          auth_id: SHARED_CODEX_AUTH_ID,
          refreshed: true,
          refresh_available: true,
          previous_expires_at: "2026-06-24T12:00:00.000Z",
          expires_at_changed: true
        }
      });
      expectPublicCodexAuthShape((refreshBody as { auth: unknown }).auth);
      expect(fixture.tokenAuthority.refreshCalls).toBe(1);
      expect(JSON.stringify(refreshBody)).not.toContain("shared_access");
      expect(JSON.stringify(refreshBody)).not.toContain("shared_refresh");
      expect(JSON.stringify(refreshBody)).not.toContain("refreshed_access");
      expect(JSON.stringify(refreshBody)).not.toContain("refreshed_refresh");

      const aliceStream = await handleRequest(new Request("https://api.trustedtunnel.app/v1/responses", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${aliceKey.api_key}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ model: "gpt-5.4", input: "hello", stream: true })
      }), fixture.env, fixture.ctx, fixture.deps);
      expect(aliceStream.status).toBe(200);
      await expect(aliceStream.text()).resolves.toContain("resp_sse");

      const bobStream = await handleRequest(new Request("https://api.trustedtunnel.app/v1/responses", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${bobKey.api_key}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ model: "gpt-5.4", input: "stream", stream: true })
      }), fixture.env, fixture.ctx, fixture.deps);
      expect(bobStream.status).toBe(200);
      expect(bobStream.headers.get("Content-Type")).toContain("text/event-stream");
      await bobStream.text();

      const bobCompact = await handleRequest(new Request("https://api.trustedtunnel.app/v1/responses/compact", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${bobKey.api_key}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ model: "gpt-5.4", input: [] })
      }), fixture.env, fixture.ctx, fixture.deps);
      expect(bobCompact.status).toBe(200);
      await expect(bobCompact.json()).resolves.toEqual({ output: [] });

      const fetchCountBeforeCallerStreamCompact = fixture.fetchCalls.length;
      const callerStreamCompact = await handleRequest(new Request("https://api.trustedtunnel.app/v1/responses/compact", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${bobKey.api_key}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ model: "gpt-5.4", input: [], stream: true })
      }), fixture.env, fixture.ctx, fixture.deps);
      expect(callerStreamCompact.status).toBe(200);
      await expect(callerStreamCompact.json()).resolves.toEqual({ output: [] });
      expect(fixture.fetchCalls).toHaveLength(fetchCountBeforeCallerStreamCompact + 1);

      await fixture.ctx.flush();
      expect(fixture.tokenAuthority.names).toEqual([
        SHARED_CODEX_AUTH_ID,
        SHARED_CODEX_AUTH_ID,
        SHARED_CODEX_AUTH_ID,
        SHARED_CODEX_AUTH_ID,
        SHARED_CODEX_AUTH_ID,
        SHARED_CODEX_AUTH_ID
      ]);
      expect(fixture.fetchCalls.every((call) => call.authorization === "Bearer refreshed_access")).toBe(true);
      expect(fixture.db.audit).toHaveLength(4);
      expect(new Set(fixture.db.audit.map((row) => row.user_id))).toEqual(new Set([alice.user.id, bob.user.id]));
      expect(new Set(fixture.db.audit.map((row) => row.codex_auth_id))).toEqual(new Set([SHARED_CODEX_AUTH_ID]));
      expect(fixture.db.audit.every((row) => typeof row.request_id === "string")).toBe(true);
      expect(fixture.db.audit.every((row) => typeof row.route === "string")).toBe(true);
      expect(fixture.db.audit.every((row) => row.status === "ok" && row.error_code === null)).toBe(true);

      for (const call of logSpy.mock.calls) {
        const rendered = call.join(" ");
        expect(rendered).not.toContain("shared_access");
        expect(rendered).not.toContain("shared_refresh");
        expect(rendered).not.toContain(aliceKey.api_key);
        expect(rendered).not.toContain(bobKey.api_key);
      }

      const blockedDelete = await admin(fixture, "https://api.trustedtunnel.app/admin/codex-auths/shared_default", { method: "DELETE" });
      expect(blockedDelete.status).toBe(409);
      expect(fixture.db.codexAuths.get("shared_default")?.status).not.toBe("revoked");
      const deleteShared = await admin(fixture, "https://api.trustedtunnel.app/admin/codex-auths/shared_default/force-disconnect", { method: "POST" });
      expect(deleteShared.status).toBe(200);

      const afterDelete = await handleRequest(new Request("https://api.trustedtunnel.app/v1/responses", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${aliceKey.api_key}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ model: "gpt-5.4", input: "after delete" })
      }), fixture.env, fixture.ctx, fixture.deps);
      // #63: Slot authority rejects deleted/revoked ChatGPT credentials (no parallel D1 gate).
      expect(afterDelete.status).toBe(401);
      await expect(afterDelete.json()).resolves.toMatchObject({
        error: { code: expect.stringMatching(/credential_inactive|codex_auth_inactive|missing_codex_auth|reauth_required/) }
      });
    } finally {
      logSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });

  it("forwards future Responses bytes once without forcing stream or synthesizing identity", async () => {
    const fixture = makeFixture();
    const user = await createUser(fixture, "opaque@example.com");
    const key = await createKey(fixture, user.user.id, ["surface:codex:production"]);
    await importSharedAuth(fixture);
    const requestBytes = new TextEncoder().encode(
      '{ "model": "future-model", "stream": false, "future_field": { "kept": true } }'
    );

    const response = await handleRequest(new Request("https://api.trustedtunnel.app/v1/responses", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${key.api_key}`,
        "Content-Type": "application/json"
      },
      body: requestBytes
    }), fixture.env, fixture.ctx, fixture.deps);

    expect(response.status).toBe(200);
    await response.text();
    await fixture.ctx.flush();
    expect(fixture.fetchCalls).toHaveLength(1);
    expect(fixture.fetchCalls[0].rawBody).toEqual(requestBytes);
    expect(fixture.fetchCalls[0].sessionId).toBeNull();
    expect(fixture.fetchCalls[0].threadId).toBeNull();
    expect(fixture.fetchCalls[0].installationId).toBeNull();
    expect(fixture.fetchCalls[0].windowId).toBeNull();
    expect(fixture.db.audit).toHaveLength(1);
    expect(fixture.db.audit[0]).toMatchObject({
      response_model: "N/A",
      session_id: null,
      thread_id: null
    });
  });

  it("starts the upstream fetch before the client request stream finishes", async () => {
    const fixture = makeFixture();
    const user = await createUser(fixture, "streaming-upload@example.com");
    const key = await createKey(fixture, user.user.id, ["surface:codex:production"]);
    await importSharedAuth(fixture);
    let markFetchStarted: (() => void) | undefined;
    const fetchStarted = new Promise<void>((resolve) => { markFetchStarted = resolve; });
    const originalFetch = fixture.deps.fetch;
    fixture.deps.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      markFetchStarted?.();
      return originalFetch(input, init);
    }) as typeof fetch;
    const first = new TextEncoder().encode('{"model":"gpt-5.4","input":"');
    const second = new TextEncoder().encode('streamed"}');
    let pullCount = 0;
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        pullCount += 1;
        if (pullCount === 1) {
          controller.enqueue(first);
          return;
        }
        await fetchStarted;
        controller.enqueue(second);
        controller.close();
      }
    });

    const response = await handleRequest(new Request("https://api.trustedtunnel.app/v1/responses", {
      method: "POST",
      headers: { "Authorization": `Bearer ${key.api_key}` },
      body,
      duplex: "half"
    } as RequestInit), fixture.env, fixture.ctx, fixture.deps);

    expect(response.status).toBe(200);
    await response.text();
    expect(fixture.fetchCalls).toHaveLength(1);
    const expected = new Uint8Array(first.byteLength + second.byteLength);
    expected.set(first);
    expected.set(second, first.byteLength);
    expect(fixture.fetchCalls[0].rawBody).toEqual(expected);
  });

  it("does not add observer read-ahead and cancels an interrupted upload exactly once", async () => {
    const fixture = makeFixture();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      const user = await createUser(fixture, "cancel-upload@example.com");
      const key = await createKey(fixture, user.user.id, ["surface:codex:production"]);
      await importSharedAuth(fixture);
      const abortController = new AbortController();
      let pullCount = 0;
      let fetchAttempts = 0;
      let markFetchStarted: (() => void) | undefined;
      const fetchStarted = new Promise<void>((resolve) => { markFetchStarted = resolve; });
      let markSourceCancelled: (() => void) | undefined;
      const sourceCancelled = new Promise<void>((resolve) => { markSourceCancelled = resolve; });
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          pullCount += 1;
          controller.enqueue(new Uint8Array(1024));
        },
        cancel() {
          markSourceCancelled?.();
        }
      });
      fixture.deps.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
        fetchAttempts += 1;
        const reader = (init?.body as ReadableStream<Uint8Array>).getReader();
        const first = await reader.read();
        expect(first.done).toBe(false);
        markFetchStarted?.();
        return await new Promise<Response>((_resolve, reject) => {
          const abort = () => {
            void reader.cancel("client aborted").catch(() => undefined);
            reject(new Error("client aborted"));
          };
          if (init?.signal?.aborted) {
            abort();
          } else {
            init?.signal?.addEventListener("abort", abort, { once: true });
          }
        });
      }) as typeof fetch;

      const responsePromise = handleRequest(new Request("https://api.trustedtunnel.app/v1/responses", {
        method: "POST",
        headers: { "Authorization": `Bearer ${key.api_key}` },
        body,
        signal: abortController.signal,
        duplex: "half"
      } as RequestInit), fixture.env, fixture.ctx, fixture.deps);

      await fetchStarted;
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(pullCount).toBeLessThan(4);

      abortController.abort();
      const response = await responsePromise;
      expect(response.status).toBe(499);
      await sourceCancelled;
      await fixture.ctx.flush();

      expect(fetchAttempts).toBe(1);
      expect(fixture.db.audit).toHaveLength(1);
      expect(fixture.db.audit[0]).toMatchObject({
        route: "/v1/responses",
        status: "error",
        upstream_status: null,
        error_code: "client_request_aborted"
      });
    } finally {
      logSpy.mockRestore();
    }
  });

  it("forwards invalid JSON bytes without inspecting the request body", async () => {
    const fixture = makeFixture();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      const user = await createUser(fixture, "hostile@example.com");
      const key = await createKey(fixture, user.user.id, ["surface:codex:production"]);
      await importSharedAuth(fixture);
      const requestBytes = new Uint8Array([0xff, 0x00, 0x7b, 0x22, 0x6d, 0x6f, 0x64]);

      const response = await handleRequest(new Request("https://api.trustedtunnel.app/v1/responses", {
        method: "POST",
        headers: { "Authorization": `Bearer ${key.api_key}` },
        body: requestBytes
      }), fixture.env, fixture.ctx, fixture.deps);

      expect(response.status).toBe(200);
      await response.text();
      await fixture.ctx.flush();
      expect(fixture.fetchCalls).toHaveLength(1);
      expect(fixture.fetchCalls[0].rawBody).toEqual(requestBytes);
      expect(fixture.db.audit).toHaveLength(1);
      expect(fixture.db.audit[0].response_model).toBe("N/A");
      const outcome = logSpy.mock.calls
        .map(([value]) => JSON.parse(String(value)) as Record<string, unknown>)
        .find((value) => value.route === "/v1/responses");
      expect(outcome).not.toHaveProperty("model");
      expect(outcome).not.toHaveProperty("requested_model");
    } finally {
      logSpy.mockRestore();
    }
  });

  it("forwards an oversized request without request-model observation", async () => {
    const fixture = makeFixture();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      const user = await createUser(fixture, "oversized-observer@example.com");
      const key = await createKey(fixture, user.user.id, ["surface:codex:production"]);
      await importSharedAuth(fixture);
      const requestBytes = new TextEncoder().encode(JSON.stringify({
        model: "not-observed-after-limit",
        input: "with-usage",
        padding: "x".repeat(70 * 1024)
      }));

      const response = await handleRequest(new Request("https://api.trustedtunnel.app/v1/responses", {
        method: "POST",
        headers: { "Authorization": `Bearer ${key.api_key}` },
        body: requestBytes
      }), fixture.env, fixture.ctx, fixture.deps);

      expect(response.status).toBe(200);
      await response.text();
      await fixture.ctx.flush();
      expect(fixture.fetchCalls[0].rawBody).toEqual(requestBytes);
      expect(fixture.db.audit[0].response_model).toBe("gpt-5.4");
      expect(fixture.db.usageDaily.get(`${user.user.id}:2026-06-24:codex.responses:gpt-5.4`)).toMatchObject({
        requests: 1,
        total_tokens: 201
      });
      const outcome = logSpy.mock.calls
        .map(([value]) => JSON.parse(String(value)) as Record<string, unknown>)
        .find((value) => value.route === "/v1/responses");
      expect(outcome).not.toHaveProperty("model");
      expect(outcome).not.toHaveProperty("requested_model");
    } finally {
      logSpy.mockRestore();
    }
  });

  it("delegates future response fields to Backend and records the resulting attempt", async () => {
    const fixture = makeFixture();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      const user = await createUser(fixture, "carol@example.com");
      const key = await createKey(fixture, user.user.id, ["surface:codex:production"]);

      const importResponse = await admin(fixture, "https://api.trustedtunnel.app/admin/codex-auths/shared_default/import", {
        method: "POST",
        body: {
          access_token: "shared_access",
          expires_at: "2026-06-24T12:00:00.000Z",
          account_id: "acct_shared"
        }
      });
      expect(importResponse.status).toBe(201);

      const response = await handleRequest(new Request("https://api.trustedtunnel.app/v1/responses", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${key.api_key}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: "gpt-5.4",
          input: "hello",
          previous_response_id: "resp_1"
        })
      }), fixture.env, fixture.ctx, fixture.deps);

      expect(response.status).toBe(200);
      await response.text();
      expect(fixture.fetchCalls).toHaveLength(1);
      expect(fixture.fetchCalls[0].body.previous_response_id).toBe("resp_1");

      await fixture.ctx.flush();
      expect(fixture.db.audit).toHaveLength(1);
      expect(fixture.db.audit[0]).toMatchObject({
        user_id: user.user.id,
        key_id: key.key.id,
        codex_auth_id: SHARED_CODEX_AUTH_ID,
        route: "/v1/responses",
        status: "ok",
        upstream_status: 200,
        error_code: null
      });
    } finally {
      logSpy.mockRestore();
    }
  });

  it("does not synthesize identity or prompt cache for repeated requests", async () => {
    const fixture = makeFixture();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      const user = await createUser(fixture, "dana@example.com");
      const key = await createKey(fixture, user.user.id, ["surface:codex:production"]);
      const importResponse = await admin(fixture, "https://api.trustedtunnel.app/admin/codex-auths/shared_default/import", {
        method: "POST",
        body: {
          access_token: "shared_access",
          expires_at: "2026-06-24T12:00:00.000Z",
          account_id: "acct_shared"
        }
      });
      expect(importResponse.status).toBe(201);

      const requestIds = [
        "11111111-1111-4111-8111-111111111111",
        "22222222-2222-4222-8222-222222222222"
      ];
      for (const [index, input] of ["first", "second"].entries()) {
        const response = await handleRequest(new Request("https://api.trustedtunnel.app/v1/responses", {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${key.api_key}`,
            "Content-Type": "application/json",
            "X-Client-Request-Id": requestIds[index]
          },
          body: JSON.stringify({ model: "gpt-5.4", input })
        }), fixture.env, fixture.ctx, fixture.deps);
        expect(response.status).toBe(200);
      }

      expect(fixture.fetchCalls).toHaveLength(2);
      for (const call of fixture.fetchCalls) {
        expect(call.sessionId).toBeNull();
        expect(call.threadId).toBeNull();
        expect(call.installationId).toBeNull();
        expect(call.windowId).toBeNull();
        expect(call.body).not.toHaveProperty("prompt_cache_key");
      }
    } finally {
      logSpy.mockRestore();
    }
  });

  it("keeps streaming and compact usage separate by execution plan", async () => {
    const fixture = makeFixture();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      const user = await createUser(fixture, "erin@example.com");
      const key = await createKey(fixture, user.user.id, ["surface:codex:production"]);
      await importSharedAuth(fixture);

      const withUsage = await handleRequest(new Request("https://api.trustedtunnel.app/v1/responses", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${key.api_key}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ model: "gpt-5.4", input: "with-usage", stream: true })
      }), fixture.env, fixture.ctx, fixture.deps);
      expect(withUsage.status).toBe(200);
      await expect(withUsage.text()).resolves.toContain("resp_usage");

      const compactUsage = await handleRequest(new Request("https://api.trustedtunnel.app/v1/responses/compact", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${key.api_key}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ model: "gpt-5.4", input: "compact-usage" })
      }), fixture.env, fixture.ctx, fixture.deps);
      expect(compactUsage.status).toBe(200);
      await expect(compactUsage.json()).resolves.toMatchObject({ id: "resp_compact_usage" });

      const missingUsage = await handleRequest(new Request("https://api.trustedtunnel.app/v1/responses", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${key.api_key}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ model: "gpt-5.4", input: "audit-secret-prompt", stream: true })
      }), fixture.env, fixture.ctx, fixture.deps);
      expect(missingUsage.status).toBe(200);
      await expect(missingUsage.text()).resolves.toContain("audit-secret-output");

      const error = await handleRequest(new Request("https://api.trustedtunnel.app/v1/responses", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${key.api_key}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: "gpt-5.4",
          input: "bad",
          stream_options: { include_usage: true }
        })
      }), fixture.env, fixture.ctx, fixture.deps);
      expect(error.status).toBe(200);
      await error.text();

      await fixture.ctx.flush();

      // Binding persistence is not part of the Provider Attempt lifecycle.
      // The contract is proved by the resulting Credit and accounting rows below.

      const usage = fixture.db.usageDaily.get(`${user.user.id}:2026-06-24:codex.responses:gpt-5.4`);
      expect(usage).toMatchObject({
        user_id: user.user.id,
        day: "2026-06-24",
        route_profile_id: "codex.responses",
        response_model: "gpt-5.4",
        requests: 1,
        ok_requests: 1,
        error_requests: 0,
        input_tokens: 23,
        cached_input_tokens: 3,
        output_tokens: 178,
        reasoning_tokens: 163,
        total_tokens: 201,
        first_seen_at: "2026-06-24T00:00:00.000Z",
        last_seen_at: "2026-06-24T00:00:00.000Z"
      });
      expect(fixture.db.usageDaily.get(`${user.user.id}:2026-06-24:codex.responses_compact:gpt-5.4`)).toMatchObject({
        route_profile_id: "codex.responses_compact",
        requests: 1,
        ok_requests: 1,
        input_tokens: 5,
        cached_input_tokens: 1,
        output_tokens: 7,
        reasoning_tokens: 2,
        total_tokens: 12
      });
      expect(fixture.db.usageDaily.get(`${user.user.id}:2026-06-24:codex.responses:N/A`)).toMatchObject({
        requests: 2,
        ok_requests: 2,
        total_tokens: 0
      });

      expect(fixture.db.audit).toHaveLength(4);
      expect(fixture.db.audit[0]).toMatchObject({
        response_id: "resp_usage",
        input_tokens: 23,
        cached_input_tokens: 3,
        output_tokens: 178,
        reasoning_tokens: 163,
        total_tokens: 201
      });
      expect(fixture.db.audit[1]).toMatchObject({
        response_id: "resp_compact_usage",
        input_tokens: 5,
        cached_input_tokens: 1,
        output_tokens: 7,
        reasoning_tokens: 2,
        total_tokens: 12
      });
      expect(fixture.db.audit[2]).toMatchObject({
        response_id: "resp_audit_secret",
        input_tokens: null,
        output_tokens: null,
        total_tokens: null
      });

      expect(fixture.db.audit[3]).toMatchObject({
        status: "ok",
        error_code: null
      });
      const auditJson = JSON.stringify(fixture.db.audit);
      expect(auditJson).not.toContain("audit-secret-prompt");
      expect(auditJson).not.toContain("audit-secret-output");
      expect(auditJson).not.toContain("response.completed");
    } finally {
      logSpy.mockRestore();
    }
  });

  it("splits usage_daily aggregates by execution plan and response model", async () => {
    const fixture = makeFixture();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      const user = await createUser(fixture, "model-stats@example.com");
      const key = await createKey(fixture, user.user.id, ["surface:codex:production"]);
      await importSharedAuth(fixture);

      const first = await handleRequest(new Request("https://api.trustedtunnel.app/v1/responses", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${key.api_key}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ model: "gpt-5.4", input: "with-usage" })
      }), fixture.env, fixture.ctx, fixture.deps);
      expect(first.status).toBe(200);
      await first.text();

      const second = await handleRequest(new Request("https://api.trustedtunnel.app/v1/responses/compact", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${key.api_key}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ model: "gpt-5.5", input: "compact-usage" })
      }), fixture.env, fixture.ctx, fixture.deps);
      expect(second.status).toBe(200);
      await second.json();

      const error = await handleRequest(new Request("https://api.trustedtunnel.app/v1/responses", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${key.api_key}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: "gpt-5.4-mini",
          input: "bad",
          stream_options: { include_usage: true }
        })
      }), fixture.env, fixture.ctx, fixture.deps);
      expect(error.status).toBe(200);
      await error.text();

      await fixture.ctx.flush();

      expect(fixture.db.usageDaily.get(`${user.user.id}:2026-06-24:codex.responses:gpt-5.4`)).toMatchObject({
        requests: 1,
        ok_requests: 1,
        error_requests: 0,
        input_tokens: 23,
        cached_input_tokens: 3,
        output_tokens: 178,
        reasoning_tokens: 163,
        total_tokens: 201
      });
      expect(fixture.db.usageDaily.get(`${user.user.id}:2026-06-24:codex.responses_compact:gpt-5.5`)).toMatchObject({
        requests: 1,
        ok_requests: 1,
        error_requests: 0,
        input_tokens: 5,
        cached_input_tokens: 1,
        output_tokens: 7,
        reasoning_tokens: 2,
        total_tokens: 12
      });
      expect(fixture.db.usageDaily.get(`${user.user.id}:2026-06-24:codex.responses:N/A`)).toMatchObject({
        requests: 1,
        ok_requests: 1,
        error_requests: 0,
        input_tokens: 0,
        output_tokens: 0,
        total_tokens: 0
      });
    } finally {
      logSpy.mockRestore();
    }
  });

  it("does not create request audit or usage facts when token lookup fails before upstream", async () => {
    const fixture = makeFixture();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      const user = await createUser(fixture, "token-failure@example.com");
      const key = await createKey(fixture, user.user.id, ["surface:codex:production"]);
      await importSharedAuth(fixture);
      await fixture.tokenAuthority.revoke();

      const response = await handleRequest(new Request("https://api.trustedtunnel.app/v1/responses", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${key.api_key}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ model: "gpt-5.4-mini", input: "token failure" })
      }), fixture.env, fixture.ctx, fixture.deps);
      // Slot authority fails closed with auth error (no dual D1 gate).
      expect(response.status).toBe(401);
      await fixture.ctx.flush();

      expect(fixture.db.audit).toHaveLength(0);
      expect(fixture.db.usageDaily.size).toBe(0);
      expect(logSpy).not.toHaveBeenCalled();
    } finally {
      logSpy.mockRestore();
    }
  });

  it("attributes one request and its tokens to the observed response model", async () => {
    const fixture = makeFixture();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      const user = await createUser(fixture, "response-model@example.com");
      const key = await createKey(fixture, user.user.id, ["surface:codex:production"]);
      await importSharedAuth(fixture);

      const response = await handleRequest(new Request("https://api.trustedtunnel.app/v1/responses", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${key.api_key}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ model: "request-model", input: "with-usage", stream: true })
      }), fixture.env, fixture.ctx, fixture.deps);
      expect(response.status).toBe(200);
      await response.text();
      await fixture.ctx.flush();

      expect(fixture.db.audit[0]).toMatchObject({
        response_model: "gpt-5.4",
        response_id: "resp_usage",
        total_tokens: 201
      });
      expect(fixture.db.usageDaily.get(`${user.user.id}:2026-06-24:codex.responses:gpt-5.4`)).toMatchObject({
        requests: 1,
        input_tokens: 23,
        output_tokens: 178,
        total_tokens: 201
      });
      expect(fixture.db.usageDaily.size).toBe(1);
    } finally {
      logSpy.mockRestore();
    }
  });

  it("merges different requested payload models into one response-model Usage row", async () => {
    const fixture = makeFixture();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      const user = await createUser(fixture, "response-model-only@example.com");
      const key = await createKey(fixture, user.user.id, ["surface:codex:production"]);
      await importSharedAuth(fixture);

      for (const requestedModel of ["alias-a", "alias-b"]) {
        const response = await handleRequest(new Request("https://api.trustedtunnel.app/v1/responses", {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${key.api_key}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({ model: requestedModel, input: "with-usage", stream: true })
        }), fixture.env, fixture.ctx, fixture.deps);
        expect(response.status).toBe(200);
        await response.text();
      }
      await fixture.ctx.flush();

      expect(fixture.db.usageDaily.size).toBe(1);
      expect(fixture.db.usageDaily.get(`${user.user.id}:2026-06-24:codex.responses:gpt-5.4`)).toMatchObject({
        response_model: "gpt-5.4",
        requests: 2,
        total_tokens: 402
      });
      expect(fixture.db.audit).toHaveLength(2);
      expect(fixture.db.audit.every((row) => !("requested_model" in row))).toBe(true);
    } finally {
      logSpy.mockRestore();
    }
  });

  it("records the received Codex redirect status while returning a stable rejection", async () => {
    const fixture = makeFixture();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      const user = await createUser(fixture, "codex-redirect@example.com");
      const key = await createKey(fixture, user.user.id, ["surface:codex:production"]);
      await importSharedAuth(fixture);
      const originalFetch = fixture.deps.fetch;
      fixture.deps.fetch = async (input, init) => {
        if (String(input).endsWith("/responses")) {
          if (init?.body !== undefined) {
            await new Response(init.body).arrayBuffer();
          }
          return Response.redirect("https://attacker.example/capture", 307);
        }
        return originalFetch(input, init);
      };

      const response = await handleRequest(new Request("https://api.trustedtunnel.app/v1/responses", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${key.api_key}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ model: "gpt-5.4", input: "redirect" })
      }), fixture.env, fixture.ctx, fixture.deps);

      expect(response.status).toBe(502);
      await expect(response.json()).resolves.toMatchObject({
        error: {
          code: "upstream_redirect_rejected",
          message: "Codex upstream redirect was rejected"
        }
      });
      await fixture.ctx.flush();

      expect(fixture.db.audit).toHaveLength(1);
      expect(fixture.db.audit[0]).toMatchObject({
        upstream_status: 307,
        error_code: "upstream_redirect_rejected"
      });
      expect(JSON.stringify(logSpy.mock.calls)).not.toContain("attacker.example");
      expect(logSpy).toHaveBeenCalledTimes(1);
      expect(JSON.parse(String(logSpy.mock.calls[0][0]))).toMatchObject({
        upstream_status: 307,
        error_code: "upstream_redirect_rejected"
      });
    } finally {
      logSpy.mockRestore();
    }
  });
});

function expectPublicCodexAuthShape(auth: unknown): void {
  expect(Object.keys(auth as Record<string, unknown>).sort()).toEqual([
    "admission_state",
    "created_at",
    "environment",
    "expires_at",
    "id",
    "kind",
    "label",
    "last_refresh_at",
    "status",
    "updated_at",
    "upstream_account_id",
    "upstream_email"
  ]);
}
