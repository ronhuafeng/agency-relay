import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import {
  driverFor,
  publicSubscriptionAccount
} from "../../src/auth/subscription-accounts";
import { HttpError } from "../../src/errors";
import { handleRequest } from "../../src/router";
import type { ExecutionDependencies } from "../../src/types";
import { seedIdentityVersions } from "../support/identity-version";
import { createTestD1, type TestD1 } from "../support/sqlite-d1";

describe("Subscription credential drivers", () => {
  it("normalizes Grok imports without requiring secrets in D1 metadata", () => {
    expect(() => driverFor("chatgpt")).toThrow(expect.objectContaining({
      code: "invalid_capability_source"
    }));

    const grok = driverFor("grok").normalizeImport({
      access_token: "xai",
      refresh_token: "xai-refresh",
      oidc_issuer: "https://auth.x.ai",
      oidc_client_id: "grok-build"
    });
    expect(grok).toMatchObject({
      access_token: "xai",
      refresh_token: "xai-refresh",
      oidc_issuer: "https://auth.x.ai",
      oidc_client_id: "grok-build"
    });
  });

  it("requires complete supported Grok OIDC refresh material", () => {
    expect(() => driverFor("grok").normalizeImport({
      access_token: "xai",
      refresh_token: "xai-refresh"
    })).toThrow(expect.objectContaining({
      code: "incomplete_grok_oidc_refresh_material"
    }));
    expect(() => driverFor("grok").normalizeImport({
      access_token: "xai",
      refresh_token: "xai-refresh",
      oidc_issuer: "https://attacker.example",
      oidc_client_id: "grok-build"
    })).toThrow(expect.objectContaining({
      code: "unsupported_grok_oidc_issuer"
    }));
    expect(driverFor("grok").normalizeImport({ access_token: "access-only" })).toEqual({
      access_token: "access-only",
      refresh_token: undefined,
      oidc_issuer: undefined,
      oidc_client_id: undefined,
      expires_at: undefined,
      account_ref: undefined
    });
  });

  it("classifies only terminal Grok OAuth failures as permanent", () => {
    expect(driverFor("grok").classifyRefreshFailure(new Error("nope"))).toEqual({
      permanent: false,
      code: "grok_token_refresh_failed"
    });
    expect(driverFor("grok").classifyRefreshFailure(
      new HttpError(401, "reauth", "authentication_error", "invalid_grant")
    )).toEqual({
      permanent: true,
      code: "invalid_grant"
    });
    expect(driverFor("grok").classifyRefreshFailure(
      new HttpError(401, "reauth", "authentication_error", "invalid_client")
    )).toEqual({
      permanent: true,
      code: "invalid_client"
    });
  });

  it("publicSubscriptionAccount never includes token material", () => {
    const publicRow = publicSubscriptionAccount({
      id: "sub_1",
      capability_source: "grok",
      environment: "staging",
      label: "grok-stg",
      status: "active",
      provider_account_ref: null,
      expires_at: "2026-07-25T00:00:00.000Z",
      refresh_available: 1,
      last_refresh_at: null,
      reauth_required_at: null,
      last_success_at: null,
      last_failure_at: null,
      last_test_at: null,
      last_test_status: null,
      created_at: "2026-07-24T00:00:00.000Z",
      updated_at: "2026-07-24T00:00:00.000Z"
    });
    expect(JSON.stringify(publicRow)).not.toMatch(/access_token|refresh_token|bearer/i);
    expect(publicRow).not.toHaveProperty("project_ref");
    expect(publicRow.refresh_available).toBe(true);
  });
});

describe("Subscription account admin APIs", () => {
  it("creates, imports, tests, and lists accounts without echoing secrets", async () => {
    const fixture = makeSubscriptionFixture();
    const create = await admin(fixture, "https://api.trustedtunnel.app/admin/subscriptions", {
      method: "POST",
      body: {
        capability_source: "grok",
        environment: "staging",
        label: "grok-staging"
      }
    });
    expect(create.status).toBe(201);
    const created = await create.json() as { account: { id: string } };
    expect(created.account.id).toMatch(/^sub_/);
    expect(JSON.stringify(created)).not.toMatch(/access_token|secret/i);

    const imported = await admin(fixture, `https://api.trustedtunnel.app/admin/subscriptions/${created.account.id}/import`, {
      method: "POST",
      body: {
        access_token: "super-secret-token",
        refresh_token: "super-secret-refresh",
        oidc_issuer: "https://auth.x.ai",
        oidc_client_id: "grok-build"
      }
    });
    expect(imported.status).toBe(201);
    const importBody = await imported.json() as { diagnostics: { secrets_echoed: boolean }; account: unknown };
    expect(importBody.diagnostics.secrets_echoed).toBe(false);
    expect(JSON.stringify(importBody)).not.toContain("super-secret");

    const tested = await admin(fixture, `https://api.trustedtunnel.app/admin/subscriptions/${created.account.id}/test`, {
      method: "POST"
    });
    expect(tested.status).toBe(200);
    await expect(tested.json()).resolves.toMatchObject({ ok: true, has_access_token: true });

    const listed = await admin(fixture, "https://api.trustedtunnel.app/admin/subscriptions", { method: "GET" });
    expect(listed.status).toBe(200);
    const listBody = await listed.json() as { accounts: Array<{ id: string }> };
    expect(listBody.accounts.some((a) => a.id === created.account.id)).toBe(true);
    expect(fixture.db.operatorMutationAudit.map((row) => row.action)).toEqual([
      "subscription.grok_create",
      "credential.grok_import",
      "credential.grok_test"
    ]);
  });

  it("allows multiple accounts for the same source and environment", async () => {
    const fixture = makeSubscriptionFixture();
    const first = await admin(fixture, "https://api.trustedtunnel.app/admin/subscriptions", {
      method: "POST",
      body: {
        capability_source: "grok",
        environment: "production",
        label: "grok-prod"
      }
    });
    expect(first.status).toBe(201);
    const second = await admin(fixture, "https://api.trustedtunnel.app/admin/subscriptions", {
      method: "POST",
      body: {
        capability_source: "grok",
        environment: "production",
        label: "grok-prod-2"
      }
    });
    expect(second.status).toBe(201);
    const listed = await admin(fixture, "https://api.trustedtunnel.app/admin/subscriptions", { method: "GET" });
    const body = await listed.json() as { accounts: Array<{ environment: string; capability_source: string }> };
    expect(body.accounts.filter((account) =>
      account.environment === "production" && account.capability_source === "grok"
    )).toHaveLength(2);
  });

  it("imports Grok OIDC refresh metadata without echoing it", async () => {
    const fixture = makeSubscriptionFixture();
    const createdResponse = await admin(fixture, "https://api.trustedtunnel.app/admin/subscriptions", {
      method: "POST",
      body: {
        capability_source: "grok",
        environment: "production",
        label: "grok-prod"
      }
    });
    const created = await createdResponse.json() as { account: { id: string } };
    const imported = await admin(
      fixture,
      `https://api.trustedtunnel.app/admin/subscriptions/${created.account.id}/import`,
      {
        method: "POST",
        body: {
          access_token: "grok-access-secret",
          refresh_token: "grok-refresh-secret",
          oidc_issuer: "https://auth.x.ai",
          oidc_client_id: "grok-public-client"
        }
      }
    );

    expect(imported.status).toBe(201);
    const body = await imported.json();
    expect(JSON.stringify(body)).not.toMatch(/grok-access-secret|grok-refresh-secret|grok-public-client/);
    const stored = fixture.subscriptionByName.get(`subscription:${created.account.id}`)?.credential;
    expect(stored).toMatchObject({
      oidc_issuer: "https://auth.x.ai",
      oidc_client_id: "grok-public-client"
    });
  });

  it("exposes subscription admin APIs on the CLI admin hostname", async () => {
    const fixture = makeSubscriptionFixture();
    const response = await handleRequest(new Request("https://api.trustedtunnel.app/admin/subscriptions", {
      headers: { Authorization: "Bearer admin-secret" }
    }), fixture.env, fixture.ctx, fixture.deps);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      kind: "subscription_accounts",
      accounts: []
    });
  });
});

describe("Grok credential authority path", () => {
  it("fails locally without a Subscription Account and does not read a Worker secret", async () => {
    const fetchMock = vi.fn(async () => new Response("should-not-run"));
    const fixture = makeSubscriptionFixture({ fetch: fetchMock });
    fixture.db.seedUser({
      id: "user_1",
      email: "u@example.com",
      status: "active",
      created_at: "2026-07-24T00:00:00.000Z",
      updated_at: "2026-07-24T00:00:00.000Z"
    });
    const { hmacSha256Hex, keyPrefix } = await import("../../src/crypto");
    const plaintext = "cfwd_test_grok_key_aaaaaaaaaaaaaaaaaa";
    const hash = await hmacSha256Hex("pepper", plaintext);
    fixture.db.seedApiKey({
      id: "key_1",
      user_id: "user_1",
      key_prefix: keyPrefix(plaintext),
      key_hash: hash,
      status: "active",
      scopes: JSON.stringify(["surface:grok:production"]),
      expires_at: null,
      last_used_at: null,
      created_at: "2026-07-24T00:00:00.000Z",
      revoked_at: null
    });

    const response = await handleRequest(new Request("https://grok.trustedtunnel.app/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${plaintext}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ model: "grok-4.5", input: "hi" })
    }), fixture.env, fixture.ctx, fixture.deps);

    expect(response.status).toBe(503);
    const body = await response.json() as { error?: { code?: string; message?: string; type?: string } };
    expect(JSON.stringify(body).toLowerCase()).toMatch(/unavailable|subscription|credential|account/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("serves Grok via imported Credential Slot DO material without secret fallback", async () => {
    const fetchMock = vi.fn(async () => new Response(
      JSON.stringify({ id: "resp_ok", object: "response", status: "completed" }),
      { status: 200 }
    ));
    const fixture = makeSubscriptionFixture({ fetch: fetchMock });
    fixture.db.seedUser({
      id: "user_1",
      email: "u@example.com",
      status: "active",
      created_at: "2026-07-24T00:00:00.000Z",
      updated_at: "2026-07-24T00:00:00.000Z"
    });
    const { hmacSha256Hex, keyPrefix } = await import("../../src/crypto");
    const plaintext = "cfwd_test_grok_key_aaaaaaaaaaaaaaaaaa";
    const hash = await hmacSha256Hex("pepper", plaintext);
    fixture.db.seedApiKey({
      id: "key_1",
      user_id: "user_1",
      key_prefix: keyPrefix(plaintext),
      key_hash: hash,
      status: "active",
      scopes: JSON.stringify(["surface:grok:production"]),
      expires_at: null,
      last_used_at: null,
      created_at: "2026-07-24T00:00:00.000Z",
      revoked_at: null
    });
    fixture.db.seedSubscriptionAccount({
      id: "sub_grok",
      capability_source: "grok",
      environment: "production",
      label: "grok-prod",
      status: "active",
      provider_account_ref: null,
      expires_at: "2099-01-01T00:00:00.000Z",
      refresh_available: 1,
      last_refresh_at: null,
      reauth_required_at: null,
      last_success_at: null,
      last_failure_at: null,
      last_test_at: null,
      last_test_status: null,
      created_at: "2026-07-24T00:00:00.000Z",
      updated_at: "2026-07-24T00:00:00.000Z"
    });
    fixture.db.seedCredentialBinding("key_1", "surface:grok:production", "sub_grok");
    await fixture.env.TOKEN_AUTHORITY.get(
      fixture.env.TOKEN_AUTHORITY.idFromName("subscription:sub_grok")
    ).saveSubscriptionCredential({
      account_id: "sub_grok",
      capability_source: "grok",
      access_token: "do-access-token",
      refresh_token: "do-refresh",
      expires_at: "2099-01-01T00:00:00.000Z",
      status: "active"
    });

    const response = await handleRequest(new Request("https://grok.trustedtunnel.app/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${plaintext}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ model: "grok-4.5", input: "hi" })
    }), fixture.env, fixture.ctx, fixture.deps);

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalled();
    const firstCall = fetchMock.mock.calls[0] as unknown as [unknown, RequestInit | undefined];
    const auth = new Headers(firstCall[1]?.headers).get("Authorization");
    expect(auth).toBe("Bearer do-access-token");
  });
});

function makeSubscriptionFixture(options: { fetch?: typeof fetch } = {}) {
  const testDb = createTestD1();
  onTestFinished(() => testDb.close());
  testDb.sqlite.prepare("UPDATE organization_surface_credit_defaults SET monthly_allowance = 1000000").run();
  const db = new SubscriptionTestDatabase(testDb);

  const subscriptionByName = new Map<string, { credential?: Record<string, unknown>; revoked: boolean }>();
  let currentName = "shared_default";
  const authority = {
    names: [] as string[],
    async saveToken() {},
    async getFreshAccessToken() {
      throw new Error("not configured");
    },
    async refreshNow() {
      throw new Error("not configured");
    },
    async revoke() {},
    async saveSubscriptionCredential(credential: Record<string, unknown>) {
      subscriptionByName.set(currentName, { credential: { ...credential }, revoked: false });
      return { ok: true as const, value: null };
    },
    async getFreshSubscriptionCredential() {
      const slot = subscriptionByName.get(currentName);
      if (!slot?.credential || slot.revoked) {
        const { HttpError } = await import("../../src/errors");
        throw new HttpError(401, "missing", "authentication_error", "missing_subscription_credential");
      }
      return {
        ok: true as const,
        value: { access_token: String(slot.credential.access_token) }
      };
    },
    async refreshSubscriptionNow() {
      const slot = subscriptionByName.get(currentName);
      return {
        ok: true as const,
        value: { account_id: String(slot?.credential?.account_id ?? ""), refresh_available: true }
      };
    },
    async revokeSubscription() {
      const slot = subscriptionByName.get(currentName);
      if (slot) {
        slot.revoked = true;
      }
    }
  };

  const env = {
    CODEX_EGRESS_BASE_URL: "https://codex-egress-us-west1-a.trustedtunnel.app",
    CODEX_EGRESS_SECRET: "egress-secret",
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
    DB: db.binding,
    TOKEN_AUTHORITY: {
      idFromName(name: string) {
        return { toString: () => name, equals: () => false, name };
      },
      get(id: { toString(): string }) {
        currentName = id.toString();
        authority.names.push(currentName);
        return authority;
      }
    } as unknown as Env["TOKEN_AUTHORITY"]
  } as Env;

  const deps: ExecutionDependencies = {
    fetch: options.fetch ?? (async () => new Response("{}", { status: 200 })),
    now: () => new Date("2026-07-24T00:00:00.000Z")
  };
  const waitUntilPromises: Promise<unknown>[] = [];
  const ctx = {
    waitUntil(promise: Promise<unknown>) {
      waitUntilPromises.push(promise);
    },
    async flush() {
      await Promise.all(waitUntilPromises.splice(0));
    }
  };

  return { env, deps, ctx, db, authority, subscriptionByName };
}

class SubscriptionTestDatabase {
  readonly binding: D1Database;
  private readonly sqlite: DatabaseSync;

  constructor(testDb: TestD1) {
    this.binding = testDb.binding;
    this.sqlite = testDb.sqlite;
    seedIdentityVersions(this.sqlite);
  }

  get operatorMutationAudit(): Array<Record<string, unknown>> {
    return this.sqlite.prepare(
      "SELECT * FROM operator_mutation_audit ORDER BY created_at, rowid"
    ).all() as Array<Record<string, unknown>>;
  }

  seedUser(row: Record<string, unknown>): void {
    this.sqlite.prepare(
      `INSERT INTO users (id, email, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`
    ).run(...sqliteValues(row.id, row.email, row.status, row.created_at, row.updated_at));
  }

  seedApiKey(row: Record<string, unknown>): void {
    this.sqlite.prepare(
      `INSERT INTO api_keys
         (id, user_id, key_prefix, key_hash, status, scopes, expires_at,
          last_used_at, created_at, revoked_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(...sqliteValues(
      row.id,
      row.user_id,
      row.key_prefix,
      row.key_hash,
      row.status,
      row.scopes,
      row.expires_at,
      row.last_used_at,
      row.created_at,
      row.revoked_at
    ));
  }

  seedSubscriptionAccount(row: Record<string, unknown>): void {
    this.sqlite.prepare(
      `INSERT INTO subscription_accounts
         (id, capability_source, environment, label, status, provider_account_ref,
          expires_at, refresh_available, last_refresh_at, reauth_required_at,
          last_success_at, last_failure_at, last_test_at, last_test_status,
          created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(...sqliteValues(
      row.id,
      row.capability_source,
      row.environment,
      row.label,
      row.status,
      row.provider_account_ref,
      row.expires_at,
      row.refresh_available,
      row.last_refresh_at,
      row.reauth_required_at,
      row.last_success_at,
      row.last_failure_at,
      row.last_test_at,
      row.last_test_status,
      row.created_at,
      row.updated_at
    ));
  }

  seedCredentialBinding(apiKeyId: string, surfaceGrant: string, subscriptionAccountId: string): void {
    const timestamp = "2026-07-24T00:00:00.000Z";
    this.sqlite.prepare(
      `INSERT INTO api_key_surface_credentials
         (api_key_id, surface_grant, codex_auth_id, subscription_account_id, created_at, updated_at)
       VALUES (?, ?, NULL, ?, ?, ?)`
    ).run(apiKeyId, surfaceGrant, subscriptionAccountId, timestamp, timestamp);
  }
}

function sqliteValues(...values: unknown[]): SQLInputValue[] {
  return values as SQLInputValue[];
}

async function admin(
  fixture: ReturnType<typeof makeSubscriptionFixture>,
  url: string,
  input: { method: string; body?: unknown }
): Promise<Response> {
  return handleRequest(new Request(url, {
    method: input.method,
    headers: {
      Authorization: "Bearer admin-secret",
      ...(input.body ? { "Content-Type": "application/json" } : {})
    },
    body: input.body ? JSON.stringify(input.body) : undefined
  }), fixture.env, fixture.ctx, fixture.deps);
}
