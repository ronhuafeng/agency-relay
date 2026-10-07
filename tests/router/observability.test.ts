import { beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "../../src/errors";
import type { ExecutionDependencies } from "../../src/types";
import egressProtocol from "../../deploy/codex-egress-shim/egress-protocol.json";

const mocks = vi.hoisted(() => ({
  commitProviderAttemptAccounting: vi.fn(async () => undefined),
  authenticateEndUser: vi.fn(async () => ({
    user: { id: "user_observation" },
    apiKey: { id: "key_observation" }
  })),
  getCodexAuth: vi.fn(async () => ({
    id: "shared_default",
    kind: "shared",
    status: "active"
  }))
}));

vi.mock("../../src/auth/bindings", () => ({
  getApiKeySurfaceCredential: vi.fn(async () => ({
    api_key_id: "key_observation",
    surface_grant: "surface:codex:production",
    codex_auth_id: "shared_default",
    subscription_account_id: null
  })),
  credentialAccountId: vi.fn(() => "shared_default")
}));

vi.mock("../../src/auth/authenticate", () => ({
  authenticateEndUser: mocks.authenticateEndUser
}));

vi.mock("../../src/db", () => ({
  commitProviderAttemptAccounting: mocks.commitProviderAttemptAccounting,
  cleanupRequestAudit: vi.fn(),
  createUser: vi.fn(),
  getCodexAuth: mocks.getCodexAuth,
  queryUsageSummary: vi.fn(),
  revokeApiKey: vi.fn()
}));

import { handleRequest } from "../../src/router";

describe("router transport observability", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("emits one metadata-only observed outcome without duplicating accounting", async () => {
    const prompt = "private-prompt-value";
    const output = "private-output-value";
    const apiKey = "private-api-key";
    const prohibitedValues = [
      "private-client-metadata",
      "private-bearer-token",
      "private-refresh-token",
      "private-id-token",
      "private-cookie",
      "private-forwarded-identity",
      "private-admin-secret",
      "private-egress-secret",
      "forged-client-transport-trace",
      "forged-backend-transport-trace"
    ];
    const chunks = [
      `event: response.created\ndata: {"type":"response.created"}\n\n`,
      `event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"${output}"}\n\n`,
      `event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_observation","model":"gpt-5.4","usage":{"input_tokens":2,"output_tokens":3,"total_tokens":5}}}\n\n`
    ];
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const waits: Promise<unknown>[] = [];
    let forwardedTraceId: string | null = null;
    const env = environment(async (_input, init) => {
      const forwardedHeaders = new Headers(init?.headers);
      forwardedTraceId = forwardedHeaders.get("x-mini-transport-trace-id");
      expect(forwardedHeaders.get("x-mini-header-manifest")).not.toContain("x-mini-transport-trace-id");
      return new Response(new ReadableStream({
        start(controller) {
          for (const chunk of chunks) {
            controller.enqueue(new TextEncoder().encode(chunk));
          }
          controller.close();
        }
      }), {
        status: 200,
        headers: {
          "Content-Type": "text/event-stream",
          "X-Mini-Transport-Trace-Id": prohibitedValues[9]
        }
      });
    }, prohibitedValues);

    try {
      const response = await handleRequest(new Request("https://api.trustedtunnel.app/v1/responses", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          Cookie: prohibitedValues[4],
          Forwarded: `for=${prohibitedValues[5]}`,
          "X-Test-Bearer": prohibitedValues[1],
          "X-Test-Refresh": prohibitedValues[2],
          "X-Test-Id-Token": prohibitedValues[3],
          "X-Client-Request-Id": "caller-controlled-request-id",
          "X-Mini-Transport-Trace-Id": prohibitedValues[8]
        },
        body: JSON.stringify({
          model: "gpt-5.4",
          input: prompt,
          stream: true,
          client_metadata: {
            "x-codex-turn-metadata": JSON.stringify({
              user_id: "attacker-user",
              key_id: "attacker-key",
              private: prohibitedValues[0]
            })
          }
        })
      }), env, { waitUntil: (promise) => waits.push(promise) }, dependencies(env));

      expect(response.status).toBe(200);
      expect(response.headers.get("X-Mini-Transport-Trace-Id")).toBeNull();
      expect(mocks.commitProviderAttemptAccounting).not.toHaveBeenCalled();
      await expect(response.text()).resolves.toBe(chunks.join(""));
      await flushWaits(waits);

      expect(mocks.commitProviderAttemptAccounting).toHaveBeenCalledTimes(1);
      expect(logSpy).toHaveBeenCalledTimes(1);
      const outcome = JSON.parse(String(logSpy.mock.calls[0][0])) as Record<string, unknown>;
      expect(outcome).toMatchObject({
        event: "worker_request_outcome",
        schema_version: 1,
        request_id: "caller-controlled-request-id",
        user_id: "user_observation",
        key_id: "key_observation",
        route: "/v1/responses",
        codex_auth_id: "shared_default",
        upstream_status: 200,
        terminal_event: "response.completed",
        usage_captured: true,
        stream_chunks: 3,
        client_aborted: false,
        transport: "http_sse",
        observation_status: "ok",
        observation_error_code: null,
        observation_stage: "response_body"
      });
      expect(forwardedTraceId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      expect(forwardedTraceId).not.toBe(prohibitedValues[8]);
      expect(outcome.transport_trace_id).toBe(forwardedTraceId);
      expect(Object.keys(outcome).sort()).toEqual([...egressProtocol.transportTrace.eventFields.workerOutcome].sort());
      const rendered = JSON.stringify(outcome);
      expect(rendered).not.toContain(prompt);
      expect(rendered).not.toContain(output);
      expect(rendered).not.toContain(apiKey);
      for (const prohibited of prohibitedValues) {
        expect(rendered).not.toContain(prohibited);
      }
      expect(mocks.getCodexAuth).toHaveBeenCalledWith(env, "shared_default");
    } finally {
      logSpy.mockRestore();
    }
  });

  it("includes the actual upstream status in the single error outcome", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const waits: Promise<unknown>[] = [];
    const env = environment(async () => new Response(JSON.stringify({
      error: { message: "unavailable", type: "upstream_error", code: "unavailable" }
    }), { status: 503, headers: { "Content-Type": "application/json" } }));
    try {
      const response = await handleRequest(new Request("https://api.trustedtunnel.app/v1/responses", {
        method: "POST",
        headers: { Authorization: "Bearer local-key", "Content-Type": "application/json" },
        body: JSON.stringify({ model: "gpt-5.4", input: "hello", stream: true })
      }), env, { waitUntil: (promise) => waits.push(promise) }, dependencies(env));
      await response.text();
      await flushWaits(waits);

      expect(response.status).toBe(503);
      expect(mocks.commitProviderAttemptAccounting).toHaveBeenCalledTimes(1);
      expect(logSpy).toHaveBeenCalledTimes(1);
      expect(JSON.parse(String(logSpy.mock.calls[0][0]))).toMatchObject({
        status: "error",
        upstream_status: 503,
        error_code: null,
        transport: "http_json",
        observation_status: "ok",
        observation_error_code: null,
        observation_stage: "response_body",
        terminal_event: "error",
        usage_captured: false
      });
    } finally {
      logSpy.mockRestore();
    }
  });

  it("records Provider Attempt accounting failure once without changing the client response", async () => {
    const privateError = "private-database-error-detail";
    mocks.commitProviderAttemptAccounting.mockRejectedValueOnce(new Error(privateError));
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const waits: Promise<unknown>[] = [];
    const body = "event: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_accounting\",\"model\":\"gpt-5.4\",\"usage\":{\"input_tokens\":2,\"output_tokens\":3,\"total_tokens\":5}}}\n\n";
    const env = environment(async () => new Response(body, {
      headers: { "Content-Type": "text/event-stream" }
    }));
    try {
      const response = await handleRequest(new Request("https://api.trustedtunnel.app/v1/responses", {
        method: "POST",
        headers: { Authorization: "Bearer local-key", "Content-Type": "application/json" },
        body: JSON.stringify({ model: "gpt-5.4", input: "hello", stream: true })
      }), env, { waitUntil: (promise) => waits.push(promise) }, dependencies(env));

      await expect(response.text()).resolves.toBe(body);
      await flushWaits(waits);
      expect(mocks.commitProviderAttemptAccounting).toHaveBeenCalledTimes(1);
      expect(logSpy).toHaveBeenCalledTimes(1);
      expect(errorSpy).toHaveBeenCalledTimes(1);
      const outcome = JSON.parse(String(logSpy.mock.calls[0][0])) as Record<string, unknown>;
      expect(outcome).toMatchObject({
        observation_status: "error",
        observation_error_code: "request_accounting_failed",
        observation_stage: "request_accounting",
        usage_captured: true,
        terminal_event: "response.completed"
      });
      expect(JSON.stringify(outcome)).not.toContain(privateError);
      expect(JSON.stringify(errorSpy.mock.calls)).not.toContain(privateError);
    } finally {
      logSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });

  it("authenticates Responses WebSocket upgrades before returning typed 426 without upstream work", async () => {
    const fetchMock = vi.fn();
    const env = environment(fetchMock);
    const ctx = { waitUntil: vi.fn() };
    const response = await handleRequest(new Request("https://api.trustedtunnel.app/v1/responses", {
      method: "GET",
      headers: { Authorization: "Bearer local-key", Upgrade: "websocket", Connection: "Upgrade" }
    }), env, ctx, dependencies(env));

    expect(response.status).toBe(426);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "responses_websocket_not_supported" }
    });
    expect(response.headers.get("Upgrade")).toBe("websocket");
    expect(mocks.authenticateEndUser).toHaveBeenCalledWith(expect.any(Request), env, ctx, {
      requiredSurfaceGrant: "surface:codex:production"
    }, expect.any(Date));
    expect(mocks.getCodexAuth).not.toHaveBeenCalled();
    expect(mocks.commitProviderAttemptAccounting).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not disclose WebSocket transport support before authentication", async () => {
    mocks.authenticateEndUser.mockRejectedValueOnce(new HttpError(401, "Invalid API key", "authentication_error", "invalid_api_key"));
    const fetchMock = vi.fn();
    const env = environment(fetchMock);
    const response = await handleRequest(new Request("https://api.trustedtunnel.app/v1/responses", {
      method: "GET",
      headers: { Authorization: "Bearer invalid", Upgrade: "websocket" }
    }), env, { waitUntil: vi.fn() }, dependencies(env));

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "invalid_api_key" } });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps an ordinary Responses GET as not found", async () => {
    const env = environment(vi.fn());
    const response = await handleRequest(
      new Request("https://api.trustedtunnel.app/v1/responses", { method: "GET" }),
      env,
      { waitUntil: vi.fn() },
      dependencies(env)
    );
    expect([404, 405]).toContain(response.status);
  });
});

async function flushWaits(waits: Promise<unknown>[]): Promise<void> {
  let completed = 0;
  while (completed < waits.length) {
    const pending = waits.slice(completed);
    completed = waits.length;
    await Promise.all(pending);
  }
}

function environment(fetchImpl: typeof fetch, prohibitedValues: string[] = []): Env {
  return {
    DB: {
      prepare: (sql: string) => ({
        sql,
        bind() { return this; },
        async first() {
          if (sql.includes("upstream_identity_version")) return { version: "1.2.3" };
          if (sql.includes("monthly_allowance")) return { monthly_allowance: 1000000 };
          return null;
        }
      }),
      async batch(statements: Array<{ sql?: string }>) {
        if (statements.some((statement) => statement.sql?.includes("user_surface_credit_usage"))) {
          return [{ success: true, results: [], meta: { changes: 1 } }];
        }
        return [
          { success: true, results: [], meta: { changes: 0 } },
          { success: true, results: [], meta: { changes: 0 } }
        ];
      }
    } as unknown as D1Database,
    TOKEN_AUTHORITY: {
      idFromName: () => ({}) as DurableObjectId,
      get: () => ({
        getFreshAccessToken: async () => ({
          ok: true as const,
          value: {
            access_token: prohibitedValues[1] ?? "upstream-secret",
            account_id: "account"
          }
        })
      })
    } as unknown as Env["TOKEN_AUTHORITY"],
    TOKEN_ENCRYPTION_KEY_V1: "encryption-secret",
    API_KEY_HASH_PEPPER: "pepper-secret",
    ADMIN_SECRET: prohibitedValues[6] ?? "admin-secret",
    CODEX_EGRESS_BASE_URL: "https://codex-egress-us-west1-a.trustedtunnel.app",
    CODEX_EGRESS_SECRET: prohibitedValues[7] ?? "egress-secret",
    CODEX_OAUTH_TOKEN_URL: "https://auth.example.test",
    CODEX_CLIENT_ID: "client",
    REQUEST_AUDIT_RETENTION_DAYS: "30",
    _fetch: fetchImpl
  } as unknown as Env & { _fetch: typeof fetch };
}

function dependencies(env: Env): ExecutionDependencies {
  return {
    fetch: (env as Env & { _fetch: typeof fetch })._fetch,
    now: () => new Date("2026-07-12T00:00:00.000Z")
  };
}
