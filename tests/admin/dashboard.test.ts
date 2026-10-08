import { JSDOM } from "jsdom";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { adminDashboardResponse } from "../../src/admin/dashboard";
import type { CodexAccountSnapshot } from "../../src/codex/account";
import { makeFixture } from "../router/fixture";
import { createTestD1, type TestD1 } from "../support/sqlite-d1";

function emptyEnv(): Env {
  return dashboardFixture().env;
}

function dashboardFixture(): { env: Env; db: DashboardTestDatabase } {
  const preparedSql: string[] = [];
  const testDb = createTestD1({ onPrepare: (sql) => preparedSql.push(sql) });
  onTestFinished(() => testDb.close());
  const db = new DashboardTestDatabase(testDb, preparedSql);
  return {
    db,
    env: makeFixture({env: {DB: testDb.binding}}).env
  };
}

interface DashboardUsageSeed {
  first_day?: string;
  day: string;
  user_id: string;
  email?: string;
  route_profile_id: string;
  response_model: string;
  requests: number;
  ok_requests: number;
  error_requests: number;
  input_tokens: number;
  cached_input_tokens: number;
  output_tokens: number;
  reasoning_tokens: number;
  total_tokens: number;
  token_measurements: number;
  provider_cost_usd_ticks: number;
  cost_measurements: number;
  last_seen_at: string;
}

interface DashboardMediaSeed {
  day: string;
  user_id: string;
  email?: string;
  route_profile_id: string;
  capability: string;
  started_jobs: number;
  completed_jobs: number;
  failed_jobs: number;
  expired_jobs: number;
  outputs: number;
  video_seconds: number;
  output_measurements: number;
  duration_measurements: number;
  provider_cost_usd_ticks: number;
  cost_measurements: number;
  last_seen_at: string;
}

class DashboardTestDatabase {
  private auditSequence = 0;

  constructor(
    private readonly testDb: TestD1,
    readonly preparedSql: string[]
  ) {}

  seedUser(input: {
    id: string;
    email?: string;
    account_kind?: "human";
    status?: string;
    created_at?: string;
  }): void {
    const createdAt = input.created_at ?? "2026-01-01T00:00:00.000Z";
    this.testDb.sqlite.prepare(
      `INSERT OR REPLACE INTO users (id, email, canonical_email, account_kind, login_capable, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(input.id, input.email ?? null, input.account_kind === "human" ? input.email ?? null : null,
      input.account_kind ?? "legacy_unresolved", input.account_kind === "human" ? 1 : 0,
      input.status ?? "active", createdAt, createdAt);
  }

  seedCodexAuth(id = "auth_dashboard", status = "active", expiresAt: string | null = null): void {
    const createdAt = "2026-01-01T00:00:00.000Z";
    this.testDb.sqlite.prepare(
      `INSERT INTO codex_auths
         (id, kind, label, environment, status, expires_at, created_at, updated_at)
       VALUES (?, 'shared', 'Dashboard ChatGPT', 'production', ?, ?, ?, ?)`
    ).run(id, status, expiresAt, createdAt, createdAt);
  }

  seedGrokAccount(status: string, expiresAt: string | null): void {
    const createdAt = "2026-01-01T00:00:00.000Z";
    this.testDb.sqlite.prepare(
      `INSERT INTO subscription_accounts
         (id, capability_source, environment, label, status, expires_at, created_at, updated_at)
       VALUES ('home-grok', 'grok', 'production', 'Dashboard Grok', ?, ?, ?, ?)`
    ).run(status, expiresAt, createdAt, createdAt);
  }

  seedApiKeys(...rows: Array<{
    id: string;
    user_id: string;
    key_prefix: string;
    status?: string;
    scopes: readonly string[];
    expires_at?: string | null;
    last_used_at?: string | null;
    created_at: string;
  }>): void {
    const statement = this.testDb.sqlite.prepare(
      `INSERT INTO api_keys
         (id, user_id, key_prefix, key_hash, status, scopes, expires_at,
          last_used_at, created_at, revoked_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`
    );
    for (const row of rows) {
      statement.run(
        row.id,
        row.user_id,
        row.key_prefix,
        `hash_${row.id}`,
        row.status ?? "active",
        JSON.stringify(row.scopes),
        row.expires_at ?? null,
        row.last_used_at ?? null,
        row.created_at
      );
    }
  }

  seedAudits(...rows: Array<{
    plan: string;
    status: "ok" | "error";
    at: string;
    upstream: number;
    user_id?: string;
    key_id?: string;
  }>): void {
    const statement = this.testDb.sqlite.prepare(
      `INSERT INTO request_audit
         (id, request_id, route_profile_id, user_id, status, upstream_status,
          latency_ms, created_at, key_id)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`
    );
    for (const row of rows) {
      const userId = row.user_id ?? "usr_dashboard";
      this.ensureUser(userId);
      this.auditSequence += 1;
      statement.run(
        `audit_${this.auditSequence}`,
        `request_${this.auditSequence}`,
        row.plan,
        userId,
        row.status,
        row.upstream,
        row.at,
        row.key_id ?? null
      );
    }
  }

  seedUsageRows(...rows: DashboardUsageSeed[]): void {
    const statement = this.testDb.sqlite.prepare(
      `INSERT INTO usage_daily
         (user_id, day, route_profile_id, response_model, requests, ok_requests,
          error_requests, input_tokens, cached_input_tokens, output_tokens,
          reasoning_tokens, total_tokens, token_measurements,
          provider_cost_usd_ticks, cost_measurements, first_seen_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (const row of rows) {
      this.ensureUser(row.user_id, row.email);
      const firstDay = row.first_day ?? row.day;
      if (firstDay !== row.day) {
        statement.run(
          row.user_id,
          firstDay,
          row.route_profile_id,
          row.response_model,
          0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
          `${firstDay}T00:00:00.000Z`,
          `${firstDay}T00:00:00.000Z`
        );
      }
      statement.run(
        row.user_id,
        row.day,
        row.route_profile_id,
        row.response_model,
        row.requests,
        row.ok_requests,
        row.error_requests,
        row.input_tokens,
        row.cached_input_tokens,
        row.output_tokens,
        row.reasoning_tokens,
        row.total_tokens,
        row.token_measurements,
        row.provider_cost_usd_ticks,
        row.cost_measurements,
        `${firstDay}T00:00:00.000Z`,
        row.last_seen_at
      );
    }
  }

  seedMediaRows(...rows: DashboardMediaSeed[]): void {
    const statement = this.testDb.sqlite.prepare(
      `INSERT INTO media_usage_daily
         (user_id, day, route_profile_id, capability, started_jobs,
          completed_jobs, failed_jobs, expired_jobs, outputs, video_seconds,
          output_measurements, duration_measurements, first_seen_at, last_seen_at,
          provider_cost_usd_ticks, cost_measurements)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (const row of rows) {
      this.ensureUser(row.user_id, row.email);
      statement.run(
        row.user_id,
        row.day,
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
        `${row.day}T00:00:00.000Z`,
        row.last_seen_at,
        row.provider_cost_usd_ticks,
        row.cost_measurements
      );
    }
  }

  private ensureUser(id: string, email?: string): void {
    this.testDb.sqlite.prepare(
      `INSERT OR IGNORE INTO users (id, email, status, created_at, updated_at)
       VALUES (?, ?, 'active', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`
    ).run(id, email ?? null);
  }
}

const softFailAccount: CodexAccountSnapshot = {
  profile: {status: "unavailable"},
  usage: {status: "unavailable"},
  resetCredits: {status: "unavailable"}
};

describe("Dashboard", () => {
  it.each([["codex", "Codex"], ["grok", "Grok"], ["xai", "xAI API"]])("reports a %s binding update as that operation, not provider refresh", async (surface, label) => {
    const { env } = dashboardFixture();
    const render = async (kind: "credential_binding" | "grok_refreshed") => (await adminDashboardResponse({
      env, url: new URL("https://admin.example.test/admin?view=access"),
      identity: { kind: "console", email: "op@example.com", subject: "sub" },
      now: new Date("2026-07-28T12:00:00.000Z"), requestId: "binding-outcome",
      mutationFlash: kind === "credential_binding" ? { kind, key_id: "key-one", surface_grant: `surface:${surface}:production` } : { kind, account_id: "grok-one" },
      loadCodexAccount: async () => softFailAccount
    })).text();
    const binding = await render("credential_binding");
    const notice = new JSDOM(binding).window.document.querySelector('[data-mutation-flash="credential_binding"]');
    expect(notice?.getAttribute("role")).toBe("status");
    expect(notice?.querySelector("h2")?.textContent).toBe(`${label} 上游绑定已更新`);
    expect(notice?.querySelector("code")?.textContent).toBe("key-one");
    expect(binding).not.toContain("Grok 已刷新");
    const refreshed = await render("grok_refreshed");
    expect(refreshed).toContain("Grok 已刷新");
    expect(refreshed).not.toContain("账号已更新。");
  });

  it.each([
    [null, false],
    ["2026-07-28T12:00:00.001Z", false],
    ["2026-07-28T12:00:00.000Z", true],
    ["2026-07-27T12:00:00.000Z", true]
  ])("shows effective key expiry for %s", async (expires_at, expired) => {
    const { env, db } = dashboardFixture();
    db.seedUser({ id: "Alex", email:"alex@example.com", account_kind: "human" });
    db.seedApiKeys({ id: "key-alex", user_id: "Alex", key_prefix: "preview_alex", scopes: ["surface:codex:production"], expires_at, created_at: "2026-07-01T00:00:00.000Z" });
    for (const view of ["access", "setup"]) {
      const response = await adminDashboardResponse({
        env, url: new URL(`https://admin.example.test/admin?view=${view}${view === "access" ? "&person=Alex" : ""}`),
        identity: { kind: "console", email: "op@example.com", subject: "sub" },
        now: new Date("2026-07-28T12:00:00.000Z"), requestId: "key-expiry",
        loadCodexAccount: async () => softFailAccount
      });
      expect(response.status).toBe(200);
      const html = await response.text();
      const keyRow = html.match(/<(?:tr|li)[^>]*data-(?:setup-)?key-id="key-alex"[\s\S]*?<\/(?:tr|li)>/)?.[0];
      expect(keyRow).toBeDefined();
      if (expired) {
        expect(keyRow).toContain("已过期");
        expect(keyRow).not.toMatch(/data-action="(?:replace-key|create-setup-package)"/);
        if (view === "access") {
          expect(new JSDOM(html).window.document.querySelector('[data-user-id="Alex"] [data-access-state="expired"] .sr-only')?.textContent).toBe("：密钥已过期");
          expect(html).toContain('data-access-client="codex" data-access-state="expired"');
          expect(keyRow).toContain('aria-label="管理密钥 preview_alex"');
        }
      } else {
        expect(keyRow).toContain("有效");
        expect(keyRow).not.toContain("<form");
        if (view === "access") expect(html).toContain('data-access-client="codex" data-access-state="granted"');
      }
    }
  });

  it("keeps active grants with a valid key and marks a disabled person's retained grants paused", async () => {
    const { env, db } = dashboardFixture();
    db.seedUser({ id: "Alex", email:"alex@example.com", account_kind: "human" });
    db.seedUser({ id: "Morgan", email:"morgan@example.com",status:"disabled", account_kind: "human" });
    db.seedApiKeys(...[
      { id: "alex-expired", user_id: "Alex", expires_at: "2026-07-01T00:00:00.000Z" },
      { id: "alex-valid", user_id: "Alex" },
      { id: "morgan-valid", user_id: "Morgan" },
      { id: "morgan-revoked", user_id: "Morgan", status: "revoked", scopes: ["surface:grok:production"] }
    ].map((key) => ({ key_prefix: key.id, scopes: ["surface:codex:production"], created_at: "2026-07-01T00:00:00.000Z", ...key })));
    db.seedAudits({ user_id: "Morgan", key_id: "morgan-valid", plan: "codex.responses", status: "ok", upstream: 200, at: "2026-07-28T10:00:00.000Z" });
    const render = async (view: string) => (await adminDashboardResponse({
      env, url: new URL(`https://admin.example.test/admin?view=${view}`),
      identity: { kind: "console", email: "op@example.com", subject: "sub" },
      now: new Date("2026-07-28T12:00:00.000Z"), requestId: "key-paused",
      loadCodexAccount: async () => softFailAccount
    })).text();
    const people = await render("access");
    const peopleDocument = new JSDOM(people).window.document;
    expect(peopleDocument.querySelector('[data-user-id="Alex"] [data-access-state="granted"] .sr-only')?.textContent).toBe("：密钥有效");
    const paused = peopleDocument.querySelector('[data-user-id="Morgan"]');
    expect(paused?.querySelector('[data-enabled="false"]')?.textContent).toBe("已停用");
    expect(paused?.querySelector('[data-access-state="paused"] .sr-only')?.textContent).toBe("：账号已停用");
    expect([...paused!.querySelectorAll('[data-access-state]')].map(badge=>badge.firstChild?.textContent)).toEqual(["Codex"]);
    const activeDetail = await render("access&person=Alex");
    expect(activeDetail).toContain('data-access-client="codex" data-access-state="granted"');
    const pausedDetail = await render("access&person=Morgan");
    expect(pausedDetail).toContain('data-access-client="codex" data-access-state="paused"');
    expect(pausedDetail).toContain('data-access-client="grok" data-access-state="none"');
    expect(pausedDetail).toContain('data-access-client="xai" data-access-state="none"');
    const setup = await render("setup&person=Morgan&key=morgan-valid");
    const keyRow = setup.match(/<li[^>]*data-setup-key-id="morgan-valid"[\s\S]*?<\/li>/)?.[0];
    expect(keyRow).toContain("已暂停 — 人员已停用");
    expect(setup).toContain("最近任务成功 2026-07-28 10:00 UTC");
    expect(setup).not.toContain('data-setup-key-id="morgan-revoked"');
  });

  it("preserves the exact person in fresh-access links and never defaults a missing person to someone else", async () => {
    const { env, db } = dashboardFixture();
    const person = "张 & Morgan / Ops ".repeat(7).trim();
    db.seedUser({ id: person });
    db.seedUser({ id: "Alex", email:"alex@example.com", account_kind: "human" });
    db.seedApiKeys({ id: "expired-target", user_id: person, key_prefix: "preview_target", scopes: ["surface:codex:production"], expires_at: "2026-07-01T00:00:00.000Z", created_at: "2026-07-01T00:00:00.000Z" });
    const render = async (url: string) => (await adminDashboardResponse({
      env, url: new URL(url), identity: { kind: "console", email: "op@example.com", subject: "sub" },
      now: new Date("2026-07-28T12:00:00.000Z"), requestId: "key-target",
      loadCodexAccount: async () => softFailAccount
    })).text();
    const setup = await render(`https://admin.example.test/admin?view=setup&person=${encodeURIComponent(person)}&key=expired-target`);
    expect(setup).toContain(`href="/admin?view=access&amp;range=7d&amp;person=${encodeURIComponent(person)}&amp;task=give-access#give-access"`);
    const selected = await render(`https://admin.example.test/admin?view=access&range=30d&person=${encodeURIComponent(person)}&task=give-access`);
    expect(selected).toContain(`<input type="hidden" name="user_id" value="${person.replaceAll("&", "&amp;")}"/>`);
    expect(selected).toContain(`data-dashboard-url="/admin?view=access&amp;range=30d&amp;person=${encodeURIComponent(person)}&amp;task=give-access"`);
    expect(new JSDOM(selected).window.document.querySelector("a[data-discard-draft]")?.getAttribute("href")).toBe(`/admin?view=access&range=30d&person=${encodeURIComponent(person)}#keys`);
    const missing = await render("https://admin.example.test/admin?view=access&person=missing&task=give-access");
    expect(missing).toContain('未显示人员');
    expect(missing).not.toContain('name="user_id"');
    expect(missing).not.toContain('data-action="credit-set"');
  });

  it("keeps each person's actions and keys inside their selected detail", async () => {
    const { env, db } = dashboardFixture();
    for (const id of ["Alex", "Morgan"]) {
      db.seedUser({ id, email:`${id.toLowerCase()}@example.com`, account_kind: "human" });
      db.seedApiKeys({ id: `key-${id}`, user_id: id, key_prefix: `preview_${id}`, scopes: ["surface:codex:production"], created_at: "2026-07-01T00:00:00.000Z" });
    }
    const render = async (query = "") => (await adminDashboardResponse({
      env, url: new URL(`https://admin.example.test/admin?view=access${query}`),
      identity: { kind: "console", email: "op@example.com", subject: "sub" },
      now: new Date("2026-07-28T12:00:00.000Z"), requestId: "person-selection",
      loadCodexAccount: async () => softFailAccount
    })).text();
    const list = await render();
    expect(list).toContain('person=Alex');
    expect(list).toContain('person=Morgan');
    expect(new JSDOM(list).window.document.querySelectorAll('.people-table form')).toHaveLength(0);
    const selected = await render("&person=Alex");
    const detail = new JSDOM(selected).window.document.querySelector('[data-person-detail="Alex"]')?.outerHTML ?? "";
    expect(detail).toContain('data-person-access-summary');
    expect(detail).toContain('person=Alex&amp;task=give-access');
    expect(detail).not.toContain('action="/admin/ui/keys"');
    expect(detail).toContain('data-key-id="key-Alex"');
    expect(detail).toContain('key=key-Alex');
    const keyDetail = await render("&person=Alex&key=key-Alex");
    expect(keyDetail).toContain('action="/admin/ui/keys/key-Alex/revoke?person=Alex"');
    expect(keyDetail).toContain('action="/admin/ui/keys/key-Alex/credential-bindings/codex?person=Alex"');
    expect(detail.match(/data-action="credit-set"/g)).toHaveLength(6);
    const creditDoc = new JSDOM(detail).window.document;
    expect(creditDoc.querySelectorAll('form[data-action="credit-set"]:has(select[name=mode])')).toHaveLength(3);
    expect(creditDoc.querySelectorAll('form[data-action="credit-set"]:has(input[name=mode][value=disabled])')).toHaveLength(3);
    expect(detail).not.toContain('Morgan');
    expect(detail).not.toContain('Filter keys');
    expect(detail).not.toContain('Filter credit');
    const task = await render("&person=Alex&task=give-access");
    expect(task).toContain('<title>创建密钥 · Agency Relay 控制台</title>');
    expect(task).toContain('data-dashboard-url="/admin?view=access&amp;range=7d&amp;person=Alex&amp;task=give-access"');
    expect(task).toContain('name="user_id" value="Alex"');
    expect(task).toContain('data-dashboard-draft="access" data-draft-scope="Alex"');
    expect(new JSDOM(task).window.document.querySelector("a[aria-label=\"收起创建密钥\"]")?.getAttribute("href")).toContain("person=Alex");
    expect(new JSDOM(task).window.document.querySelector("a[data-discard-draft]")?.textContent).toBe("取消");
    expect(new JSDOM(task).window.document.querySelector('[data-key-id="key-Alex"]')).not.toBeNull();
    expect(new JSDOM(task).window.document.querySelector('[data-action="credit-set"]')).not.toBeNull();
    expect(new JSDOM(task).window.document.querySelector('[data-action="user-status"]')).not.toBeNull();
    const adding = await render("&task=add-person");
    expect(adding).toContain('action="/admin/ui/users"');
    expect(adding).toContain('>取消</a>');
    expect(adding).not.toContain('name="user_id"');
    expect(adding).toContain('data-dashboard-url="/admin?view=access&amp;range=7d&amp;task=add-person"');
  });

  it.each(["view=access&task=unknown", "view=overview&task=add-person", "view=access&task=add-person&task=add-person", "view=access&task=give-access", "view=access&task=give-access&person=", "view=setup&task=give-access&person=Alex"])("rejects an invalid task query %s", async (query) => {
    const response = await adminDashboardResponse({
      env: emptyEnv(), url: new URL(`https://admin.example.test/admin?${query}`),
      identity: { kind: "console", email: "op@example.com", subject: "sub" },
      now: new Date("2026-07-28T12:00:00.000Z"), requestId: "invalid-task", loadCodexAccount: async () => softFailAccount
    });
    expect(response.status).toBe(400);
  });

  it.each([
    ["overview", "users"],
    ["overview", "api_keys"],
    ["overview", "codex_auths"],
    ["overview", "subscription_accounts"],
    ["overview", "request_audit"],
    ["credentials", "subscription_accounts"],
    ["access", "users"],
    ["access", "api_keys"],
    ["setup", "api_keys"],
    ["audit", "request_audit"],
    ["surfaces", "request_audit"],
    ["usage", "usage_daily"]
  ])("shows unavailable %s data when %s cannot be read", async (view, table) => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    onTestFinished(() => log.mockRestore());
    const testDb = createTestD1({ onPrepare: (sql) => {
      if (sql.includes(table)) throw new Error("private read failure details");
    } });
    onTestFinished(() => testDb.close());
    const response = await adminDashboardResponse({
      env: makeFixture({env: {DB: testDb.binding}}).env,
      url: new URL(`https://admin.example.test/admin?view=${view}`),
      identity: { kind: "console", email: "op@example.com", subject: "sub" },
      now: new Date("2026-07-28T12:00:00.000Z"), requestId: "read-failed",
      loadCodexAccount: async () => softFailAccount
    });
    expect(response.status).toBe(503);
    const html = await response.text();
    expect(html).toContain("data-dashboard-unavailable");
    expect(html).toContain('aria-label="控制台页面"');
    expect(html).toContain(`href="/admin?view=${view}&amp;range=7d"`);
    expect(html).toContain(">重试<");
    expect(html).not.toContain("Nothing needs attention");
    expect(html).not.toContain("这个分类下还没有账号。");
    expect(html).not.toContain("还没有可用的访问。");
    expect(html).not.toContain('class="view-observed"');
    expect(html).not.toContain("private read failure details");
    expect(JSON.stringify(log.mock.calls)).not.toContain("private read failure details");
  });

  it("retains an input error when the following dashboard read is unavailable", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    onTestFinished(() => log.mockRestore());
    const db = createTestD1({ onPrepare: () => { throw new Error("Synthetic read failure"); } });
    onTestFinished(() => db.close());
    const response = await adminDashboardResponse({
      env: makeFixture({env: {DB: db.binding}}).env,
      url: new URL("https://admin.example.test/admin?view=access"),
      identity: { kind: "console", email: "op@example.com", subject: "sub" },
      now: new Date("2026-09-12T09:00:00Z"), requestId: "input-read-failure",
      loadCodexAccount: async () => softFailAccount,
      mutationFlash: { kind: "user_create_error", email: "", message: "请填写有效的组织邮箱。" }
    });
    const html = await response.text();
    expect(response.status).toBe(503);
    expect(html).toContain('data-dashboard-mutation="user_create_error"');
    expect(new JSDOM(html).window.document.querySelector("[data-mutation-input-error]")?.textContent).toBe("请填写有效的组织邮箱。");
    expect(html).not.toContain('data-mutation-flash="user_created"');
  });

  it("keeps a completed setup package available when the following read fails", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    onTestFinished(() => log.mockRestore());
    const testDb = createTestD1({ onPrepare: () => { throw new Error("read unavailable"); } });
    onTestFinished(() => testDb.close());
    const response = await adminDashboardResponse({
      env: makeFixture({env: {DB: testDb.binding}}).env,
      url: new URL("https://admin.example.test/admin?view=setup"),
      identity: { kind: "console", email: "op@example.com", subject: "sub" },
      now: new Date("2026-07-28T12:00:00.000Z"), requestId: "read-after-create",
      loadCodexAccount: async () => softFailAccount,
      mutationFlash: { kind: "key_created", token: "cfwd_test_only", key_id: "key-test", key_prefix: "cfwd_test", user_id: "Alex", scopes: ["surface:codex:production"] }
    });
    expect(response.status).toBe(503);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const html = await response.text();
    expect(html).toContain('data-one-time-key="true"');
    expect(html).toContain('data-dashboard-mutation="key_created"');
    expect(html).toContain('download="codex-config.toml"');
    expect(html).toContain("data-dashboard-unavailable");
    expect(html).toContain('href="/admin?view=setup&amp;range=7d&amp;person=Alex&amp;key=key-test"');
    expect(html).toContain(">重试<");
    expect(html).toContain('data-dashboard-url="/admin?view=setup&amp;range=7d&amp;person=Alex&amp;key=key-test"');
    expect(JSON.stringify(log.mock.calls)).not.toContain("cfwd_test_only");
  });

  it("verifies each setup key only from its own person, client, and real-task observations", async () => {
    const { env, db } = dashboardFixture();
    db.seedUser({ id: "Alex" });
    db.seedApiKeys(...["old-key", "new-key"].map((id) => ({
      id, user_id: "Alex", key_prefix: id,
      scopes: ["surface:codex:production", "surface:grok:production"],
      created_at: "2026-07-28T00:00:00.000Z"
    })));
    db.seedAudits(
      { user_id: "Alex", key_id: "old-key", plan: "codex.responses", status: "ok", at: "2026-07-28T10:00:00.000Z", upstream: 200 },
      { user_id: "Alex", plan: "codex.responses", status: "ok", at: "2026-07-28T11:00:00.000Z", upstream: 200 },
      { user_id: "Morgan", key_id: "new-key", plan: "codex.responses", status: "ok", at: "2026-07-28T11:00:00.000Z", upstream: 200 },
      { user_id: "Alex", key_id: "new-key", plan: "codex.models", status: "ok", at: "2026-07-28T11:00:00.000Z", upstream: 200 },
      { user_id: "Alex", key_id: "new-key", plan: "grok.production.models", status: "ok", at: "2026-07-28T11:00:00.000Z", upstream: 200 }
    );
    const render = async (key: string) => (await adminDashboardResponse({
      env, url: new URL(`https://admin.example.test/admin?view=setup&person=Alex&key=${key}`),
      identity: { kind: "console", email: "op@example.com", subject: "sub" },
      now: new Date("2026-07-28T12:00:00.000Z"), requestId: "req_setup_key",
      loadCodexAccount: async () => softFailAccount
    })).text();
    expect(await render("old-key")).toContain('data-client-verification="codex" data-result="works"');
    const initial = await render("new-key");
    expect(initial).toContain('data-client-verification="codex" data-result="not-verified"');
    expect(initial).toContain('data-client-verification="grok" data-result="not-verified"');
    expect(initial).not.toContain('data-result="works"');

    db.seedAudits(
      { user_id: "Alex", key_id: "new-key", plan: "codex.responses", status: "error", at: "2026-07-28T11:05:00.000Z", upstream: 500 },
      { user_id: "Alex", key_id: "new-key", plan: "codex.responses", status: "ok", at: "2026-07-28T11:10:00.000Z", upstream: 200 },
      { user_id: "Alex", key_id: "new-key", plan: "grok.production.responses", status: "ok", at: "2026-07-28T11:10:00.000Z", upstream: 200 },
      { user_id: "Alex", key_id: "new-key", plan: "grok.production.responses", status: "error", at: "2026-07-28T11:15:00.000Z", upstream: 500 }
    );
    const verified = await render("new-key");
    expect(verified).toContain('data-client-verification="codex" data-result="works"');
    expect(verified).toContain("最近任务成功 2026-07-28 11:10 UTC");
    expect(verified).toContain('data-client-verification="grok" data-result="failed"');
    expect(verified).toContain("最近任务失败 2026-07-28 11:15 UTC");
  });

  it("renders Home with distinct organization and personal navigation", async () => {
    const env = emptyEnv();
    const response = await adminDashboardResponse({
      env,
      url: new URL("https://admin.example.test/admin?view=overview&range=7d"),
      identity: { kind: "console", email: "op@example.com", subject: "sub" },
      now: new Date("2026-07-28T12:00:00.000Z"),
      requestId: "req_v3_pulse",
      loadCodexAccount: async () => softFailAccount
    });
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('data-dashboard-nav="vertical"');

    expect(html).toContain('data-nav-group="workspace"');
    expect(html).toContain('data-nav-group="resources"');
    expect(html).toContain('data-nav-group="observation"');
    expect(html).toContain('data-nav-group="advanced"');
    const document = new JSDOM(html).window.document;
    const navigation = document.querySelector('[role="navigation"].nav-rail');
    expect(navigation?.querySelector('a[href="/admin?area=me&view=home"]')?.textContent).toBe("我的空间");
    expect(navigation?.querySelector('a[href*="view=quotas"]')?.textContent).toBe("额度政策");
    expect(navigation?.querySelector('a[href*="view=control-audit"]')?.textContent).toBe("管理记录");
    expect(document.querySelector('.site-header [data-dashboard-refresh]')).toBeNull();
    expect(document.querySelector('main')?.getAttribute('data-console-read-url')).toBe('/admin?view=overview&range=7d');
    expect(document.querySelector('[data-panel="attention"]')).toBeNull();
    expect(document.querySelector('.account-onboarding a')?.getAttribute("href")).toBe("/admin?view=credentials&range=7d&task=add-account");
    expect(document.querySelector("main")?.textContent).not.toContain("下一步");
    expect(document.querySelector("[data-trend-empty]")).toBeNull();
    expect(document.querySelector("#usage-trends .usage-bar-plot")).not.toBeNull();
    expect(html).not.toMatch(/class="metrics metrics-secondary"/);
    expect(html).not.toContain("Production ready");
    expect(html).not.toContain("page-purpose");
    expect(html).not.toContain("ADMIN_SECRET");
    expect(html).not.toContain("data-provider-form");
  });

  it("links only unresolved request failures from Home to exact request filters", async () => {
    const { env, db } = dashboardFixture();
    db.seedAudits(
      { plan: "grok.production.responses", status: "ok", at: "2026-07-29T11:00:00.000Z", upstream: 200 },
      { plan: "grok.production.responses", status: "ok", at: "2026-07-29T10:30:00.000Z", upstream: 200 },
      { plan: "grok.production.responses", status: "error", at: "2026-07-29T10:00:00.000Z", upstream: 500 },
      { plan: "codex.responses", status: "ok", at: "2026-07-29T09:00:00.000Z", upstream: 200 },
      { plan: "codex.responses", status: "error", at: "2026-07-29T11:30:00.000Z", upstream: 500 }
    );
    const response = await adminDashboardResponse({
      env,
      url: new URL("https://admin.example.test/admin?view=overview"),
      identity: { kind: "console", email: "op@example.com", subject: "sub" },
      now: new Date("2026-07-29T12:00:00.000Z"),
      requestId: "req_latest_real_task",
      loadCodexAccount: async () => softFailAccount
    });
    const html = await response.text();
    const attention = new JSDOM(html).window.document.querySelector('[data-panel="attention"]')!;
    expect(attention.textContent).toContain("Codex1 次失败");
    expect(attention.textContent).not.toContain("Grok1 次失败");
    const attentionLink = attention.querySelector('a')!;
    const failureUrl = new URL(attentionLink.getAttribute('href')!, 'https://console.invalid');
    expect(failureUrl.searchParams.get('audit_plan')).toBe('codex.responses');
    expect(failureUrl.searchParams.get('audit_result')).toBe('error');
    expect(failureUrl.searchParams.get('audit_from')).toBe('2026-07-29');
    expect(failureUrl.searchParams.get('audit_to')).toBe('2026-07-29');
  });

  it("keeps Home account recovery distinct from observed request failures", async () => {
    const { env, db } = dashboardFixture();
    db.seedCodexAuth("disconnected", "revoked");
    db.seedAudits(
      { plan: "codex.responses", status: "ok", at: "2026-07-29T09:00:00.000Z", upstream: 200 },
      { plan: "codex.models", status: "error", at: "2026-07-29T11:00:00.000Z", upstream: 500 },
      { plan: "grok.production.models", status: "ok", at: "2026-07-29T11:00:00.000Z", upstream: 200 }
    );
    const render = async () => (await adminDashboardResponse({
      env, url: new URL("https://admin.example.test/admin?view=overview"),
      identity: { kind: "console", email: "op@example.com", subject: "sub" },
      now: new Date("2026-07-29T12:00:00.000Z"), requestId: "req_home_probes",
      loadCodexAccount: async () => softFailAccount
    })).text();
    const first = new JSDOM(await render()).window.document;
    const failurePlans = (document: Document) => [...document.querySelectorAll('[data-attention="client-failure"] a')].map(link => new URL(link.getAttribute("href")!, "https://console.invalid").searchParams.get("audit_plan"));
    expect(first.querySelector('[data-home-account="chatgpt"]')?.textContent).toContain("已断开");
    expect(failurePlans(first)).toEqual(["codex.models"]);
    db.seedAudits(
      { plan: "grok.production.responses", status: "error", at: "2026-07-29T10:00:00.000Z", upstream: 500 }
    );
    const second = new JSDOM(await render()).window.document;
    expect(second.querySelector('[data-home-account="chatgpt"]')?.textContent).toContain("已断开");
    expect(failurePlans(second)).toEqual(["codex.models", "grok.production.responses"]);
  });

  it.each([
    ["active", null, "已连接", false],
    ["active", "2026-07-29T12:05:00.000Z", "即将过期", true],
    ["active", "2026-07-29T12:00:00.000Z", "访问已过期", true],
    ["active", "2026-07-29T09:00:00.000Z", "访问已过期", true],
    ["degraded", null, "需要处理", true],
    ["refresh_error", null, "需要处理", true],
    ["reauth_required", null, "需要重新连接", true]
  ] as const)("uses the Accounts recovery state on Home for %s / %s", async (status, expiresAt, label, needsAttention) => {
    const { env, db } = dashboardFixture();
    db.seedCodexAuth("home-account", status, expiresAt);
    db.seedGrokAccount(status, expiresAt);
    const html = await (await adminDashboardResponse({
      env, url: new URL("https://admin.example.test/admin?view=overview"),
      identity: { kind: "console", email: "op@example.com", subject: "sub" },
      now: new Date("2026-07-29T12:00:00.000Z"), requestId: "req_home_account",
      loadCodexAccount: async () => softFailAccount
    })).text();
    const account = html.match(/data-home-account="chatgpt"[\s\S]*?<\/article>/)?.[0];
    expect(account).toContain(label);
    expect(html.match(/data-home-account="grok"[\s\S]*?<\/article>/)?.[0]).toContain(label);
    const attention = new JSDOM(html).window.document.querySelector('[data-panel="attention"]')?.outerHTML;
    expect(Boolean(attention?.includes('data-attention="account"'))).toBe(needsAttention);
    if (needsAttention) {
      expect(attention).toContain(label);
      expect(attention).toContain('href="/admin?view=credentials&amp;range=7d&amp;account=codex%3Ahome-account"');
      expect(attention).toContain('account=grok%3Ahome-grok"');
      expect(html).not.toContain('class="next-step"');
      expect(html).not.toContain("连接第一个账号");
    }
  });

  it("keeps first-account onboarding when no existing account needs recovery", async () => {
    const { env } = dashboardFixture();
    const html = await (await adminDashboardResponse({
      env, url: new URL("https://admin.example.test/admin?view=overview"),
      identity: { kind: "console", email: "op@example.com", subject: "sub" },
      now: new Date("2026-07-29T12:00:00.000Z"), requestId: "req_first_account",
      loadCodexAccount: async () => softFailAccount
    })).text();
    const document = new JSDOM(html).window.document;
    expect(document.querySelector(".account-onboarding a")?.textContent).toBe("连接账号");
    expect(document.querySelector('[data-panel="attention"]')).toBeNull();
  });

  it("keeps expired account recovery scoped and distinct from connection or client success", async () => {
    const { env, db } = dashboardFixture();
    db.seedCodexAuth("expired-account", "active", "2026-07-29T09:00:00.000Z");
    db.seedGrokAccount("active", "2026-07-29T09:00:00.000Z");
    const render = async (view: string) => (await adminDashboardResponse({
      env, url: new URL(`https://admin.example.test/admin?view=${view}`),
      identity: { kind: "console", email: "op@example.com", subject: "sub" },
      now: new Date("2026-07-29T12:00:00.000Z"), requestId: "req_expired_accounts",
      loadCodexAccount: async () => softFailAccount
    })).text();
    for (const [attribute, path, selection] of [
      ['data-codex-admin="true"', "/admin/ui/codex-auths/expired-account", "codex:expired-account"],
      ['data-grok-admin="true"', "/admin/ui/subscriptions/home-grok", "grok:home-grok"]
    ]) {
      const accounts = await render(`credentials&account=${encodeURIComponent(selection)}`);
      const cardElement = new JSDOM(accounts).window.document.querySelector(`[${attribute}]`);
      const card = cardElement?.outerHTML;
      expect(card).toBeDefined();
      expect(card).toContain('data-mgmt-state="expired"');
      expect(card).toContain("访问已过期");
      expect(card).toContain("<dt>已过期</dt>");
      expect(card).toContain('2026-07-29 09:00 UTC');
      expect(cardElement?.querySelector('[data-operator-hint="true"]:not([hidden])')).toBeNull();
      expect(cardElement?.querySelector('[data-credential-hint]')?.textContent).toBe("");
      expect(card).toContain(`action="${path}/refresh"`);
      expect(card).toContain(`action="${path}/oauth/start"`);
      expect(card).toContain(`action="${path}/logout"`);
      expect(card).toContain("这会替换当前的账号连接。");
      expect(card).not.toContain("即将过期");
    }
    const home = await render("overview");
    const document = new JSDOM(home).window.document;
    expect(document.querySelector('[data-home-summary] a[href*="credentials"] strong')?.textContent).toBe("2");
    expect(document.querySelector("[data-trend-empty]")).toBeNull();
    expect(document.querySelector("#usage-trends .usage-bar-plot")).not.toBeNull();
    expect(home).not.toContain('class="next-step"');
  });

  it("groups provisional metering by subscription authority without model-only aggregation", async () => {
    const { env, db } = dashboardFixture();
    db.seedUsageRows(
      {
        first_day: "2026-07-22",
        day: "2026-07-24",
        user_id: "usr_1",
        email: "a@example.com",
        route_profile_id: "codex.responses",
        response_model: "gpt-5.1-codex",
        requests: 9,
        ok_requests: 8,
        error_requests: 1,
        input_tokens: 100,
        cached_input_tokens: 10,
        output_tokens: 50,
        reasoning_tokens: 0,
        total_tokens: 150,
        token_measurements: 9,
        provider_cost_usd_ticks: 0,
        cost_measurements: 0,
        last_seen_at: "2026-07-24T00:00:00.000Z"
      },
      {
        day: "2026-07-24",
        user_id: "usr_1",
        email: "a@example.com",
        route_profile_id: "grok.production.responses",
        response_model: "grok-4.5-build",
        requests: 1,
        ok_requests: 1,
        error_requests: 0,
        input_tokens: 10,
        cached_input_tokens: 0,
        output_tokens: 5,
        reasoning_tokens: 0,
        total_tokens: 15,
        token_measurements: 1,
        provider_cost_usd_ticks: 5944000,
        cost_measurements: 1,
        last_seen_at: "2026-07-24T01:00:00.000Z"
      },
      {
        day: "2026-07-22",
        user_id: "usr_legacy_codex",
        email: "legacy-codex@example.com",
        route_profile_id: "codex.historical.responses",
        response_model: "gpt-5.6-sol",
        requests: 3,
        ok_requests: 3,
        error_requests: 0,
        input_tokens: 120000,
        cached_input_tokens: 0,
        output_tokens: 3456,
        reasoning_tokens: 0,
        total_tokens: 123456,
        token_measurements: 0,
        provider_cost_usd_ticks: 0,
        cost_measurements: 0,
        last_seen_at: "2026-07-22T00:30:00.000Z"
      },
      {
        day: "2026-07-22",
        user_id: "usr_legacy",
        email: "legacy@example.com",
        route_profile_id: "N/A",
        response_model: "legacy-model",
        requests: 2,
        ok_requests: 2,
        error_requests: 0,
        input_tokens: 987654,
        cached_input_tokens: 0,
        output_tokens: 0,
        reasoning_tokens: 0,
        total_tokens: 987654,
        token_measurements: 0,
        provider_cost_usd_ticks: 0,
        cost_measurements: 0,
        last_seen_at: "2026-07-22T01:00:00.000Z"
      }
    );
    db.seedMediaRows({
      day: "2026-07-24",
      user_id: "usr_1",
      email: "a@example.com",
      route_profile_id: "xai.production.images_generations",
      capability: "image_generation",
      started_jobs: 1,
      completed_jobs: 1,
      failed_jobs: 0,
      expired_jobs: 0,
      outputs: 1,
      video_seconds: 0,
      output_measurements: 1,
      duration_measurements: 0,
      provider_cost_usd_ticks: 500000000,
      cost_measurements: 1,
      last_seen_at: "2026-07-24T02:00:00.000Z"
    });

    const response = await adminDashboardResponse({
      env,
      url: new URL("https://admin.example.test/admin?view=usage&range=7d"),
      identity: { kind: "console", email: "op@example.com", subject: "sub" },
      now: new Date("2026-07-28T12:00:00.000Z"),
      requestId: "req_v3_usage",
      loadCodexAccount: async () => softFailAccount
    });
    expect(response.status).toBe(200);
    const html = await response.text();
    const document = new JSDOM(html).window.document;
    const records = [...document.querySelectorAll(".usage-record")];
    expect(records).toHaveLength(5);
    const record = (plan: string) => records.find(item => item.getAttribute("data-usage-plan") === plan);
    expect(record("codex.responses")?.getAttribute("data-subscription-authority")).toBe("chatgpt");
    expect(record("grok.production.responses")?.getAttribute("data-subscription-authority")).toBe("grok");
    expect(record("xai.production.images_generations")?.getAttribute("data-subscription-authority")).toBe("xai");
    expect(record("codex.responses")?.querySelector(".usage-record-measurement")?.textContent).toContain("150");
    expect(record("codex.responses")?.querySelector("[popover]")).toBeNull();
    expect(record("grok.production.responses")?.querySelector(".usage-record-cost")?.textContent).toContain("$0.0005944");
    expect(record("xai.production.images_generations")?.querySelector(".usage-record-cost")?.textContent).toContain("$0.05");
    expect(record("codex.historical.responses")?.querySelector(".usage-record-measurement")?.textContent).toContain("未记录");
    expect(record("N/A")?.querySelector(".usage-record-measurement")?.textContent).toContain("未记录");
    expect(record("N/A")?.getAttribute("data-subscription-authority")).toBe("unattributed");
    expect(html).not.toContain("123,456"); expect(html).not.toContain("987,654");
    expect(document.querySelector("a[download]")?.getAttribute("href")).toBe("/admin/usage?from=2026-07-22&to=2026-07-28&limit=1000");
    expect(html).not.toContain("Settled charge");
    expect(html).not.toContain("Invoice");
    expect(html).not.toContain('data-series-primary="true"');
    expect(html).not.toContain('data-metric="tokens"');
    expect(html).not.toContain("vs prior");
  });

  it("renders product pages and advanced diagnostics", async () => {
    const env = emptyEnv();
    for (const [view, markers] of [
      ["surfaces", ['data-view-role="routes"', "data-surfaces-grouped"]],
      ["credentials", ['data-view-role="accounts"', 'class="account-list"', "添加上游账号"]],
      [
        "access",
        [
          'data-view-role="people"',
          'aria-label="人员和客户端访问"',
          '这个分类下还没有账号。',
          'task=add-person'
        ]
      ],
      ["setup", ['data-view-role="setup"', "连接客户端", "搜索账号或密钥"]],
      [
        "audit",
        [
          'aria-label="筛选请求记录"',
          'aria-label="保留的请求记录"',
          'id="request-history-title"'
        ]
      ]
    ] as const) {
      const response = await adminDashboardResponse({
        env,
        url: new URL(`https://admin.example.test/admin?view=${view}`),
        identity: { kind: "admin_secret", email: "op@example.com", subject: null },
        now: new Date("2026-07-28T12:00:00.000Z"),
        requestId: `req_v3_${view}`,
        loadCodexAccount: async () => softFailAccount
      });
      expect(response.status).toBe(200);
      const html = await response.text();
      for (const marker of markers) {
        expect(html).toContain(marker);
      }
      expect(html).not.toContain("ChatGPT Subscription Authorization");
      expect(html).not.toContain("ADMIN_SECRET");
      expect(html).not.toContain("data-key-cards");
      expect(html).not.toContain("key-card");
      expect(html).not.toContain("Recent requests");
      expect(html).not.toContain('aria-label="Recent requests"');
      if (view === "setup") {
        expect(new JSDOM(html).window.document.querySelector('[data-local-config-sync]')?.hasAttribute('hidden')).toBe(true);
        expect(html).not.toContain("/admin/ui/sync");
      }
    }
  });

  it("keeps each exact route, recent-result meaning and native diagnostic details accessible", async () => {
    const response = await adminDashboardResponse({
      env: emptyEnv(), url: new URL("https://admin.example.test/admin?view=surfaces"),
      identity: { kind: "console", email: "op@example.com", subject: "sub" },
      now: new Date("2026-08-02T12:00:00.000Z"), requestId: "req_route_catalog",
      loadCodexAccount: async () => softFailAccount
    });
    expect(response.status).toBe(200);
    const document = new JSDOM(await response.text()).window.document;
    const catalog = document.querySelector('[data-view-role="routes"]')!;
    const codex = catalog.querySelector('[data-route-id="codex.responses"]')!;
    expect(codex.querySelector('.route-method')?.textContent).toBe('POST');
    expect(codex.querySelector('.route-path')?.textContent).toBe('/v1/responses');
    expect(codex.textContent).toContain('尚无记录');
    expect([...catalog.querySelectorAll('th')].map(node => node.textContent)).toContain('最近结果');
    expect(codex.querySelector('button[popovertarget]')?.getAttribute('aria-label')).toBe('请求与授权详情');
    expect(codex.querySelector('[popover]')?.getAttribute('popover')).toBe('auto');
    expect([...codex.querySelectorAll('dt')].map(node => node.textContent)).toEqual(['最近失败', '最近成功', '需要的授权', '使用的上游账号']);
    expect(codex.querySelector('[popover]')?.textContent).toContain('ChatGPT');
    expect(catalog.querySelector('input[type="search"]')?.getAttribute('placeholder')).toBe('本页：过滤路由');
    expect(catalog.textContent).toContain('只搜索当前列表');
    expect(catalog.textContent).toContain('/v1/batches/{batch_id}');
    expect(catalog.textContent).not.toContain('(?![^/]*%2[fF])');
    expect(catalog.textContent).not.toContain('[^/]{1,200}');
    expect(catalog.querySelectorAll('table tbody tr')).toHaveLength(catalog.querySelectorAll('[data-route-id]').length);
  });

  it("explains each access choice in product language before it is granted", async () => {
    const { env, db } = dashboardFixture();
    db.seedUser({ id: "Alex" });
    const response = await adminDashboardResponse({
      env,
      url: new URL("https://admin.example.test/admin?view=access&person=Alex&task=give-access"),
      identity: { kind: "console", email: "op@example.com", subject: "sub" },
      now: new Date("2026-08-02T00:00:00.000Z"),
      requestId: "req_access_capabilities",
      loadCodexAccount: async () => softFailAccount
    });

    expect(response.status).toBe(200);
    const html = await response.text();
    const document = new JSDOM(html).window.document;
    const accessCard = (id: "codex" | "grok" | "xai") => {
      const card = document.querySelector(`[data-access-choice="${id}"]`);
      if (!card) throw new Error(`Missing ${id} access card`);
      return card;
    };
    const codex = accessCard("codex");
    const grok = accessCard("grok");
    const xai = accessCard("xai");

    expect(document.querySelector('[data-access-choices="three"]')).not.toBeNull();
    expect(document.body.textContent).toContain("新密钥包含的服务");
    expect(codex.getAttribute("data-access-level")).toBe("everyday");
    expect(codex.querySelector('input[name="clients"][value="codex"]')).not.toBeNull();
    expect(codex.textContent).not.toContain("指定访问");
    expect(grok.getAttribute("data-access-level")).toBe("everyday");
    expect(grok.textContent).not.toContain("指定访问");
    expect(grok.querySelector('input[name="clients"][value="grok"]')).not.toBeNull();
    expect(xai.getAttribute("data-access-level")).toBe("selected");
    expect(xai.textContent).toContain("指定访问");
    expect(xai.textContent).toContain("包含上游团队共享资源权限");
    expect(new JSDOM(html).window.document.querySelector('[data-action="give-access"]')?.textContent).not.toContain("surface:xai:production");
  });

  it("reveals one complete read-only surface comparison without disturbing the access choice", async () => {
    const { env, db } = dashboardFixture();
    db.seedUser({ id: "Alex" });
    const response = await adminDashboardResponse({
      env,
      url: new URL("https://admin.example.test/admin?view=access&person=Alex&task=give-access"),
      identity: { kind: "console", email: "op@example.com", subject: "sub" },
      now: new Date("2026-08-02T00:00:00.000Z"),
      requestId: "req_surface_capability_view",
      loadCodexAccount: async () => softFailAccount
    });

    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('data-surface-capability-view="true"');
    expect(html).toContain('id="capabilities"');
    expect(html).not.toContain('data-capability-technical-details="true"');
    expect(html).toContain("比较客户端能力");
    expect(html).toContain('aria-label="完整的客户端能力比较"');
    expect(new JSDOM(html).window.document.querySelector('.surface-capability-view th[scope="col"]')?.textContent).toBe('能力');
    expect(html).toContain('data-surface-column="codex"');
    expect(html).toContain('data-surface-column="grok"');
    expect(html).toContain('data-surface-column="xai"');
    expect(html).toContain("构建与推理");
    expect(html).toContain("实时与高级");
    expect(html).toContain('data-capability-id="context_compaction"');
    expect(html).toContain('data-capability-state="in_client"');
    expect(html).toContain('data-capability-state="owner_bound"');
    expect(html).toContain('data-capability-state="team_access"');
    expect(html).toContain('<span class="capability-state" aria-label="不可用">—</span>');
    expect(html).toContain('aria-label="服务权限模型"');
    expect(html).toContain('href="?view=surfaces&amp;range=7d"');
    expect(html).toContain("查看路由");
    expect(html).toContain("由已连接的 ChatGPT 订阅支持的完整编程客户端。");
    expect(html).toContain("包含 Grok Build，以及有限的 xAI 能力。文件和视频仍绑定账号所有者。");
    expect(html).toContain("可以操作组织共享的 xAI API 资源。只授予值得信任的人员。");
    expect(html).toContain("api.trustedtunnel.app");
    expect(html.match(/name="clients"/g)).toHaveLength(3);
    expect(html).not.toContain("sourcePlanId");
    expect(html).not.toContain("grok_production");
    expect(html).not.toContain("api.x.ai");
    expect(html).not.toContain("^\\/v1");
  });

  it("keeps key management directly reachable and sorted by last used", async () => {
    const { env, db } = dashboardFixture();
    db.seedUser({ id: "usr_a", email: "a@example.com" });
    db.seedApiKeys(
      {
        id: "key_old",
        user_id: "usr_a",
        key_prefix: "mp_old",
        scopes: ["surface:codex:production"],
        last_used_at: "2026-07-01T00:00:00.000Z",
        created_at: "2026-01-02T00:00:00.000Z"
      },
      {
        id: "key_new",
        user_id: "usr_a",
        key_prefix: "mp_new",
        scopes: ["surface:codex:production", "surface:grok:production"],
        last_used_at: "2026-07-20T00:00:00.000Z",
        created_at: "2026-01-03T00:00:00.000Z"
      },
      {
        id: "key_never",
        user_id: "usr_a",
        key_prefix: "mp_never",
        scopes: [],
        last_used_at: null,
        created_at: "2026-01-04T00:00:00.000Z"
      }
    );

    const response = await adminDashboardResponse({
      env,
      url: new URL("https://admin.example.test/admin?view=access&person=usr_a"),
      identity: { kind: "console", email: "op@example.com", subject: "sub" },
      now: new Date("2026-07-28T12:00:00.000Z"),
      requestId: "req_keys_table",
      loadCodexAccount: async () => softFailAccount
    });
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('data-advanced-keys="true"');
    expect(html).toContain('data-keys-table="true"');
    expect(html).toContain('placeholder="搜索邮箱、名称或 ID"');
    expect(html).not.toContain('placeholder="搜索密钥"');
    expect(html).toContain('aria-label="密钥"');
    const keysDocument = new JSDOM(html).window.document;
    expect(keysDocument.querySelector('[aria-label="密钥"] a[aria-label="管理密钥 mp_new"]')?.getAttribute("href")).toContain("key=");
    expect(keysDocument.querySelector('[data-keys-table] time')).not.toBeNull();
    expect(html).toContain("mp_new");
    expect(html).toContain("mp_old");
    expect(html).toContain("mp_never");
    expect(html).toContain("Codex、Grok");
    // last-used desc: newer prefix appears before older in table body order
    const bodyIdx = html.indexOf('data-keys-table="true"');
    const newIdx = html.indexOf("mp_new", bodyIdx);
    const oldIdx = html.indexOf("mp_old", bodyIdx);
    const neverIdx = html.indexOf("mp_never", bodyIdx);
    expect(newIdx).toBeGreaterThan(-1);
    expect(oldIdx).toBeGreaterThan(newIdx);
    expect(neverIdx).toBeGreaterThan(oldIdx);
    expect(html).not.toContain("data-key-cards");
    expect(html).not.toContain("key-card-grid");
    expect(html).not.toContain('class="key-card"');
    expect(html).not.toContain("ChatGPT account");
    expect(html).not.toContain("ADMIN_SECRET");
    expect(db.preparedSql.some((sql) => sql.includes("request_audit"))).toBe(false);

    const setupResponse = await adminDashboardResponse({
      env,
      url: new URL("https://admin.example.test/admin?view=setup"),
      identity: { kind: "console", email: "op@example.com", subject: "sub" },
      now: new Date("2026-07-28T12:00:00.000Z"),
      requestId: "req_setup_filter",
      loadCodexAccount: async () => softFailAccount
    });
    const setupHtml = await setupResponse.text();
    expect(setupHtml).toContain('placeholder="搜索账号或密钥"');
  });

  it("uses one exact-filtered request inventory without aggregate reads", async () => {
    const { env, db } = dashboardFixture();
    db.seedAudits(
      ...Array.from({ length: 9 }, (_, index) => ({
        plan: "plan_codex",
        status: "ok" as const,
        upstream: 200,
        at: `2026-07-28T${String(index + 2).padStart(2, "0")}:00:00.000Z`
      })),
      {
        plan: "plan_codex",
        status: "error",
        upstream: 500,
        at: "2026-07-27T10:00:00.000Z"
      }
    );

    const response = await adminDashboardResponse({
      env,
      url: new URL("https://admin.example.test/admin?view=audit"),
      identity: { kind: "console", email: "op@example.com", subject: "sub" },
      now: new Date("2026-07-28T12:00:00.000Z"),
      requestId: "req_traffic_no_log",
      loadCodexAccount: async () => softFailAccount
    });
    expect(response.status).toBe(200);
    const html = await response.text();
    const document = new JSDOM(html).window.document;
    const filters = document.querySelector('form[aria-label="筛选请求记录"]');
    expect(filters?.querySelector('[name="audit_plan"]')).not.toBeNull();
    expect(filters?.querySelector('[name="audit_user"]')).not.toBeNull();
    expect(document.querySelectorAll('[data-request-record]')).toHaveLength(10);
    expect(document.querySelector('.request-filter-actions .info-popover button')?.getAttribute('aria-label')).toBe('记录范围');
    expect(document.querySelectorAll('#activity-summary')).toHaveLength(0);
    expect(db.preparedSql.some((sql) => sql.includes("GROUP BY") && sql.includes("route_profile_id"))).toBe(false);
    expect(
      db.preparedSql.some(
        (sql) =>
          sql.includes("request_audit") &&
          /ORDER BY\s+a\.created_at\s+DESC/i.test(sql) &&
          !/GROUP BY/i.test(sql)
      )
    ).toBe(true);
  });

  it("rejects health and keeps shell-nav contract", async () => {
    const env = emptyEnv();
    const bad = await adminDashboardResponse({
      env,
      url: new URL("https://admin.example.test/admin?view=health"),
      identity: { kind: "admin_secret", email: "op@example.com", subject: null },
      now: new Date("2026-07-28T12:00:00.000Z"),
      requestId: "req_v3_health",
      loadCodexAccount: async () => softFailAccount
    });
    expect(bad.status).toBe(400);

    const overview = await adminDashboardResponse({
      env,
      url: new URL("https://admin.example.test/admin?view=overview&range=7d"),
      identity: { kind: "console", email: "op@example.com", subject: "sub" },
      now: new Date("2026-07-28T12:00:00.000Z"),
      requestId: "req_shell_a",
      loadCodexAccount: async () => softFailAccount
    });
    const usage = await adminDashboardResponse({
      env,
      url: new URL("https://admin.example.test/admin?view=usage&range=7d"),
      identity: { kind: "console", email: "op@example.com", subject: "sub" },
      now: new Date("2026-07-28T12:00:00.000Z"),
      requestId: "req_shell_b",
      loadCodexAccount: async () => softFailAccount
    });
    const overviewHtml = await overview.text();
    const usageHtml = await usage.text();
    expect(overviewHtml).toContain('data-dashboard-nav="vertical"');
    expect(usageHtml).toContain('data-dashboard-view="usage"');
  });

  it("filters usage records and totals by the selected model", async () => {
    const { env, db } = dashboardFixture();
    db.seedUsageRows(
      {
        day: "2026-07-24",
        user_id: "usr_1",
        email: "a@example.com",
        route_profile_id: "codex.responses",
        response_model: "gpt-5.1-codex",
        requests: 2,
        ok_requests: 2,
        error_requests: 0,
        input_tokens: 20,
        cached_input_tokens: 0,
        output_tokens: 20,
        reasoning_tokens: 0,
        total_tokens: 40,
        token_measurements: 2,
        provider_cost_usd_ticks: 0,
        cost_measurements: 0,
        last_seen_at: "2026-07-24T00:00:00.000Z"
      },
      {
        day: "2026-07-25",
        user_id: "usr_1",
        email: "a@example.com",
        route_profile_id: "codex.responses",
        response_model: "gpt-5.2-codex",
        requests: 4,
        ok_requests: 4,
        error_requests: 0,
        input_tokens: 40,
        cached_input_tokens: 0,
        output_tokens: 20,
        reasoning_tokens: 0,
        total_tokens: 60,
        token_measurements: 4,
        provider_cost_usd_ticks: 0,
        cost_measurements: 0,
        last_seen_at: "2026-07-25T00:00:00.000Z"
      }
    );

    const response = await adminDashboardResponse({
      env,
      url: new URL("https://admin.example.test/admin?view=usage&range=7d&model=gpt-5.1-codex"),
      identity: { kind: "console", email: "op@example.com", subject: "sub" },
      now: new Date("2026-07-28T12:00:00.000Z"),
      requestId: "req_model_filter",
      loadCodexAccount: async () => softFailAccount
    });
    expect(response.status).toBe(200);
    const html = await response.text();
    const doc = new JSDOM(html).window.document;
    const records = doc.querySelectorAll(".usage-record");
    expect(records).toHaveLength(1);
    expect(records[0]?.textContent).toContain("gpt-5.1-codex");
    expect(html).not.toContain("gpt-5.2-codex");
    expect(records[0]?.querySelector('.usage-record-count')?.textContent).toContain('2');
    expect(records[0]?.querySelector('.usage-record-measurement')?.textContent).toContain('40');
    const facts = [...doc.querySelectorAll('[data-trend-plan="codex.responses"] .usage-metrics > div')];
    const totals = Object.fromEntries(facts.map(fact => [fact.querySelector("dt")?.textContent, fact.querySelector("dd")?.textContent]));
    expect(totals["Requests"]).toBe("2");
    expect(totals["Token"]).toMatch(/^40(?:\s|$)/);
    expect(totals["API 费率折算"]).toBeUndefined();
  });

  it("does not present a unified token total or prior-period delta", async () => {
    const { env, db } = dashboardFixture();
    db.seedUsageRows(
      {
        day: "2026-07-01",
        user_id: "usr_1",
        route_profile_id: "codex.responses",
        response_model: "gpt-5.1-codex",
        requests: 5,
        ok_requests: 5,
        error_requests: 0,
        input_tokens: 60,
        cached_input_tokens: 0,
        output_tokens: 40,
        reasoning_tokens: 0,
        total_tokens: 100,
        token_measurements: 5,
        provider_cost_usd_ticks: 0,
        cost_measurements: 0,
        last_seen_at: "2026-07-01T00:00:00.000Z"
      },
      {
        day: "2026-07-15",
        user_id: "usr_2",
        route_profile_id: "codex.responses",
        response_model: "gpt-5.1-codex",
        requests: 15,
        ok_requests: 13,
        error_requests: 2,
        input_tokens: 140,
        cached_input_tokens: 0,
        output_tokens: 60,
        reasoning_tokens: 0,
        total_tokens: 200,
        token_measurements: 15,
        provider_cost_usd_ticks: 0,
        cost_measurements: 0,
        last_seen_at: "2026-07-15T00:00:00.000Z"
      }
    );

    for (const view of ["usage"] as const) {
      const response = await adminDashboardResponse({
        env,
        url: new URL(`https://admin.example.test/admin?view=${view}&range=30d`),
        identity: { kind: "console", email: "op@example.com", subject: "sub" },
        now: new Date("2026-07-28T12:00:00.000Z"),
        requestId: `req_all_${view}`,
        loadCodexAccount: async () => softFailAccount
      });
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).not.toContain('aria-label="Measured usage by model"');
      const document = new JSDOM(html).window.document;
      expect(document.querySelectorAll(".usage-record")).toHaveLength(2);
      expect(html).not.toContain('data-metric="tokens"');
      expect(html).not.toContain("vs prior");
      expect(html).not.toContain("token share");
    }
  });

  it("soft-fails account detail on Accounts", async () => {
    const { env, db } = dashboardFixture();
    db.seedCodexAuth();
    const load = vi.fn(async () => softFailAccount);
    const response = await adminDashboardResponse({
      env,
      url: new URL("https://admin.example.test/admin?view=credentials&account=codex%3Aauth_dashboard"),
      identity: { kind: "console", email: "op@example.com", subject: "sub" },
      now: new Date("2026-07-28T12:00:00.000Z"),
      requestId: "req_soft",
      loadCodexAccount: load
    });
    expect(response.status).toBe(200);
    expect(load).toHaveBeenCalledWith("auth_dashboard");
    const html = await response.text();
    const dossier = new JSDOM(html).window.document.querySelector('[data-chatgpt-dossier]')!;
    expect(dossier.getAttribute('data-upstream-read')).toBe('unavailable');
    expect(dossier.querySelector('[data-slot="badge"]')?.textContent).toBe('未读到');
    expect(html).not.toContain("access_token");
  });
});
