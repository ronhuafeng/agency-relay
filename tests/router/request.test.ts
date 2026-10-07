import { describe, expect, it } from "vitest";
import { commitProviderAttemptAccounting, SHARED_CODEX_AUTH_ID } from "../../src/db";
import { handleRequest } from "../../src/router";
import { TEST_IDENTITY_VERSION } from "../support/identity-version";
import {
  admin,
  createKey,
  createUser,
  importSharedAuth,
  makeFixture,
  type Fixture
} from "./fixture";

describe("router admission", () => {
  it("rejects an unknown model hostname before D1 authentication", async () => {
    const fixture = makeFixture();
    const preparedBefore = fixture.db.preparedSql.length;

    const response = await handleRequest(new Request("https://unknown.example.test/v1/models", {
      headers: { Authorization: "Bearer cfwd_not_looked_up" }
    }), fixture.env, fixture.ctx, fixture.deps);

    expect(response.status).toBe(404);
    expect(fixture.db.preparedSql).toHaveLength(preparedBefore);
    expect(fixture.fetchCalls).toHaveLength(0);
  });

  it("authorizes the Codex profile with its exact grant and rejects wildcard or cross-profile grants", async () => {
    const fixture = makeFixture();
    const user = await createUser(fixture, "route-profile@example.com");
    const exact = await createKey(fixture, user.user.id, ["surface:codex:production"]);
    const wildcard = await createKeyWithStoredGrants(fixture, user.user.id, ["*"]);
    const crossProfile = await createKeyWithStoredGrants(fixture, user.user.id, ["surface:grok:production"]);
    await importSharedAuth(fixture);

    const exactResponse = await handleRequest(new Request("https://api.trustedtunnel.app/v1/models", {
      headers: { Authorization: `Bearer ${exact.api_key}` }
    }), fixture.env, fixture.ctx, fixture.deps);
    expect(exactResponse.status).toBe(200);
    await fixture.ctx.flush();
    expect(fixture.db.audit).toContainEqual(expect.objectContaining({
      route_profile_id: "codex.models",
      status: "ok",
      upstream_status: 200
    }));
    expect([...fixture.db.usageDaily.values()]).not.toContainEqual(expect.objectContaining({
      route_profile_id: "codex.models"
    }));

    for (const deniedKey of [wildcard, crossProfile]) {
      const denied = await handleRequest(new Request("https://api.trustedtunnel.app/v1/models", {
        headers: { Authorization: `Bearer ${deniedKey.api_key}` }
      }), fixture.env, fixture.ctx, fixture.deps);
      expect(denied.status).toBe(403);
      await expect(denied.json()).resolves.toMatchObject({
        error: { code: "scope_denied" }
      });
    }
  });

  it("rejects exhausted Surface Credit before the provider attempt", async () => {
    const fixture = makeFixture();
    const user = await createUser(fixture, "credit-exhausted@example.com");
    const key = await createKey(fixture, user.user.id, ["surface:codex:production"]);
    await importSharedAuth(fixture);
    const policy = await admin(
      fixture,
      `https://api.trustedtunnel.app/admin/users/${user.user.id}/credits/codex`,
      { method: "PUT", body: { monthly_allowance: 1 } }
    );
    expect(policy.status).toBe(200);
    fixture.db.seedSurfaceCreditUsage(user.user.id, "surface:codex:production", {
      consumed_credits: 1,
      admitted_attempts: 1,
      last_seen_at: "2026-06-24T00:00:00.000Z"
    });

    const response = await handleRequest(new Request("https://api.trustedtunnel.app/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key.api_key}`,
        "Content-Type": "application/json"
      },
      body: "{}"
    }), fixture.env, fixture.ctx, fixture.deps);

    expect(response.status).toBe(429);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "surface_credit_exhausted" }
    });
    expect(fixture.fetchCalls).toHaveLength(0);
  });

  it("rejects an unknown host before provider work", async () => {
    const fixture = makeFixture();
    const user = await createUser(fixture, "unknown-host@example.com");
    const key = await createKey(fixture, user.user.id, ["surface:codex:production"]);
    const response = await handleRequest(new Request("https://unknown.example/v1/models", {
      headers: { Authorization: `Bearer ${key.api_key}` }
    }), fixture.env, fixture.ctx, fixture.deps);
    expect(response.status).toBe(404);
  });

  it("rejects non-profile and wrong-profile grants on every Codex route", async () => {
    const fixture = makeFixture();
    const user = await createUser(fixture, "bounded-bridge@example.com");
    const models = await createKeyWithStoredGrants(fixture, user.user.id, ["models"]);
    const responses = await createKeyWithStoredGrants(fixture, user.user.id, ["responses"]);
    const wildcard = await createKeyWithStoredGrants(fixture, user.user.id, ["*"]);
    const crossProfile = await createKeyWithStoredGrants(fixture, user.user.id, ["surface:grok:production"]);

    const routes = [
      { url: "https://api.trustedtunnel.app/v1/models", method: "GET", websocket: false },
      { url: "https://api.trustedtunnel.app/v1/responses", method: "POST", websocket: false },
      { url: "https://api.trustedtunnel.app/v1/responses/compact", method: "POST", websocket: false },
      { url: "https://api.trustedtunnel.app/v1/responses", method: "GET", websocket: true },
      { url: "https://api.trustedtunnel.app/v1/audio/speech", method: "POST", websocket: false },
      { url: "https://api.trustedtunnel.app/v1/audio/transcriptions", method: "POST", websocket: false },
      { url: "https://api.trustedtunnel.app/v1/realtime", method: "GET", websocket: true },
      { url: "https://api.trustedtunnel.app/v1/realtime/calls", method: "POST", websocket: false },
      { url: "https://api.trustedtunnel.app/v1/live", method: "POST", websocket: false },
      { url: "https://api.trustedtunnel.app/v1/live", method: "GET", websocket: true },
      { url: "https://api.trustedtunnel.app/v1/live/rtc_test", method: "GET", websocket: true }
    ];
    for (const deniedKey of [models, responses, wildcard, crossProfile]) {
      for (const route of routes) {
        const denied = await handleRequest(new Request(route.url, {
          method: route.method,
          headers: {
            Authorization: `Bearer ${deniedKey.api_key}`,
            "Content-Type": "application/json",
            ...(route.websocket ? { Upgrade: "websocket", Connection: "Upgrade" } : {})
          },
          body: route.method === "POST" ? "{}" : undefined
        }), fixture.env, fixture.ctx, fixture.deps);
        expect(denied.status).toBe(403);
        await expect(denied.json()).resolves.toMatchObject({
          error: { code: "scope_denied" }
        });
      }
    }
    expect(fixture.fetchCalls).toHaveLength(0);
    expect(fixture.db.audit).toHaveLength(0);
  });

  it("performs one joined key/user lookup for every Codex profile operation", async () => {
    const fixture = makeFixture();
    const user = await createUser(fixture, "profile-lookup@example.com");
    const key = await createKey(fixture, user.user.id, ["surface:codex:production"]);
    await importSharedAuth(fixture);
    const cases = [
      new Request("https://api.trustedtunnel.app/v1/models", {
        headers: { Authorization: `Bearer ${key.api_key}` }
      }),
      new Request("https://api.trustedtunnel.app/v1/responses", {
        method: "POST",
        headers: { Authorization: `Bearer ${key.api_key}`, "Content-Type": "application/json" },
        body: "{}"
      }),
      new Request("https://api.trustedtunnel.app/v1/responses/compact", {
        method: "POST",
        headers: { Authorization: `Bearer ${key.api_key}`, "Content-Type": "application/json" },
        body: "{}"
      }),
      new Request("https://api.trustedtunnel.app/v1/responses", {
        headers: { Authorization: `Bearer ${key.api_key}`, Upgrade: "websocket" }
      })
    ];

    for (const request of cases) {
      const joinedReadsBefore = fixture.db.preparedSql.filter((sql) => sql.includes("FROM api_keys AS ak")).length;
      const response = await handleRequest(request, fixture.env, fixture.ctx, fixture.deps);
      await response.text();
      await fixture.ctx.flush();
      const joinedReadsAfter = fixture.db.preparedSql.filter((sql) => sql.includes("FROM api_keys AS ak")).length;
      expect(joinedReadsAfter - joinedReadsBefore).toBe(1);
    }
  });

  it("issues only exact surface grants", async () => {
    const fixture = makeFixture();
    const user = await createUser(fixture, "issuance@example.com");
    fixture.db.ensureCredentialAccountsForScopes([
      "surface:codex:production",
      "surface:grok:production"
    ]);

    const defaultKey = await admin(fixture, `https://api.trustedtunnel.app/admin/users/${user.user.id}/keys`, {
      method: "POST",
      body: {
        name: "Request key",
        scopes: ["surface:codex:production"],
        credential_bindings: [{
          surface_grant: "surface:codex:production",
          credential_account_id: SHARED_CODEX_AUTH_ID
        }]
      }
    });
    expect(defaultKey.status).toBe(201);
    await expect(defaultKey.json()).resolves.toMatchObject({
      key: { scopes: JSON.stringify(["surface:codex:production"]) }
    });

    const multiProfileKey = await admin(fixture, `https://api.trustedtunnel.app/admin/users/${user.user.id}/keys`, {
      method: "POST",
      body: {
        name: "Request key",
        scopes: [
          "surface:codex:production",
          "surface:grok:production"
        ],
        credential_bindings: [
          { surface_grant: "surface:codex:production", credential_account_id: SHARED_CODEX_AUTH_ID },
          { surface_grant: "surface:grok:production", credential_account_id: "sub_grok_test" }
        ]
      }
    });
    expect(multiProfileKey.status).toBe(201);
    await expect(multiProfileKey.json()).resolves.toMatchObject({
      key: {
        scopes: JSON.stringify([
          "surface:codex:production",
          "surface:grok:production"
        ])
      }
    });

    for (const scopes of [["models"], ["responses"], ["*"], ["route-profile:codex"], ["surface:anthropic:staging"], ["surface:codex:staging"], ["surface:grok:staging"], []]) {
      const rejected = await admin(fixture, `https://api.trustedtunnel.app/admin/users/${user.user.id}/keys`, {
        method: "POST",
        body: { scopes }
      });
      expect(rejected.status).toBe(400);
      await expect(rejected.json()).resolves.toMatchObject({
        error: { code: expect.stringMatching(/invalid_surface_grants|missing_surface_grants/) }
      });
    }
  });

  it("commits a non-Responses Provider Attempt without updating Usage Summary", async () => {
    const fixture = makeFixture();
    const user = await createUser(fixture, "attempt-only@example.com");

    await commitProviderAttemptAccounting(fixture.env, {
      audit_id: "audit_attempt_only",
      route_profile_id: "codex",
      route: "/v1/responses",
      user_id: user.user.id,
      status: "ok",
      upstream_status: 200,
      usage_observer: "none",
      usage_capture: null
    }, fixture.deps.now());

    expect(fixture.db.audit).toHaveLength(1);
    expect(fixture.db.audit[0]).toMatchObject({
      id: "audit_attempt_only",
      route_profile_id: "codex",
      route: "/v1/responses"
    });
    expect(fixture.db.usageDaily.size).toBe(0);
    expect(fixture.db.batchCalls).toBe(1);
  });

  it("creates a user, creates a key, authenticates models, then rejects revoked key", async () => {
    const fixture = makeFixture({
      env: {
        CODEX_EGRESS_BASE_URL: "https://codex-egress-us-west1-a.trustedtunnel.app",
        CODEX_EGRESS_SECRET: "egress-secret"
      }
    });
    const created = await createUser(fixture, "alice@example.com");
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

    expect(keyBody.api_key.startsWith("cfwd_")).toBe(true);
    expect(keyBody.key.key_prefix).toBe(keyBody.api_key.slice(0, 18));
    expect(keyBody.key).not.toHaveProperty("key_hash");

    const models = await handleRequest(new Request("https://api.trustedtunnel.app/v1/models?client_version=0.144.0", {
      headers: {
        "Authorization": `Bearer ${keyBody.api_key}`,
        "Originator": "codex-cli",
        "X-Future-Codex-Header": "preserve-me"
      }
    }), fixture.env, fixture.ctx, fixture.deps);
    expect(models.status).toBe(200);
    const modelsBody = await models.json() as { models: Array<{ slug: string }> };
    expect(models.headers.get("ETag")).toBe('"upstream-models"');
    expect(modelsBody.models.map((model) => model.slug)).toEqual(["upstream-model"]);
    expect(fixture.fetchCalls).toHaveLength(1);
    expect(fixture.fetchCalls[0]).toMatchObject({
      url: `https://codex-egress-us-west1-a.trustedtunnel.app/models?client_version=${TEST_IDENTITY_VERSION}`,
      method: "GET",
      authorization: "Bearer shared_access"
    });
    expect(fixture.fetchCalls[0].headers.get("Chatgpt-Account-Id")).toBe("acct_shared");
    expect(fixture.fetchCalls[0].headers.get("X-Codex-Egress-Secret")).toBe("egress-secret");
    expect(fixture.fetchCalls[0].headers.get("Originator")).toBe("codex_cli_rs");
    expect(fixture.fetchCalls[0].headers.get("User-Agent")).toBe(
      `codex_cli_rs/${TEST_IDENTITY_VERSION} (Linux 6.6; x86_64) unknown`
    );
    expect(fixture.fetchCalls[0].headers.get("X-Future-Codex-Header")).toBe("preserve-me");

    const revoke = await admin(fixture, `https://api.trustedtunnel.app/admin/keys/${keyBody.key.id}`, { method: "DELETE" });
    expect(revoke.status).toBe(200);

    const revokedModels = await handleRequest(new Request("https://api.trustedtunnel.app/v1/models", {
      headers: { "Authorization": `Bearer ${keyBody.api_key}` }
    }), fixture.env, fixture.ctx, fixture.deps);
    expect(revokedModels.status).toBe(401);
    await expect(revokedModels.json()).resolves.toMatchObject({
      error: { code: "invalid_api_key" }
    });
  });

  it("does not admit Surface Credit when the Codex fallback version is missing", async () => {
    const fixture = makeFixture();
    const created = await createUser(fixture, "missing-identity@example.com");
    const keyBody = await createKey(fixture, created.user.id, ["surface:codex:production"]);
    await importSharedAuth(fixture);
    fixture.db.forgetIdentityVersions();
    let tokenReads = 0;
    const readToken = fixture.tokenAuthority.getFreshAccessToken.bind(fixture.tokenAuthority);
    fixture.tokenAuthority.getFreshAccessToken = async () => {
      tokenReads += 1;
      return readToken();
    };
    const preparedBefore = fixture.db.preparedSql.length;

    const response = await handleRequest(new Request("https://api.trustedtunnel.app/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${keyBody.api_key}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ model: "gpt-5.4", input: "missing-version" })
    }), fixture.env, fixture.ctx, fixture.deps);

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "upstream_identity_unavailable" }
    });
    expect(tokenReads).toBe(0);
    expect(fixture.fetchCalls).toHaveLength(0);
    expect(fixture.db.audit).toHaveLength(0);
    expect(fixture.db.preparedSql.slice(preparedBefore).join("\n")).not.toContain(
      "user_surface_credit_usage"
    );
  });
});

async function createKeyWithStoredGrants(fixture: Fixture, userId: string, scopes: string[]): Promise<{ api_key: string; key: { id: string; key_prefix: string; key_hash?: string } }> {
  const key = await createKey(fixture, userId, ["surface:codex:production"]);
  fixture.db.updateApiKeyScopes(key.key.id, scopes);
  return key;
}
