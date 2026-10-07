import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { expect, onTestFinished } from "vitest";
import { SHARED_CODEX_AUTH_ID } from "../../src/db";
import { HttpError } from "../../src/errors";
import { handleRequest } from "../../src/router";
import { seedIdentityVersions } from "../support/identity-version";
import type { CodexAuthRefreshResult, CodexToken, ExecutionDependencies, FreshAccessToken, MediaUsageSummaryRow, MediaUsageSummaryTotals, UsageSummaryRow, UsageSummaryTotals } from "../../src/types";
import { codexAccountResponses } from "../fixtures/codex-account";
import { createTestD1, type TestD1 } from "../support/sqlite-d1";

export interface Fixture {
  env: Env;
  db: RouterTestDatabase;
  tokenAuthority: FakeTokenAuthority;
  accountResponses: Map<string, unknown>;
  fetchCalls: Array<{
    url: string;
    method: string;
    authorization: string | null;
    headers: Headers;
    body: Record<string, unknown>;
    rawBody: Uint8Array;
    sessionId: string | null;
    threadId: string | null;
    installationId: string | null;
    windowId: string | null;
  }>;
  ctx: FakeExecutionContext;
  deps: ExecutionDependencies;
}

export interface FixtureOptions {
  env?: Partial<Env>;
  requestAuditSchema?: "full" | "missing";
  usageSchema?: "full" | "missing";
  dashboardReadFailure?: "usage" | "auth";
}

const fixtureEnvBindings = {
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
  CREDENTIAL_EVENTS: undefined as unknown as Env["CREDENTIAL_EVENTS"]
} satisfies Omit<Env, "DB" | "TOKEN_AUTHORITY">;

function fixtureEnv(
  db: RouterTestDatabase,
  tokenAuthority: FakeTokenAuthority,
  overrides: Partial<Env> | undefined
): Env {
  const env: Env = {
    ...fixtureEnvBindings,
    DB: db.binding,
    TOKEN_AUTHORITY: new FakeDurableObjectNamespace(tokenAuthority) as unknown as Env["TOKEN_AUTHORITY"]
  };
  return overrides === undefined ? env : Object.assign(env, overrides);
}

export function makeFixture(options: FixtureOptions = {}): Fixture {
  const db = new RouterTestDatabase(
    options.requestAuditSchema ?? "full",
    options.usageSchema ?? "full",
    options.dashboardReadFailure
  );
  onTestFinished(() => db.close());
  const tokenAuthority = new FakeTokenAuthority(db);
  const accountResponses = codexAccountResponses();
  const fetchCalls: Fixture["fetchCalls"] = [];
  const env = fixtureEnv(db, tokenAuthority, options.env);
  const deps: ExecutionDependencies = {
    fetch: async (input, init) => {
      const url = String(input);
      const headers = new Headers(init?.headers);
      const rawBody = init?.body === undefined
        ? new Uint8Array()
        : new Uint8Array(await new Response(init.body).arrayBuffer());
      let body: Record<string, unknown> = {};
      try {
        body = JSON.parse(new TextDecoder().decode(rawBody)) as Record<string, unknown>;
      } catch {
        // The upstream fixture accepts opaque hostile input; individual tests own the response semantics.
      }
      fetchCalls.push({
        url,
        method: init?.method ?? "GET",
        authorization: headers.get("Authorization"),
        headers,
        body,
        rawBody,
        sessionId: headers.get("session-id"),
        threadId: headers.get("thread-id"),
        installationId: headers.get("x-codex-installation-id"),
        windowId: headers.get("x-codex-window-id")
      });
      if (new URL(url).pathname === "/healthz") {
        return new Response(null, { status: 200 });
      }
      if (new URL(url).pathname === "/v1internal:fetchAvailableModels") {
        return Response.json({
          models: {
            "gemini-3-flash": { displayName: "Gemini 3 Flash" },
            "claude-sonnet-4-6": { displayName: "Claude Sonnet 4.6" }
          }
        });
      }
      const accountResponse = accountResponses.get(new URL(url).pathname);
      if (accountResponse !== undefined) {
        return Response.json(accountResponse);
      }
      if (new URL(url).pathname.endsWith("/models")) {
        return new Response('{"models":[{"slug":"upstream-model"}]}', {
          status: 200,
          headers: { "Content-Type": "application/json", ETag: '"upstream-models"' }
        });
      }
      if (url.endsWith("/responses/compact")) {
        const responseBody = body.input === "compact-usage"
          ? {
              id: "resp_compact_usage",
              object: "response",
              model: body.model,
              output: [],
              usage: {
                input_tokens: 5,
                input_tokens_details: { cached_tokens: 1 },
                output_tokens: 7,
                output_tokens_details: { reasoning_tokens: 2 },
                total_tokens: 12
              }
            }
          : { output: [] };
        return new Response(JSON.stringify(responseBody), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
      }
      if (body.input === "with-usage") {
        return new Response([
          "event: response.completed",
          "data: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_usage\",\"object\":\"response\",\"model\":\"gpt-5.4\",\"usage\":{\"input_tokens\":23,\"input_tokens_details\":{\"cached_tokens\":3},\"output_tokens\":178,\"output_tokens_details\":{\"reasoning_tokens\":163},\"total_tokens\":201}}}",
          ""
        ].join("\n"), {
          status: 200,
          headers: { "Content-Type": "text/event-stream" }
        });
      }
      if (body.input === "stream-usage") {
        return new Response(new ReadableStream({
          start(controller) {
            const encoder = new TextEncoder();
            controller.enqueue(encoder.encode("event: response.created\ndata: {\"type\":\"response.created\"}\n\n"));
            controller.enqueue(encoder.encode(`${[
              "event: response.completed",
              "data: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_stream_usage\",\"object\":\"response\",\"model\":\"gpt-5.4\",\"usage\":{\"input_tokens\":11,\"input_tokens_details\":{\"cached_tokens\":4},\"output_tokens\":13,\"output_tokens_details\":{\"reasoning_tokens\":5},\"total_tokens\":24}}}"
            ].join("\n")}\n\n`));
            controller.close();
          }
        }), {
          status: 200,
          headers: { "Content-Type": "text/event-stream" }
        });
      }
      if (body.input === "stream-duplicate-usage") {
        return new Response(new ReadableStream({
          start(controller) {
            const encoder = new TextEncoder();
            controller.enqueue(encoder.encode("event: response.created\ndata: {\"type\":\"response.created\"}\n\n"));
            const completed = `${[
              "event: response.completed",
              "data: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_stream_usage\",\"object\":\"response\",\"model\":\"gpt-5.4\",\"usage\":{\"input_tokens\":11,\"input_tokens_details\":{\"cached_tokens\":4},\"output_tokens\":13,\"output_tokens_details\":{\"reasoning_tokens\":5},\"total_tokens\":24}}}"
            ].join("\n")}\n\n`;
            controller.enqueue(encoder.encode(completed));
            controller.enqueue(encoder.encode(completed));
            controller.close();
          }
        }), {
          status: 200,
          headers: { "Content-Type": "text/event-stream" }
        });
      }
      if (body.input === "stream-cancel-before-completed") {
        return new Response(new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("event: response.created\ndata: {\"type\":\"response.created\"}\n\n"));
          },
          cancel() {
            return undefined;
          }
        }), {
          status: 200,
          headers: { "Content-Type": "text/event-stream" }
        });
      }
      if (body.input === "audit-secret-prompt") {
        return new Response([
          "event: response.completed",
          "data: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_audit_secret\",\"object\":\"response\",\"output_text\":\"audit-secret-output\"}}",
          ""
        ].join("\n"), {
          status: 200,
          headers: { "Content-Type": "text/event-stream" }
        });
      }
      return new Response([
        "event: response.completed",
        "data: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_sse\",\"object\":\"response\"}}",
        ""
      ].join("\n"), {
        status: 200,
        headers: { "Content-Type": "text/event-stream" }
      });
    },
    now: () => new Date("2026-06-24T00:00:00.000Z")
  };
  return { env, db, tokenAuthority, accountResponses, fetchCalls, ctx: new FakeExecutionContext(), deps };
}

export async function createUser(fixture: Fixture, email: string): Promise<{ user: { id: string } }> {
  const response = await admin(fixture, "https://api.trustedtunnel.app/admin/users", {
    method: "POST",
    body: { email }
  });
  expect(response.status).toBe(201);
  return response.json();
}

export async function createKey(fixture: Fixture, userId: string, scopes: string[]): Promise<{ api_key: string; key: { id: string; key_prefix: string; key_hash?: string } }> {
  // Issuance accepts surface:<surface>:<environment> only. For negative-path tests that
  // store non-issuable scopes, mint a valid key then overwrite the stored grant list.
  const surfaceGrant = /^surface:[a-z0-9_-]+:(staging|production)$/;
  const issuable = scopes.length > 0 && scopes.every((s) => surfaceGrant.test(s));
  const bodyScopes = issuable ? scopes : ["surface:codex:production"];
  fixture.db.ensureCredentialAccountsForScopes(bodyScopes);
  const credential_bindings = bodyScopes.map((scope) => ({
    surface_grant: scope,
    credential_account_id: scope === "surface:codex:production" ? SHARED_CODEX_AUTH_ID : "sub_grok_test"
  }));
  const response = await admin(fixture, `https://api.trustedtunnel.app/admin/users/${userId}/keys`, {
    method: "POST",
    body: { name: "Fixture key", scopes: bodyScopes, credential_bindings }
  });
  expect(response.status).toBe(201);
  const key = await response.json() as { api_key: string; key: { id: string; key_prefix: string; key_hash?: string } };
  if (!issuable || JSON.stringify(bodyScopes) !== JSON.stringify(scopes)) {
    fixture.db.updateApiKeyScopes(key.key.id, scopes);
  }
  return key;
}


export async function importSharedAuth(fixture: Fixture): Promise<void> {
  fixture.db.ensureCredentialAccountsForScopes(["surface:codex:production"]);
  const response = await admin(fixture, "https://api.trustedtunnel.app/admin/codex-auths/shared_default/import", {
    method: "POST",
    body: {
      access_token: "shared_access",
      expires_at: "2026-06-24T12:00:00.000Z",
      account_id: "acct_shared"
    }
  });
  expect(response.status).toBe(201);
}


export const DASHBOARD_ADMIN_ID = "usr_dashboard_admin";
export const DASHBOARD_ADMIN_EMAIL = "operator@example.com";

export function seedDashboardAdmin(fixture: Fixture): void {
  if (fixture.db.users.has(DASHBOARD_ADMIN_ID)) return;
  fixture.db.seedConsoleUser({
    id: DASHBOARD_ADMIN_ID,
    email: DASHBOARD_ADMIN_EMAIL,
    role: "admin"
  });
}

export async function admin(fixture: Fixture, url: string, input: { method: string; body?: unknown }): Promise<Response> {
  if (new URL(url).hostname === fixture.env.ADMIN_DASHBOARD_HOST) {
    seedDashboardAdmin(fixture);
    const headers: Record<string, string> = {
      Cookie: `__Host-mini-console=${await consoleCookie(fixture, DASHBOARD_ADMIN_EMAIL)}`,
      "Content-Type": "application/json"
    };
    if (input.method !== "GET" && input.method !== "HEAD") {
      headers.Origin = `https://${fixture.env.ADMIN_DASHBOARD_HOST}`;
    }
    return handleRequest(new Request(url, {
      method: input.method,
      headers,
      body: input.body === undefined ? undefined : JSON.stringify(input.body)
    }), fixture.env, fixture.ctx, fixture.deps);
  }

  return handleRequest(new Request(url, {
    method: input.method,
    headers: {
      "Authorization": "Bearer admin-secret",
      "Content-Type": "application/json"
    },
    body: input.body === undefined ? undefined : JSON.stringify(input.body)
  }), fixture.env, fixture.ctx, fixture.deps);
}


export async function consoleCookie(
  fixture: Fixture,
  email: string,
  options: { subject?: string | null; expired?: boolean } = {}
): Promise<string> {
  const { resolveConsolePrincipal } = await import("../../src/auth/principal");
  const { createConsoleSession } = await import("../../src/auth/console-session");
  const principal = await resolveConsolePrincipal(fixture.env, email, fixture.deps.now(), {
    subject: options.subject ?? null, requestId: null
  });
  const now = options.expired ? new Date(fixture.deps.now().getTime() - 9 * 60 * 60 * 1000) : fixture.deps.now();
  return createConsoleSession(fixture.env, principal, now);
}

export class FakeExecutionContext {
  private readonly promises: Promise<unknown>[] = [];

  waitUntil(promise: Promise<unknown>): void {
    this.promises.push(promise);
  }

  async flush(): Promise<void> {
    let completed = 0;
    while (completed < this.promises.length) {
      const pending = this.promises.slice(completed);
      completed = this.promises.length;
      await Promise.all(pending);
    }
  }
}

export class FakeTokenAuthority {
  savedToken?: CodexToken;
  revoked = false;
  refreshCalls = 0;
  readonly names: string[] = [];
  readonly subscriptionByName = new Map<string, {
    credential?: Record<string, unknown>;
    revoked: boolean;
  }>();
  currentName = SHARED_CODEX_AUTH_ID;

  constructor(private readonly db: RouterTestDatabase) {}

  async saveToken(token: CodexToken): Promise<{ ok: true; value: null }> {
    this.savedToken = token;
    this.revoked = false;
    const existing = this.db.codexAuths.get(token.auth_id);
    this.db.seedCodexAuth({
      id: token.auth_id,
      kind: "shared",
      upstream_email: token.email ?? null,
      upstream_account_id: token.account_id ?? null,
      status: token.status,
      expires_at: token.expires_at ?? null,
      last_refresh_at: token.last_refresh_at ?? null,
      created_at: existing?.created_at ?? "2026-06-24T00:00:00.000Z",
      updated_at: "2026-06-24T00:00:00.000Z"
    });
    return { ok: true, value: null };
  }

  async getFreshAccessToken(): Promise<{ ok: true; value: FreshAccessToken }> {
    if (this.revoked || !this.savedToken || this.savedToken.status === "revoked") {
      throw new HttpError(401, "Codex auth is not active", "authentication_error", "codex_auth_inactive");
    }
    if (this.savedToken.status === "reauth_required") {
      throw new HttpError(401, "Codex auth requires reauthorization", "authentication_error", "reauth_required");
    }
    return {
      ok: true as const,
      value: {
        access_token: this.savedToken.access_token,
        account_id: this.savedToken.account_id
      }
    };
  }

  async refreshNow(): Promise<{ ok: true; value: CodexAuthRefreshResult }> {
    if (this.revoked || !this.savedToken || this.savedToken.status === "revoked") {
      throw new HttpError(401, "Codex auth is not active", "authentication_error", "codex_auth_inactive");
    }
    if (!this.savedToken.refresh_token) {
      throw new HttpError(401, "Shared Codex auth does not have a refresh token", "authentication_error", "missing_refresh_token");
    }
    this.refreshCalls += 1;
    this.savedToken = {
      ...this.savedToken,
      access_token: "refreshed_access",
      refresh_token: "refreshed_refresh",
      expires_at: "2026-06-24T01:00:00.000Z",
      last_refresh_at: "2026-06-24T00:00:00.000Z",
      status: "active"
    };
    this.db.updateCodexAuth({
      status: "active",
      expires_at: this.savedToken.expires_at,
      last_refresh_at: this.savedToken.last_refresh_at,
      updated_at: "2026-06-24T00:00:00.000Z"
    });
    return {
      ok: true as const,
      value: {
        auth_id: SHARED_CODEX_AUTH_ID,
        refresh_available: true
      }
    };
  }

  async revoke(): Promise<void> {
    this.revoked = true;
    if (this.savedToken) {
      this.savedToken = { ...this.savedToken, status: "revoked" };
    }
  }

  async saveSubscriptionCredential(credential: Record<string, unknown>): Promise<{ ok: true; value: null }> {
    const slot = this.subscriptionSlot();
    slot.credential = { ...credential };
    slot.revoked = false;
    return { ok: true, value: null };
  }

  async getFreshSubscriptionCredential(): Promise<{ ok: true; value: { access_token: string; account_ref?: string } }> {
    const slot = this.subscriptionSlot();
    if (slot.revoked || !slot.credential) {
      throw new HttpError(401, "Subscription credential is not configured", "authentication_error", "missing_subscription_credential");
    }
    return {
      ok: true,
      value: {
        access_token: String(slot.credential.access_token),
        ...(slot.credential.account_ref ? { account_ref: String(slot.credential.account_ref) } : {})
      }
    };
  }

  async refreshSubscriptionNow(): Promise<{ ok: true; value: { account_id: string; refresh_available: boolean } }> {
    const slot = this.subscriptionSlot();
    if (!slot.credential) {
      throw new HttpError(401, "Subscription credential is not configured", "authentication_error", "missing_subscription_credential");
    }
    slot.credential = {
      ...slot.credential,
      access_token: "refreshed_subscription_access",
      last_refresh_at: "2026-06-24T00:00:00.000Z"
    };
    return {
      ok: true,
      value: {
        account_id: String(slot.credential.account_id),
        refresh_available: Boolean(slot.credential.refresh_token)
      }
    };
  }

  async revokeSubscription(): Promise<void> {
    const slot = this.subscriptionSlot();
    slot.revoked = true;
    if (slot.credential) {
      slot.credential = { ...slot.credential, status: "revoked" };
    }
  }

  private subscriptionSlot() {
    let slot = this.subscriptionByName.get(this.currentName);
    if (!slot) {
      slot = { revoked: false };
      this.subscriptionByName.set(this.currentName, slot);
    }
    return slot;
  }
}

class FakeDurableObjectNamespace {
  constructor(private readonly stub: FakeTokenAuthority) {}

  idFromName(name: string): DurableObjectId {
    return {
      name,
      toString: () => name,
      equals: (other: DurableObjectId) => other.toString() === name
    };
  }

  get(id: DurableObjectId): FakeTokenAuthority {
    const name = id.toString();
    this.stub.names.push(name);
    this.stub.currentName = name;
    return this.stub;
  }
}

export class RouterTestDatabase {
  readonly binding: D1Database;
  readonly preparedSql: string[] = [];
  readonly preparedBindings: unknown[][] = [];
  batchCalls = 0;
  apiKeyTouchBarrier?: Promise<void>;
  private readonly testDb: TestD1;
  private readonly sqlite: DatabaseSync;

  constructor(
    requestAuditSchema: "full" | "missing" = "full",
    usageSchema: "full" | "missing" = "full",
    dashboardReadFailure?: "usage" | "auth"
  ) {
    this.testDb = createTestD1({
      onPrepare: (sql) => this.preparedSql.push(sql),
      onBind: (_sql, values) => this.preparedBindings.push([...values]),
      beforeRun: async (sql) => {
        if (sql.replace(/\s+/g, " ").trim().startsWith("UPDATE api_keys SET last_used_at")) {
          await this.apiKeyTouchBarrier;
        }
      },
      onBatch: () => {
        this.batchCalls += 1;
      }
    });
    this.binding = this.testDb.binding;
    this.sqlite = this.testDb.sqlite;
    seedIdentityVersions(this.sqlite);
    // Production defaults stay at zero. Proxy fixtures inherit a finite allowance so
    // existing client tests can pass issuance and admission.
    this.sqlite.prepare(
      "UPDATE organization_surface_credit_defaults SET monthly_allowance = 1000000"
    ).run();
    if (requestAuditSchema === "missing") {
      this.sqlite.exec("DROP TABLE request_audit");
    }
    if (usageSchema === "missing" || dashboardReadFailure === "usage") {
      this.sqlite.exec("DROP TABLE usage_daily; DROP TABLE media_usage_daily");
    }
    if (dashboardReadFailure === "auth") {
      this.sqlite.exec("DROP TABLE codex_auths");
    }
  }

  close(): void {
    this.testDb.close();
  }

  forgetIdentityVersions(): void {
    this.sqlite.prepare("DELETE FROM upstream_identity_version").run();
  }

  get users(): Map<string, Record<string, unknown>> {
    return this.tableMap("users", (row) => String(row.id));
  }

  get apiKeys(): Map<string, Record<string, unknown>> {
    return this.tableMap("api_keys", (row) => String(row.id));
  }

  get codexAuths(): Map<string, Record<string, unknown>> {
    return this.tableMap("codex_auths", (row) => String(row.id));
  }

  get audit(): Array<Record<string, unknown>> {
    return this.tableRows("request_audit");
  }

  get usageDaily(): Map<string, Record<string, unknown>> {
    return this.tableMap("usage_daily", (row) => [
      row.user_id,
      row.day,
      row.route_profile_id,
      row.response_model
    ].map(String).join(":"));
  }

  get videoJobs(): Array<Record<string, unknown>> {
    return this.tableRows("video_jobs");
  }

  get subscriptionAccounts(): Map<string, Record<string, unknown>> {
    return this.tableMap("subscription_accounts", (row) => String(row.id));
  }

  get operatorMutationAudit(): Array<Record<string, unknown>> {
    return this.tableRows("operator_mutation_audit");
  }

  get surfaceCreditPolicies(): Map<string, Record<string, unknown>> {
    return this.tableMap("user_surface_credit_policies", (row) =>
      `${String(row.user_id)}:${String(row.surface_grant)}`
    );
  }

  updateApiKeyScopes(id: string, scopes: readonly string[]): void {
    this.sqlite.prepare("UPDATE api_keys SET scopes = ? WHERE id = ?")
      .run(JSON.stringify(scopes), id);
  }

  ensureCredentialAccountsForScopes(scopes: readonly string[]): void {
    if (scopes.includes("surface:codex:production") && !this.codexAuths.has(SHARED_CODEX_AUTH_ID)) {
      this.seedCodexAuth({
        id: SHARED_CODEX_AUTH_ID,
        kind: "shared",
        upstream_email: null,
        upstream_account_id: null,
        status: "pending_credential",
        expires_at: null,
        last_refresh_at: null,
        created_at: "2026-06-24T00:00:00.000Z",
        updated_at: "2026-06-24T00:00:00.000Z"
      });
    }
    if (scopes.some((scope) => scope === "surface:grok:production" || scope === "surface:xai:production")
      && !this.subscriptionAccounts.has("sub_grok_test")) {
      this.sqlite.prepare(
        `INSERT INTO subscription_accounts
           (id, capability_source, environment, label, status, refresh_available, created_at, updated_at)
         VALUES ('sub_grok_test', 'grok', 'production', 'Grok test', 'pending_credential', 0, ?, ?)`
      ).run("2026-06-24T00:00:00.000Z", "2026-06-24T00:00:00.000Z");
    }
  }

  seedCodexAuth(row: Record<string, unknown>): void {
    this.sqlite.prepare(
      `INSERT INTO codex_auths
         (id, kind, upstream_email, upstream_account_id, status, expires_at,
          last_refresh_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         upstream_email = excluded.upstream_email,
         upstream_account_id = excluded.upstream_account_id,
         status = excluded.status,
         expires_at = excluded.expires_at,
         last_refresh_at = excluded.last_refresh_at,
         updated_at = excluded.updated_at`
    ).run(...sqliteValues(
      row.id,
      row.kind,
      row.upstream_email,
      row.upstream_account_id,
      row.status,
      row.expires_at,
      row.last_refresh_at,
      row.created_at,
      row.updated_at
    ));
  }

  updateCodexAuth(input: {
    status: string;
    expires_at: string | null | undefined;
    last_refresh_at: string | null | undefined;
    updated_at: string;
  }): void {
    this.sqlite.prepare(
      `UPDATE codex_auths
       SET status = ?, expires_at = ?, last_refresh_at = ?, updated_at = ?
       WHERE id = ?`
    ).run(
      input.status,
      input.expires_at ?? null,
      input.last_refresh_at ?? null,
      input.updated_at,
      SHARED_CODEX_AUTH_ID
    );
  }

  updateSubscriptionAccount(id: string, status: string, expiresAt: string): void {
    this.sqlite.prepare(
      `UPDATE subscription_accounts
       SET status = ?, expires_at = ?, updated_at = ?
       WHERE id = ?`
    ).run(status, expiresAt, "2026-06-24T00:00:00.000Z", id);
  }

  seedSurfaceCreditUsage(
    userId: string,
    surfaceGrant: string,
    input: { consumed_credits: number; admitted_attempts: number; last_seen_at: string }
  ): void {
    this.sqlite.prepare(
      `INSERT INTO user_surface_credit_usage
         (user_id, surface_grant, period_start, consumed_credits,
          admitted_attempts, last_seen_at)
       VALUES (?, ?, '2026-06-01', ?, ?, ?)`
    ).run(
      userId,
      surfaceGrant,
      input.consumed_credits,
      input.admitted_attempts,
      input.last_seen_at
    );
  }

  seedAudits(...rows: Array<Record<string, unknown>>): void {
    for (const row of rows) {
      const userId = String(row.user_id);
      this.ensureUser(userId, null);
      this.sqlite.prepare(
        `INSERT INTO request_audit
           (id, request_id, route_profile_id, route, user_id, key_id,
            codex_auth_id, response_model, status, upstream_status, error_code,
            session_id, thread_id, latency_ms, response_id, input_tokens,
            cached_input_tokens, output_tokens, reasoning_tokens, total_tokens,
            provider_cost_usd_ticks, created_at, ingress_profile_id,
            ingress_protocol, resolved_model, capability_source,
            subscription_account_id, egress_profile_id)
         VALUES (?, NULL, ?, NULL, ?, NULL, NULL, 'N/A', ?, NULL, NULL,
                 NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
                 NULL, ?, NULL, NULL, NULL, NULL, NULL, NULL)`
      ).run(...sqliteValues(
        row.id,
        row.route_profile_id ?? "codex.responses",
        userId,
        row.status,
        row.created_at
      ));
    }
  }

  seedUsage(row: Record<string, unknown>): void {
    const userId = String(row.user_id);
    this.ensureUser(userId, row.email ?? null);
    this.sqlite.prepare(
      `INSERT INTO usage_daily
         (user_id, day, route_profile_id, response_model, requests, ok_requests,
          error_requests, input_tokens, cached_input_tokens, output_tokens,
          reasoning_tokens, total_tokens, token_measurements,
          provider_cost_usd_ticks, cost_measurements, first_seen_at, last_seen_at,
          api_equivalent_usd_ticks, api_equivalent_measurements)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(...sqliteValues(
      userId,
      row.day,
      row.route_profile_id ?? "N/A",
      row.response_model ?? "N/A",
      row.requests ?? 0,
      row.ok_requests ?? 0,
      row.error_requests ?? 0,
      row.input_tokens ?? 0,
      row.cached_input_tokens ?? 0,
      row.output_tokens ?? 0,
      row.reasoning_tokens ?? 0,
      row.total_tokens ?? 0,
      row.token_measurements ?? 0,
      row.provider_cost_usd_ticks ?? 0,
      row.cost_measurements ?? 0,
      row.first_seen_at ?? row.last_seen_at ?? `${String(row.day)}T00:00:00.000Z`,
      row.last_seen_at ?? `${String(row.day)}T00:00:00.000Z`,
      row.api_equivalent_usd_ticks ?? 0,
      row.api_equivalent_measurements ?? 0
    ));
  }

  seedVideoJobs(...rows: Array<Record<string, unknown>>): void {
    for (const row of rows) {
      const userId = String(row.user_id ?? "retention_user");
      this.ensureUser(userId, null);
      this.sqlite.prepare(
        `INSERT INTO video_jobs
           (request_id_hash, user_id, route_profile_id, capability, status,
            video_seconds, outputs, provider_cost_usd_ticks, created_at,
            updated_at, terminal_at, usage_finalized_at)
         VALUES (?, ?, 'grok.production.videos_generations', 'video_generation',
                 'pending', NULL, NULL, NULL, ?, ?, NULL, NULL)`
      ).run(...sqliteValues(row.request_id_hash, userId, row.updated_at, row.updated_at));
    }
  }

  seedUsageSummary(_totals: UsageSummaryTotals, rows: UsageSummaryRow[]): void {
    this.sqlite.exec("DELETE FROM usage_daily");
    for (const row of rows) {
      if (row.first_day !== row.last_day) {
        this.seedUsage({
          ...row,
          day: row.first_day,
          requests: 0,
          ok_requests: 0,
          error_requests: 0,
          input_tokens: 0,
          cached_input_tokens: 0,
          output_tokens: 0,
          reasoning_tokens: 0,
          total_tokens: 0,
          token_measurements: 0,
          provider_cost_usd_ticks: 0,
          cost_measurements: 0,
          first_seen_at: `${row.first_day}T00:00:00.000Z`,
          last_seen_at: `${row.first_day}T00:00:00.000Z`
        });
      }
      this.seedUsage({ ...row, day: row.last_day, first_seen_at: row.last_seen_at });
    }
  }

  seedMediaUsageSummary(_totals: MediaUsageSummaryTotals, rows: MediaUsageSummaryRow[]): void {
    this.sqlite.exec("DELETE FROM media_usage_daily");
    for (const row of rows) {
      const userId = String(row.user_id);
      this.ensureUser(userId, row.email ?? null);
      this.sqlite.prepare(
        `INSERT INTO media_usage_daily
           (user_id, day, route_profile_id, capability, started_jobs,
            completed_jobs, failed_jobs, expired_jobs, outputs, video_seconds,
            output_measurements, duration_measurements, provider_cost_usd_ticks,
            cost_measurements, first_seen_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(...sqliteValues(
        userId,
        row.last_day,
        row.route_profile_id,
        row.capability,
        row.started_jobs,
        row.completed_jobs,
        row.failed_jobs,
        row.expired_jobs,
        row.outputs,
        row.video_seconds,
        row.output_measurements,
        row.duration_measurements,
        row.provider_cost_usd_ticks,
        row.cost_measurements,
        `${row.first_day}T00:00:00.000Z`,
        row.last_seen_at
      ));
    }
  }

  setOrganizationAllowance(amount: number): void {
    this.sqlite.prepare(
      "UPDATE organization_surface_credit_defaults SET monthly_allowance = ?"
    ).run(amount);
  }

  seedConsoleUser(input: {
    id: string;
    email: string | null;
    role?: "admin" | "user";
    status?: string;
    loginCapable?: boolean;
    canonicalEmail?: string | null;
  }): void {
    const loginCapable = input.loginCapable ?? true;
    const canonical = input.canonicalEmail === undefined
      ? (typeof input.email === "string" ? input.email.trim().toLowerCase() : null)
      : input.canonicalEmail;
    this.sqlite.prepare(
      `INSERT INTO users (id, email, canonical_email, role, status, login_capable, account_kind, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, '2026-06-01T00:00:00.000Z', '2026-06-01T00:00:00.000Z')`
    ).run(
      input.id,
      input.email,
      canonical,
      input.role ?? "user",
      input.status ?? "active",
      loginCapable ? 1 : 0,
      loginCapable ? "human" : "legacy_unresolved"
    );
  }

  private ensureUser(id: string, email: unknown): void {
    this.sqlite.prepare(
      `INSERT OR IGNORE INTO users (id, email, status, created_at, updated_at)
       VALUES (?, ?, 'active', '2026-06-01T00:00:00.000Z', '2026-06-01T00:00:00.000Z')`
    ).run(id, email as SQLInputValue);
  }

  private tableRows(table: string): Array<Record<string, unknown>> {
    try {
      return this.sqlite.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all() as Array<Record<string, unknown>>;
    } catch {
      return [];
    }
  }

  private tableMap(
    table: string,
    key: (row: Record<string, unknown>) => string
  ): Map<string, Record<string, unknown>> {
    return new Map(this.tableRows(table).map((row) => [key(row), row]));
  }
}

function sqliteValues(...values: unknown[]): SQLInputValue[] {
  return values as SQLInputValue[];
}
