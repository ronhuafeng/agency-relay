import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { decryptJson, encryptJson } from "../../src/crypto";
import { SHARED_CODEX_AUTH_ID } from "../../src/db";
import { TokenAuthority } from "../../src/auth/token-authority";
import { readTokenResult, type TokenResult } from "../../src/auth/token-result";
import type { SubscriptionCredential } from "../../src/auth/subscription-accounts";
import type { TokenCiphertext } from "../../src/types";
import { createTestD1, type TestD1 } from "../support/sqlite-d1";

describe("TokenAuthority", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("marks reauth_required when shared token is expired without refresh material", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-24T12:00:00.000Z"));
    const fixture = makeTokenAuthorityFixture();
    await fixture.authority.saveToken({
      auth_id: SHARED_CODEX_AUTH_ID,
      access_token: "stale_access",
      expires_at: "2026-06-24T00:00:00.000Z",
      status: "active"
    });

    await expect(fixture.authority.getFreshAccessToken()).rejects.toMatchObject({
      code: "reauth_required"
    });
    await expect(fixture.authority.getFreshAccessToken()).rejects.toMatchObject({
      code: "reauth_required"
    });
  });

  it("returns an unexpired shared access token without refresh", async () => {
    const fixture = makeTokenAuthorityFixture();
    await fixture.authority.saveToken({
      auth_id: SHARED_CODEX_AUTH_ID,
      access_token: "current_access",
      refresh_token: "refresh",
      expires_at: "2099-06-24T01:00:00.000Z",
      status: "active"
    });

    await expect(fixture.authority.getFreshAccessToken()).resolves.toMatchObject({
      access_token: "current_access"
    });
    expect(fixture.fetchMock).not.toHaveBeenCalled();
    expect(fixture.storage.alarmAt).toBeTypeOf("number");
  });

  it("refreshes a shared token once for concurrent callers", async () => {
    const fixture = makeTokenAuthorityFixture({
      tokenResponse: {
        access_token: "new_access",
        refresh_token: "new_refresh",
        expires_in: 3600
      }
    });
    await fixture.authority.saveToken({
      auth_id: SHARED_CODEX_AUTH_ID,
      access_token: "old_access",
      refresh_token: "old_refresh",
      expires_at: "2026-06-24T00:00:30.000Z",
      status: "active"
    });

    const results = await Promise.all([
      fixture.authority.getFreshAccessToken(),
      fixture.authority.getFreshAccessToken(),
      fixture.authority.getFreshAccessToken()
    ]);

    expect(results.map((result) => (result as unknown as { access_token: string }).access_token)).toEqual(["new_access", "new_access", "new_access"]);
    expect(fixture.fetchMock).toHaveBeenCalledTimes(1);
    expect(fixture.db.lastRefresh?.status).toBe("active");
  });

  it("force refreshes an unexpired token without returning raw token values", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-24T00:00:00.000Z"));
    const fixture = makeTokenAuthorityFixture({
      tokenResponse: {
        access_token: "forced_access",
        refresh_token: "forced_refresh",
        id_token: makeJwt({
          email: "admin@example.com",
          "https://api.openai.com/auth": {
            chatgpt_account_id: "acct_forced"
          }
        }),
        expires_in: 7200
      }
    });
    await fixture.authority.saveToken({
      auth_id: SHARED_CODEX_AUTH_ID,
      access_token: "current_access",
      refresh_token: "current_refresh",
      expires_at: "2099-06-24T01:00:00.000Z",
      status: "active"
    });

    const result = await fixture.authority.refreshNow();

    expect(fixture.fetchMock).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      auth_id: SHARED_CODEX_AUTH_ID,
      refresh_available: true
    });
    expect(JSON.stringify(result)).not.toContain("forced_access");
    expect(JSON.stringify(result)).not.toContain("forced_refresh");
    expect(fixture.db.lastRefresh).toMatchObject({
      account_id: "acct_forced",
      email: "admin@example.com",
      status: "active",
      expires_at: "2026-06-24T02:00:00.000Z",
      last_refresh_at: "2026-06-24T00:00:00.000Z"
    });
  });

  it("rejects force refresh when no refresh token is stored", async () => {
    const fixture = makeTokenAuthorityFixture();
    await fixture.authority.saveToken({
      auth_id: SHARED_CODEX_AUTH_ID,
      access_token: "current_access",
      expires_at: "2099-06-24T01:00:00.000Z",
      status: "active"
    });

    await expect(fixture.authority.refreshNow()).rejects.toMatchObject({
      code: "missing_refresh_token"
    });
    expect(fixture.fetchMock).not.toHaveBeenCalled();
  });

  it("uses alarm refresh and reschedules the next alarm", async () => {
    const fixture = makeTokenAuthorityFixture({
      tokenResponse: {
        access_token: "alarm_access",
        refresh_token: "alarm_refresh",
        expires_in: 3600
      }
    });
    await fixture.authority.saveToken({
      auth_id: SHARED_CODEX_AUTH_ID,
      access_token: "old_access",
      refresh_token: "old_refresh",
      expires_at: "2026-06-24T00:00:30.000Z",
      status: "active"
    });

    await fixture.authority.alarm();

    expect(fixture.fetchMock).toHaveBeenCalledTimes(1);
    await expect(fixture.authority.getFreshAccessToken()).resolves.toMatchObject({
      access_token: "alarm_access"
    });
    expect(fixture.fetchMock).toHaveBeenCalledTimes(1);
    expect(fixture.storage.alarmAt).toBeGreaterThan(Date.parse("2026-06-24T00:40:00.000Z"));
  });

  it("rejects a successful refresh response without a new access token", async () => {
    const fixture = makeTokenAuthorityFixture({
      tokenResponse: {
        refresh_token: "new_refresh",
        expires_in: 3600
      }
    });
    await fixture.authority.saveToken({
      auth_id: SHARED_CODEX_AUTH_ID,
      access_token: "old_access",
      refresh_token: "old_refresh",
      expires_at: "2026-06-24T00:00:30.000Z",
      status: "active"
    });

    await expect(fixture.authority.getFreshAccessToken()).rejects.toMatchObject({
      code: "missing_access_token"
    });
  });

  it("fails closed for persisted tokens without a current status", async () => {
    const fixture = makeTokenAuthorityFixture();
    for (const status of [undefined, "unknown"]) {
      await fixture.storage.put("token", await encryptJson("secret", {
        auth_id: SHARED_CODEX_AUTH_ID,
        access_token: "stored_access",
        ...(status === undefined ? {} : { status })
      }));

      await expect(fixture.authority.getFreshAccessToken()).rejects.toMatchObject({
        code: "codex_auth_inactive"
      });
    }
  });

  it("marks reauth_required on invalid_grant and blocks later callers", async () => {
    const fixture = makeTokenAuthorityFixture({
      refreshStatus: 400,
      refreshBody: { error: "invalid_grant" }
    });
    await fixture.authority.saveToken({
      auth_id: SHARED_CODEX_AUTH_ID,
      access_token: "old_access",
      refresh_token: "old_refresh",
      expires_at: "2026-06-24T00:00:30.000Z",
      status: "active"
    });

    await expect(fixture.authority.getFreshAccessToken()).rejects.toMatchObject({
      code: "reauth_required"
    });
    expect(fixture.db.status).toBe("reauth_required");
    expect(fixture.storage.alarmAt).toBeUndefined();

    await expect(fixture.authority.getFreshAccessToken()).rejects.toMatchObject({
      code: "reauth_required"
    });
    expect(fixture.fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    [400, { error: "refresh_token_expired" }],
    [400, { error: "refresh_token_invalidated" }],
    [400, { error: { code: "refresh_token_reused" } }],
    [400, { error: { code: "refresh_token_expired" } }],
    [400, { error: { code: "refresh_token_invalidated" } }],
    [400, { error: { code: "invalid_grant" } }],
    [401, { error: "unknown_auth_rejection" }]
  ])("persists reconnect status for a terminal OAuth response (%s, %j)", async (refreshStatus, refreshBody) => {
    const fixture = makeTokenAuthorityFixture({ refreshStatus, refreshBody });
    expect((await fixture.raw.saveToken(expiredCodexToken())).ok).toBe(true);
    await expect(fixture.authority.refreshNow()).rejects.toMatchObject({ code: "reauth_required" });
    expect(fixture.db.status).toBe("reauth_required");
    expect(fixture.storage.alarmAt).toBeUndefined();
    await expect(fixture.authority.getFreshAccessToken()).rejects.toMatchObject({ code: "reauth_required" });
    expect(fixture.fetchMock).toHaveBeenCalledTimes(1);
  });

  it("notifies only after reconnect status is stored, without changing the token failure", async () => {
    const observed: string[] = [];
    const fixture = makeTokenAuthorityFixture({
      refreshStatus: 401, refreshBody: { error: "refresh_token_invalidated" },
      notify: async () => { observed.push(fixture.db.status ?? "missing"); }
    });
    await fixture.authority.saveToken(expiredCodexToken());
    await expect(fixture.authority.refreshNow()).rejects.toMatchObject({ code: "reauth_required" });
    await Promise.all(fixture.notifications);
    expect(observed).toEqual(["active", "reauth_required"]);
    expect(fixture.db.status).toBe("reauth_required");
  });

  it("does not wait for notification delivery before completing a credential refresh", async () => {
    let release!: () => void;
    const delivered = new Promise<void>(done => { release = done; });
    const fixture = makeTokenAuthorityFixture({ notify: () => delivered });
    try {
      await fixture.authority.saveToken(expiredCodexToken());
      await expect(fixture.authority.refreshNow()).resolves.toMatchObject({ refresh_available: true });
      expect(fixture.db.status).toBe("active");
      expect(fixture.notifications).toHaveLength(2);
    } finally { release(); await Promise.all(fixture.notifications); }
  });

  it("marks reauth_required when SubscriptionCredential is expired without refresh", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-24T12:00:00.000Z"));
    const fixture = makeTokenAuthorityFixture();
    fixture.db.replaceSubscriptionAccount("sub_expired");
    await fixture.authority.saveSubscriptionCredential({
      account_id: "sub_expired",
      capability_source: "grok",
      access_token: "stale_sub_access",
      expires_at: "2026-06-24T00:00:00.000Z",
      status: "active"
    });

    // Local fail before any provider refresh fetch.
    await expect(fixture.authority.getFreshSubscriptionCredential()).rejects.toMatchObject({
      code: "reauth_required"
    });
    expect(fixture.fetchMock).not.toHaveBeenCalled();
    // Subsequent callers stay fail-closed.
    await expect(fixture.authority.getFreshSubscriptionCredential()).rejects.toMatchObject({
      code: "reauth_required"
    });
  });

  it("silently refreshes Grok once for concurrent callers and commits rotation", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-26T00:00:00.000Z"));
    const fixture = makeTokenAuthorityFixture({
      fetch: async (input, init) => {
        if (String(input).endsWith("/.well-known/openid-configuration")) {
          return Response.json({ token_endpoint: "https://auth.x.ai/oauth/token" });
        }
        expect(new URLSearchParams(String(init?.body)).get("refresh_token")).toBe("old-grok-refresh");
        return Response.json({
          access_token: "new-grok-access",
          refresh_token: "new-grok-refresh",
          expires_in: 3600
        });
      }
    });
    await fixture.authority.saveSubscriptionCredential(grokCredential());

    const results = await Promise.all([
      fixture.authority.getFreshSubscriptionCredential(),
      fixture.authority.getFreshSubscriptionCredential(),
      fixture.authority.getFreshSubscriptionCredential()
    ]);

    expect(results.map((result) => (result as unknown as { access_token: string }).access_token)).toEqual([
      "new-grok-access",
      "new-grok-access",
      "new-grok-access"
    ]);
    expect(fixture.fetchMock).toHaveBeenCalledTimes(2);
    const encrypted = await fixture.storage.get<TokenCiphertext>("subscription_credential");
    const stored = await decryptJson<SubscriptionCredential>("secret", encrypted!);
    expect(stored).toMatchObject({
      access_token: "new-grok-access",
      refresh_token: "new-grok-refresh",
      expires_at: "2026-07-26T01:00:00.000Z",
      status: "active"
    });
    expect(fixture.db.subscriptionAccounts.get("sub_grok")).toMatchObject({
      status: "active",
      last_refresh_at: "2026-07-26T00:00:00.000Z"
    });
  });

  it.each(["invalid_grant", "invalid_client"])(
    "marks Grok reauth_required on terminal %s and blocks later callers",
    async (oauthError) => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-07-26T00:00:00.000Z"));
      const fixture = makeTokenAuthorityFixture({
        fetch: async (input) => {
          if (String(input).endsWith("/.well-known/openid-configuration")) {
            return Response.json({ token_endpoint: "https://auth.x.ai/oauth/token" });
          }
          return Response.json({ error: oauthError }, { status: 400 });
        }
      });
      await fixture.authority.saveSubscriptionCredential(grokCredential());

      await expect(fixture.authority.getFreshSubscriptionCredential()).rejects.toMatchObject({
        code: "reauth_required"
      });
      expect(fixture.db.subscriptionStatus).toBe("reauth_required");
      expect(fixture.storage.alarmAt).toBeUndefined();

      await expect(fixture.authority.getFreshSubscriptionCredential()).rejects.toMatchObject({
        code: "reauth_required"
      });
      expect(fixture.fetchMock).toHaveBeenCalledTimes(2);
    }
  );

  it("leaves Grok active and retryable after a transient refresh failure", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-26T00:00:00.000Z"));
    const fixture = makeTokenAuthorityFixture({
      fetch: async (input) => {
        if (String(input).endsWith("/.well-known/openid-configuration")) {
          return Response.json({ token_endpoint: "https://auth.x.ai/oauth/token" });
        }
        return Response.json({ error: "temporarily_unavailable" }, { status: 503 });
      }
    });
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await fixture.authority.saveSubscriptionCredential(grokCredential());

    await expect(fixture.authority.getFreshSubscriptionCredential()).rejects.toMatchObject({
      code: "grok_token_refresh_failed"
    });
    expect(fixture.db.subscriptionStatus).toBe("active");
    expect(fixture.storage.alarmAt).toBeTypeOf("number");
    expect(log).toHaveBeenCalledWith(JSON.stringify({
      event: "subscription_refresh_failed",
      account_id: "sub_grok",
      failure_code: "grok_token_refresh_failed",
      permanent: false
    }));

    await expect(fixture.authority.getFreshSubscriptionCredential()).rejects.toMatchObject({
      code: "grok_token_refresh_failed"
    });
    expect(fixture.fetchMock).toHaveBeenCalledTimes(4);
  });

  it("requires one reimport for legacy Grok credentials missing OIDC metadata", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-26T00:00:00.000Z"));
    const fixture = makeTokenAuthorityFixture();
    await fixture.authority.saveSubscriptionCredential({
      ...grokCredential(),
      oidc_issuer: undefined,
      oidc_client_id: undefined
    });

    await expect(fixture.authority.getFreshSubscriptionCredential()).rejects.toMatchObject({
      code: "reauth_required"
    });
    expect(fixture.fetchMock).not.toHaveBeenCalled();
    expect(fixture.db.subscriptionStatus).toBe("reauth_required");
  });

  it("returns a plain refresh failure without provider response text", async () => {
    const marker = "provider-body-marker";
    const fixture = makeTokenAuthorityFixture({
      refreshStatus: 502,
      refreshBody: { error: "server_error", error_description: marker }
    });
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect((await fixture.raw.saveToken(expiredCodexToken())).ok).toBe(true);
    const result = structuredClone(await fixture.raw.refreshNow());
    expect(result).toEqual({
      ok: false,
      error: { source: "provider", status: 502, code: "codex_token_refresh_failed" }
    });
    expect(JSON.stringify(result)).not.toContain(marker);
    expect(log.mock.calls.flat().join(" ")).not.toContain(marker);
    expect(result).not.toBeInstanceOf(Error);
    expect(fixture.db.status).toBe("active");
    expect(fixture.storage.alarmAt).toBeTypeOf("number");
  });

  it("does not let an older refresh restore a revoked credential or its alarm", async () => {
    const fixture = makeTokenAuthorityFixture();
    const gate = holdFetch(fixture);
    await fixture.authority.saveToken(expiredCodexToken());

    const refresh = fixture.authority.refreshNow();
    await gate.entered;
    await fixture.authority.revoke();
    gate.release();

    await expect(refresh).rejects.toMatchObject({ code: "credential_lifecycle_changed" });
    await expect(storedCodex(fixture)).resolves.toMatchObject({ status: "revoked", access_token: "old_access" });
    expect(fixture.storage.alarmAt).toBeUndefined();
    expect(fixture.db.status).toBe("active");
    expect(fixture.db.lastRefresh?.expires_at).toBe("2026-06-24T00:00:00.000Z");
  });

  it("does not let an older refresh restore a D1 revocation when cleanup did not run", async () => {
    const fixture = makeTokenAuthorityFixture();
    const gate = holdFetch(fixture);
    await fixture.authority.saveToken(expiredCodexToken());

    const refresh = fixture.authority.refreshNow();
    await gate.entered;
    fixture.db.setCodexStatus("revoked");
    gate.release();

    await expect(refresh).rejects.toMatchObject({ code: "credential_lifecycle_changed" });
    expect(fixture.db.status).toBe("revoked");
    await expect(storedCodex(fixture)).resolves.toMatchObject({ status: "active", access_token: "old_access" });
  });

  it("does not let an older refresh overwrite a newer saved credential", async () => {
    const fixture = makeTokenAuthorityFixture();
    const gate = holdFetch(fixture);
    await fixture.authority.saveToken(expiredCodexToken());
    const refresh = fixture.authority.refreshNow();
    await gate.entered;
    await fixture.authority.saveToken({
      auth_id: SHARED_CODEX_AUTH_ID,
      access_token: "saved_access",
      refresh_token: "saved_refresh",
      expires_at: "2099-01-01T00:00:00.000Z",
      status: "active"
    });
    gate.release();

    await expect(refresh).rejects.toMatchObject({ code: "credential_lifecycle_changed" });
    await expect(fixture.authority.getFreshAccessToken()).resolves.toMatchObject({ access_token: "saved_access" });
    expect(fixture.fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not let an older permanent failure mark a newer credential reauth_required", async () => {
    const fixture = makeTokenAuthorityFixture();
    const gate = holdFetch(fixture, () => Response.json({ error: "invalid_grant" }, { status: 400 }));
    await fixture.authority.saveToken(expiredCodexToken());
    const refresh = fixture.authority.refreshNow();
    await gate.entered;
    await fixture.authority.saveToken({
      auth_id: SHARED_CODEX_AUTH_ID,
      access_token: "saved_access",
      refresh_token: "saved_refresh",
      expires_at: "2099-01-01T00:00:00.000Z",
      status: "active"
    });
    gate.release();

    await expect(refresh).rejects.toMatchObject({ code: "credential_lifecycle_changed" });
    expect(fixture.db.status).toBe("active");
    await expect(storedCodex(fixture)).resolves.toMatchObject({ status: "active", access_token: "saved_access" });
  });

  it("does not join a new credential to an older in-flight refresh", async () => {
    let releaseFirst: (() => void) | undefined;
    let releaseSecond: (() => void) | undefined;
    let enteredFirst: (() => void) | undefined;
    let enteredSecond: (() => void) | undefined;
    const firstEntered = new Promise<void>((resolve) => { enteredFirst = resolve; });
    const secondEntered = new Promise<void>((resolve) => { enteredSecond = resolve; });
    const fixture = makeTokenAuthorityFixture({
      fetch: async () => {
        if (!releaseFirst) {
          enteredFirst?.();
          await new Promise<void>((resolve) => { releaseFirst = resolve; });
          return Response.json({ access_token: "stale_access", refresh_token: "stale_refresh", expires_in: 3600 });
        }
        enteredSecond?.();
        await new Promise<void>((resolve) => { releaseSecond = resolve; });
        return Response.json({ access_token: "fresh_access", refresh_token: "fresh_refresh", expires_in: 3600 });
      }
    });
    await fixture.authority.saveToken(expiredCodexToken());
    const first = fixture.authority.refreshNow();
    await firstEntered;
    await fixture.authority.saveToken(expiredCodexToken("replacement_access", "replacement_refresh"));
    const second = fixture.authority.getFreshAccessToken();
    await secondEntered;
    releaseFirst?.();
    await expect(first).rejects.toMatchObject({ code: "credential_lifecycle_changed" });
    releaseSecond?.();
    await expect(second).resolves.toMatchObject({ access_token: "fresh_access" });
    await expect(storedCodex(fixture)).resolves.toMatchObject({ access_token: "fresh_access" });
  });

  it("does not let an older subscription refresh recreate a cleared credential", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-26T00:00:00.000Z"));
    let release: (() => void) | undefined;
    let entered: (() => void) | undefined;
    const enteredPromise = new Promise<void>((resolve) => { entered = resolve; });
    const fixture = makeTokenAuthorityFixture({
      fetch: async (input) => {
        if (String(input).endsWith("/.well-known/openid-configuration")) {
          return Response.json({ token_endpoint: "https://auth.x.ai/oauth/token" });
        }
        entered?.();
        await new Promise<void>((resolve) => { release = resolve; });
        return Response.json({ access_token: "stale-grok", refresh_token: "stale-refresh", expires_in: 3600 });
      }
    });
    await fixture.authority.saveSubscriptionCredential(grokCredential());
    const refresh = fixture.authority.refreshSubscriptionNow();
    await enteredPromise;
    await fixture.authority.clearSubscriptionStorage();
    release?.();

    await expect(refresh).rejects.toMatchObject({ code: "credential_lifecycle_changed" });
    expect(await fixture.storage.get("subscription_credential")).toBeUndefined();
    expect(fixture.db.subscriptionStatus).toBe("active");
  });
});

interface TokenAuthorityFixture {
  authority: TokenAuthority;
  raw: TokenAuthority;
  storage: FakeStorage;
  db: TokenAuthorityDatabase;
  fetchMock: ReturnType<typeof vi.fn>;
  notifications: Promise<unknown>[];
}

function makeTokenAuthorityFixture(options: {
  tokenResponse?: Record<string, unknown>;
  refreshStatus?: number;
  refreshBody?: Record<string, unknown>;
  fetch?: typeof fetch;
  notify?: () => Promise<void>;
} = {}): TokenAuthorityFixture {
  const storage = new FakeStorage();
  const db = new TokenAuthorityDatabase();
  onTestFinished(() => db.close());
  const fetchMock = vi.fn(options.fetch ?? (async (_input: RequestInfo | URL, init?: RequestInit) => {
    expect(String(init?.body)).toContain("grant_type=refresh_token");
    return new Response(JSON.stringify(options.refreshBody ?? options.tokenResponse ?? {
      access_token: "refreshed_access",
      refresh_token: "refreshed_refresh",
      expires_in: 3600
    }), {
      status: options.refreshStatus ?? 200,
      headers: { "Content-Type": "application/json" }
    });
  }));
  const env: Env = {
    CODEX_EGRESS_BASE_URL: "",
    CODEX_EGRESS_SECRET: "",
    CODEX_OAUTH_TOKEN_URL: "https://auth.openai.test/oauth/token",
    CODEX_CLIENT_ID: "client",
    TOKEN_ENCRYPTION_KEY_V1: "secret",
    API_KEY_HASH_PEPPER: "pepper",
    ADMIN_SECRET: "admin-secret",
    ADMIN_DASHBOARD_HOST: "admin.example.test",
    CONSOLE_EMAIL_DOMAIN: "example.com",
    FEISHU_APP_ID: "cli_test",
    FEISHU_APP_SECRET: "test-secret",
    REQUEST_AUDIT_RETENTION_DAYS: "30",
    CREDENTIAL_EVENTS: (options.notify ? { idFromName: (name: string) => name, get: () => ({ publish: options.notify }) } : undefined) as unknown as Env["CREDENTIAL_EVENTS"],
    DB: db.binding,
    TOKEN_AUTHORITY: undefined as unknown as Env["TOKEN_AUTHORITY"]
  };

  vi.stubGlobal("fetch", fetchMock);
  const notifications: Promise<unknown>[] = [];
  const raw = new TokenAuthority({
    storage, waitUntil: (promise: Promise<unknown>) => { notifications.push(promise); }
  } as unknown as DurableObjectState, env);
  return { authority: throwingAuthority(raw), raw, storage, db, fetchMock, notifications };
}

function throwingAuthority(raw: TokenAuthority): TokenAuthority {
  return new Proxy(raw, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== "function") return value;
      return async (...args: unknown[]) => {
        const result: unknown = await (value as (...inner: unknown[]) => Promise<unknown>).apply(target, args);
        if (result && typeof result === "object" && "ok" in result) {
          return readTokenResult(result as TokenResult<unknown>);
        }
        return result;
      };
    }
  }) as TokenAuthority;
}

function expiredCodexToken(access = "old_access", refresh = "old_refresh") {
  return {
    auth_id: SHARED_CODEX_AUTH_ID,
    access_token: access,
    refresh_token: refresh,
    expires_at: "2026-06-24T00:00:00.000Z",
    status: "active" as const
  };
}

function holdFetch(
  fixture: TokenAuthorityFixture,
  response: () => Response = () => Response.json({
    access_token: "refreshed_access",
    refresh_token: "refreshed_refresh",
    expires_in: 3600
  })
): { entered: Promise<void>; release: () => void } {
  let releaseFetch: (() => void) | undefined;
  let markEntered: (() => void) | undefined;
  const entered = new Promise<void>((resolve) => { markEntered = resolve; });
  fixture.fetchMock.mockImplementation(async () => {
    markEntered?.();
    await new Promise<void>((resolve) => { releaseFetch = resolve; });
    return response();
  });
  return { entered, release: () => releaseFetch?.() };
}

async function storedCodex(fixture: TokenAuthorityFixture): Promise<{ access_token?: string; status?: string }> {
  const encrypted = await fixture.storage.get<TokenCiphertext>("token");
  return decryptJson("secret", encrypted!);
}

function grokCredential(): SubscriptionCredential {
  return {
    account_id: "sub_grok",
    capability_source: "grok",
    access_token: "old-grok-access",
    refresh_token: "old-grok-refresh",
    oidc_issuer: "https://auth.x.ai",
    oidc_client_id: "grok-client",
    expires_at: "2026-07-26T00:05:00.000Z",
    status: "active"
  };
}

function makeJwt(payload: Record<string, unknown>): string {
  return [
    base64UrlJson({ alg: "none", typ: "JWT" }),
    base64UrlJson(payload),
    ""
  ].join(".");
}

function base64UrlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

class FakeStorage {
  private readonly values = new Map<string, unknown>();
  alarmAt?: number;

  async get<T>(key: string): Promise<T | undefined> {
    return this.values.get(key) as T | undefined;
  }

  async put(key: string, value: unknown): Promise<void> {
    this.values.set(key, value);
  }

  async setAlarm(scheduledTime: number): Promise<void> {
    this.alarmAt = scheduledTime;
  }

  async delete(key: string): Promise<boolean> {
    return this.values.delete(key);
  }

  async deleteAlarm(): Promise<void> {
    this.alarmAt = undefined;
  }

  async transaction<T>(closure: (txn: FakeStorage) => Promise<T>): Promise<T> {
    return closure(this);
  }
}

class TokenAuthorityDatabase {
  readonly binding: D1Database;
  private readonly sqlite: DatabaseSync;
  private readonly testDb: TestD1;

  constructor() {
    this.testDb = createTestD1();
    this.binding = this.testDb.binding;
    this.sqlite = this.testDb.sqlite;
    this.sqlite.prepare(
      `INSERT INTO codex_auths
         (id, kind, upstream_email, upstream_account_id, status, expires_at,
          last_refresh_at, created_at, updated_at)
       VALUES (?, 'shared', NULL, NULL, 'active', NULL, NULL, ?, ?)`
    ).run(SHARED_CODEX_AUTH_ID, "2026-06-24T00:00:00.000Z", "2026-06-24T00:00:00.000Z");
    this.seedSubscriptionAccount("sub_grok");
  }

  close(): void {
    this.testDb.close();
  }

  seedSubscriptionAccount(id: string): void {
    this.sqlite.prepare(
      `INSERT INTO subscription_accounts
         (id, capability_source, environment, label, status, refresh_available,
          created_at, updated_at)
       VALUES (?, 'grok', 'production', ?, 'active', 0, ?, ?)`
    ).run(id, id, "2026-06-24T00:00:00.000Z", "2026-06-24T00:00:00.000Z");
  }

  replaceSubscriptionAccount(id: string): void {
    this.sqlite.exec("DELETE FROM subscription_accounts");
    this.seedSubscriptionAccount(id);
  }

  get status(): string | undefined {
    return this.codexAuth()?.status as string | undefined;
  }

  setCodexStatus(status: string): void {
    this.sqlite.prepare("UPDATE codex_auths SET status = ? WHERE id = ?").run(status, SHARED_CODEX_AUTH_ID);
  }

  get lastRefresh(): Record<string, unknown> | undefined {
    const row = this.codexAuth();
    if (!row) {
      return undefined;
    }
    return {
      email: row.upstream_email,
      account_id: row.upstream_account_id,
      status: row.status,
      expires_at: row.expires_at,
      last_refresh_at: row.last_refresh_at,
      updated_at: row.updated_at,
      auth_id: row.id
    };
  }

  get subscriptionStatus(): string | undefined {
    return this.subscriptionAccounts.get("sub_grok")?.status as string | undefined;
  }

  get subscriptionAccounts(): Map<string, Record<string, unknown>> {
    const rows = this.sqlite.prepare("SELECT * FROM subscription_accounts").all() as Array<Record<string, unknown>>;
    return new Map(rows.map((row) => [String(row.id), row]));
  }

  private codexAuth(): Record<string, unknown> | undefined {
    return this.sqlite.prepare("SELECT * FROM codex_auths WHERE id = ?")
      .get(SHARED_CODEX_AUTH_ID) as Record<string, unknown> | undefined;
  }
}
