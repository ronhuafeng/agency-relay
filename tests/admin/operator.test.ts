import { JSDOM } from "jsdom";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { commitProviderAttemptAccounting, SHARED_CODEX_AUTH_ID } from "../../src/db";
import { IDENTITY_VERSION_CRON } from "../../src/plans/identity-version";
import { handleRequest, handleScheduled } from "../../src/router";
import type { MediaUsageSummaryRow, MediaUsageSummaryTotals, UsageSummaryRow, UsageSummaryTotals } from "../../src/types";
import { scheduledCrons } from "../support/scheduled-crons";
import {
  admin,
  consoleCookie,
  createKey,
  createUser,
  importSharedAuth,
  makeFixture,
  seedDashboardAdmin,
  type Fixture
} from "../router/fixture";

describe("admin pages, accounts, and audit", () => {
  it.each(["https://admin.example.test", "https://api.trustedtunnel.app"])("returns the usage query guide on %s without touching usage_daily", async (origin) => {
    const fixture = makeFixture();

    const response = await admin(fixture, `${origin}/admin/usage`, { method: "GET" });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      kind: "usage_query_guide",
      source: ["usage_daily", "media_usage_daily"],
      timezone: "UTC",
      granularity: "user_plan_model",
      query_required: true,
      params: {
        route_profile_id: "optional exact execution plan id",
        response_model: "optional string",
        limit: "required integer, 1..1000"
      }
    });
    expect(fixture.db.preparedSql.some((sql) => sql.includes("usage_daily"))).toBe(false);
  });

  it("server-renders primary navigation and exposes organization administration", async () => {
    const fixture = makeFixture();

    const response = await admin(fixture, "https://admin.example.test/admin", { method: "GET" });

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("text/html");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("Referrer-Policy")).toBe("same-origin");
    expect(response.headers.get("Content-Security-Policy")).toContain("frame-ancestors 'none'");
    const contentSecurityPolicy = response.headers.get("Content-Security-Policy") ?? "";
    expect(contentSecurityPolicy).toContain("script-src 'nonce-");
    expect(contentSecurityPolicy).not.toContain("script-src 'none'");
    expect(contentSecurityPolicy).toContain("form-action 'self'");
    expect(contentSecurityPolicy).not.toContain("form-action 'none'");
    expect(contentSecurityPolicy).toContain("connect-src 'self' wss://admin.example.test/admin/events/credentials;");
    expect(contentSecurityPolicy).toContain("style-src 'nonce-");
    expect(contentSecurityPolicy).toContain("style-src-attr 'unsafe-inline'");
    const body = await response.text();
    const document = new JSDOM(body).window.document;
    const workspace = [...document.querySelectorAll('[data-nav-group="workspace"] a')].map(link => new URL(link.getAttribute('href') ?? '', 'https://admin.example.test').searchParams.get('view'));
    expect(workspace).toEqual(['overview', 'access', 'setup']);
    expect(document.querySelector('[data-nav-group="resources"] a[href*="view=quotas"]')?.textContent).toBe('额度政策');
    expect(document.querySelector('[data-nav-group="observation"] a[href*="view=audit"]')?.textContent).toBe('请求记录');
    expect(document.querySelector('[data-nav-group="advanced"] a[href*="view=control-audit"]')?.textContent).toBe('管理记录');
    expect(body).toContain('data-dashboard-nav="vertical"');
    expect(body).toContain('data-nav-grouped="workspace-resources-observation-advanced"');
    expect(body).toContain('data-dashboard-view="overview"');
    expect(body).toContain("组织概览");
    expect(body).toContain("用量");
    expect(body).toContain("路由");
    expect(body).toContain("账号");
    expect(body).toContain("成员与服务");
    expect(body).toContain("客户端配置");
    expect(body).toContain("请求记录");
    expect(body).not.toContain('href="?view=health');
    expect(body).toContain("data-home-summary");
    expect(body).toContain("brand-mark");
    expect(body).toContain('href="/admin?view=usage');
    expect(body).not.toContain('href="?view=account');
    expect(body).not.toContain('href="?view=capabilities');
    expect(body).not.toContain("data-provider-form");
    expect(body).not.toContain("/admin/upstream-provider");
    expect((body.match(/data-dashboard-link/g) ?? []).length).toBeGreaterThanOrEqual(6);
  });

  it("renders Routes, Accounts, People, Setup, and Activity current-state panels", async () => {
    const fixture = makeFixture();
    await importSharedAuth(fixture);

    const surfaces = await admin(fixture, "https://admin.example.test/admin?view=surfaces", { method: "GET" });
    expect(surfaces.status).toBe(200);
    const surfacesBody = await surfaces.text();
    expect(surfacesBody).toContain('data-dashboard-view="surfaces"');
    expect(surfacesBody).toContain('data-surfaces-grouped="hostname"');
    expect(surfacesBody).toContain("请求与授权详情");
    expect(new JSDOM(surfacesBody).window.document.querySelector(".route-table th:nth-child(4)")?.textContent).toBe("最近结果");

    const credentials = await admin(fixture, "https://admin.example.test/admin?view=credentials", { method: "GET" });
    expect(credentials.status).toBe(200);
    const credentialsBody = await credentials.text();
    expect(credentialsBody).toContain("添加上游账号");
    expect(credentialsBody).toContain("ChatGPT");
    expect(credentialsBody).toContain("Grok");
    expect(credentialsBody).not.toContain("ADMIN_SECRET");
    expect(credentialsBody).not.toContain("secrets never rendered");

    const access = await admin(fixture, "https://admin.example.test/admin?view=access", { method: "GET" });
    expect(access.status).toBe(200);
    const accessBody = await access.text();
    expect(accessBody).toContain("人员");
    expect(accessBody).toContain('data-view-role="people"');
    expect(accessBody).toContain('task=add-person');
    expect(accessBody).not.toContain('data-keys-table="true"');
    expect(accessBody).not.toContain("data-key-cards");
    expect(accessBody).not.toContain("key-card-grid");
    expect(accessBody).not.toContain("ChatGPT Subscription Authorization");
    expect(accessBody).not.toContain("Claude");
    expect(accessBody).not.toContain("Gemini");

    const setup = await admin(fixture, "https://admin.example.test/admin?view=setup", { method: "GET" });
    expect(setup.status).toBe(200);
    const setupBody = await setup.text();
    expect(setupBody).toContain('data-view-role="setup"');
    expect(new JSDOM(setupBody).window.document.querySelector('.setup-page-head h2')?.textContent).toBe("连接客户端");
    expect(new JSDOM(setupBody).window.document.querySelector('[data-local-config-sync]')?.hasAttribute('hidden')).toBe(true);
    expect(setupBody).not.toContain('data-action="create-setup-package"');
    expect(setupBody).not.toContain("Claude Code");
    expect(setupBody).not.toContain("Gemini CLI");

    const audit = await admin(fixture, "https://admin.example.test/admin?view=audit", { method: "GET" });
    expect(audit.status).toBe(200);
    const auditBody = await audit.text();
    expect(auditBody).not.toContain("data-traffic-summary");
    expect(auditBody).not.toContain('id="activity-summary"');
    expect(new JSDOM(auditBody).window.document.querySelector('#request-history')).not.toBeNull();
    expect(auditBody).toContain('name="audit_plan"');
    expect(auditBody).toContain('name="audit_user"');
    expect(auditBody).not.toContain("Recent requests");
    expect(auditBody).not.toContain('aria-label="Recent requests"');
  });

  it("rejects removed dashboard views and invalid query keys", async () => {
    const fixture = makeFixture();
    for (const view of ["health", "account", "capabilities", "flows", "tokens", "routes", "subscriptions", "auth", "requests"]) {
      const response = await admin(fixture, `https://admin.example.test/admin?view=${view}`, { method: "GET" });
      expect(response.status).toBe(400);
      await expect(response.text()).resolves.toContain("页面参数不正确");
    }
  });

  it("returns HTML 503 when selected dashboard reads fail", async () => {
    const logSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      // Credentials loads all ChatGPT accounts; an auth read failure must surface 503 HTML.
      const authFail = makeFixture({ dashboardReadFailure: "auth" });
      const authResponse = await admin(authFail, "https://admin.example.test/admin?view=credentials", {
        method: "GET"
      });
      expect(authResponse.status).toBe(503);
      const body = await authResponse.text();
      expect(body).toContain("控制台暂时打不开");
      expect(body).toMatch(/请求编号：/);
      expect(body).not.toContain("auth dashboard read failed");
    } finally {
      logSpy.mockRestore();
    }
  });

  it("keeps account status meaningful on Credentials and in access-task choices", async () => {
    const missingFixture = makeFixture();
    const missing = await admin(missingFixture, "https://admin.example.test/admin?view=credentials", { method: "GET" });
    await expect(missing.text()).resolves.toContain("还没有账号。");

    const configuredFixture = makeFixture();
    setSharedCodexAuth(configuredFixture, {
      status: "refresh_error",
      upstream_email: null,
      upstream_account_id: null,
      expires_at: "2026-06-23T23:59:59.000Z",
      last_refresh_at: null
    });
    const configured = await admin(configuredFixture, "https://admin.example.test/admin?view=credentials&account=codex%3Ashared_default", { method: "GET" });
    const body = await configured.text();
    // Legacy/unknown statuses project as degraded with human copy (not protocol codes).
    expect(body).toContain("需要处理");
    expect(body).toContain("2026-06-23");
    expect(body).toContain("ChatGPT");
    expect(body).toContain('data-mgmt-state="degraded"');
    expect(body).toContain("先刷新账号。刷新失败时，再重新连接。");
    expect(body).toContain('data-codex-admin="true"');
    expect(body).not.toContain("People you authorize share");
    expect(body).not.toContain("refresh_error");
    expect(body).not.toContain("用量明细");
    expect(body).not.toContain("cube-root");
    expect(body).not.toContain("ADMIN_SECRET");

    const person = await createUser(configuredFixture, "account-choice@example.test");
    const access = await admin(configuredFixture, `https://admin.example.test/admin?view=access&person=${person.user.id}&task=give-access`, { method: "GET" });
    const accessBody = await access.text();
    expect(accessBody).toContain('data-view-role="people"');
    expect(accessBody).toContain("需要处理");
    expect(accessBody).not.toContain("refresh_error");
  });

  it("rejects ADMIN_SECRET on the dashboard hostname", async () => {
    const fixture = makeFixture();

    const dashboard = await handleRequest(new Request("https://admin.example.test/", {
      headers: { Authorization: "Bearer admin-secret" }
    }), fixture.env, fixture.ctx, fixture.deps);
    expect(dashboard.status).toBe(403);
    await expect(dashboard.json()).resolves.toMatchObject({
      error: { code: "admin_auth_required" }
    });
  });

  it("board gives access, replaces with overlap, and revokes only on a separate action", async () => {
    const fixture = makeFixture();
    const user = await createUser(fixture, "board-keys@example.com");
    fixture.db.ensureCredentialAccountsForScopes([
      "surface:codex:production",
      "surface:grok:production"
    ]);
    // Replacement requires usable metadata; an unconnected account is not enough.
    await importSharedAuth(fixture);
    fixture.db.updateSubscriptionAccount("sub_grok_test", "active", "2020-01-01T00:00:00.000Z");

    const denied = await handleRequest(new Request("https://admin.example.test/admin/ui/keys", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        user_id: user.user.id,
        scopes: ["surface:codex:production"]
      })
    }), fixture.env, fixture.ctx, fixture.deps);
    expect(denied.status).toBe(403);

    const secretAttempt = await handleRequest(new Request("https://admin.example.test/admin/ui/keys", {
      method: "POST",
      headers: {
        Authorization: "Bearer admin-secret",
        "Content-Type": "application/json",
        Accept: "application/json"
      },
      body: JSON.stringify({
        user_id: user.user.id,
        scopes: ["surface:codex:production"]
      })
    }), fixture.env, fixture.ctx, fixture.deps);
    expect(secretAttempt.status).toBe(403);

    const created = await admin(fixture, "https://admin.example.test/admin/ui/keys", {
      method: "POST",
      body: {
        user_id: user.user.id,
        name: "Board key",
        scopes: ["surface:codex:production", "surface:grok:production"],
        codex_credential_account_id: SHARED_CODEX_AUTH_ID,
        grok_credential_account_id: "sub_grok_test"
      }
    });
    expect(created.status).toBe(201);
    const createdBody = await created.json() as {
      id: string;
      token: string;
      key_prefix: string;
      user_id: string;
      scopes: string[];
    };
    expect(createdBody.token.startsWith("cfwd_")).toBe(true);
    expect(createdBody.user_id).toBe(user.user.id);
    expect(createdBody.scopes).toEqual(["surface:codex:production", "surface:grok:production"]);
    expect(fixture.db.apiKeys.get(createdBody.id)?.status).toBe("active");

    const auditCreate = fixture.db.operatorMutationAudit.find((row) => row.action === "key.create");
    expect(auditCreate).toMatchObject({
      actor_kind: "access",
      actor_email: "operator@example.com",
      actor_subject: null,
      target_type: "api_key",
      target_id: createdBody.id,
      result: "ok"
    });
    const createMeta = JSON.parse(String(auditCreate?.meta ?? "{}")) as Record<string, unknown>;
    expect(createMeta.key_prefix).toBe(createdBody.key_prefix);
    expect(JSON.stringify(createMeta)).not.toContain(createdBody.token);
    expect(JSON.stringify(fixture.db.operatorMutationAudit)).not.toContain("admin-secret");

    const unconfirmedReplace = await admin(fixture, `https://admin.example.test/admin/ui/keys/${createdBody.id}/replace`, {
      method: "POST",
      body: {}
    });
    expect(unconfirmedReplace.status).toBe(400);

    const replaced = await admin(fixture, `https://admin.example.test/admin/ui/keys/${createdBody.id}/replace`, {
      method: "POST",
      body: { confirm: true }
    });
    expect(replaced.status).toBe(201);
    const replacementBody = await replaced.json() as {
      replacement: { id: string; token: string; scopes: string[] };
      previous: { id: string; status: string };
      old_key_remains_active: boolean;
    };
    expect(replacementBody.old_key_remains_active).toBe(true);
    expect(replacementBody.previous).toMatchObject({ id: createdBody.id, status: "active" });
    expect(replacementBody.replacement.scopes).toEqual(createdBody.scopes);
    expect(fixture.db.apiKeys.get(createdBody.id)?.status).toBe("active");
    expect(fixture.db.apiKeys.get(replacementBody.replacement.id)?.status).toBe("active");
    await importSharedAuth(fixture);
    for (const token of [createdBody.token, replacementBody.replacement.token]) {
      const models = await handleRequest(new Request("https://api.trustedtunnel.app/v1/models", {
        headers: { Authorization: `Bearer ${token}` }
      }), fixture.env, fixture.ctx, fixture.deps);
      expect(models.status).toBe(200);
    }
    const replaceAudit = fixture.db.operatorMutationAudit.find((row) => row.action === "key.replace.create");
    expect(replaceAudit).toMatchObject({
      target_id: replacementBody.replacement.id,
      result: "ok"
    });
    const replaceMeta = JSON.parse(String(replaceAudit?.meta ?? "{}")) as Record<string, unknown>;
    expect(replaceMeta.old_key_remains_active).toBe(true);
    expect(JSON.stringify(replaceMeta)).not.toContain(replacementBody.replacement.token);

    const unconfirmed = await admin(fixture, `https://admin.example.test/admin/ui/keys/${createdBody.id}/revoke`, {
      method: "POST",
      body: {}
    });
    expect(unconfirmed.status).toBe(400);

    const revoked = await admin(fixture, `https://admin.example.test/admin/ui/keys/${createdBody.id}/revoke`, {
      method: "POST",
      body: { confirm: true }
    });
    expect(revoked.status).toBe(200);
    await expect(revoked.json()).resolves.toMatchObject({
      id: createdBody.id,
      revoked: true,
      already_revoked: false
    });
    expect(fixture.db.apiKeys.get(createdBody.id)?.status).toBe("revoked");
    expect(fixture.db.operatorMutationAudit.some((row) => row.action === "key.revoke")).toBe(true);

    const again = await admin(fixture, `https://admin.example.test/admin/ui/keys/${createdBody.id}/revoke`, {
      method: "POST",
      body: { confirm: "1" }
    });
    expect(again.status).toBe(200);
    await expect(again.json()).resolves.toMatchObject({ already_revoked: true });

    const keysPage = await admin(fixture, `https://admin.example.test/admin?view=access&person=${user.user.id}`, { method: "GET" });
    expect(keysPage.status).toBe(200);
    const keysHtml = await keysPage.text();
    expect(keysHtml).toContain('data-keys-admin="true"');
    expect(keysHtml).toContain('data-person-access-summary');
    expect(keysHtml).toContain('data-credit-allowances="true"');
    const keysDoc = new JSDOM(keysHtml).window.document;
    expect(keysDoc.querySelector('[data-credit-user][data-credit-surface="codex"] td:first-child')?.textContent).toContain("组织默认");
    expect(keysHtml).toContain("组织默认");
    expect(keysHtml).not.toContain("no monthly ceiling");
    expect(keysHtml).toContain('task=give-access');
    expect(keysHtml).not.toContain('action="/admin/ui/keys"');
    expect(keysHtml).toMatch(/revoked|Revoke/i);
    expect(keysHtml).not.toContain("ADMIN_SECRET");
    expect(keysHtml).not.toContain(createdBody.token);
  });

  it.each([
    ["", "2026-09-22T00:00:00.000Z"],
    ["2027-04-15T14:35", "2027-04-15T14:35:00.000Z"],
    ["2027-03-14T02:30:17", "2027-03-14T02:30:17.000Z"],
    ["2027-05-01T18:45:12.25", "2027-05-01T18:45:12.250Z"]
  ])("stores native UTC expiry %s through a normal HTML form", async (value, expected) => {
    const fixture = makeFixture();
    const user = await createUser(fixture, "native-expiry@example.com");
    fixture.db.ensureCredentialAccountsForScopes(["surface:codex:production"]);
    const form = new URLSearchParams({
      user_id: user.user.id, name: "Board key", clients: "codex", codex_credential_account_id: SHARED_CODEX_AUTH_ID,
      expires_at_utc: value!
    });
    const response = await adminForm(fixture, "https://admin.example.test/admin/ui/keys", form);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('data-one-time-key="true"');
    const key = [...fixture.db.apiKeys.values()].find(row => row.user_id === user.user.id)!;
    expect(key.expires_at).toBe(expected);
    expect(JSON.parse(String(key.scopes))).toEqual(["surface:codex:production"]);
  });

  it.each([
    { expires_at_utc: "2027-02-29T12:00" },
    { expires_at_utc: "2027-04-31T12:00" },
    { expires_at_utc: "2027-01-01T24:00" },
    { expires_at_utc: "0000-01-01T00:00" },
    { expires_at_utc: "2027-01-01T12:00+08:00" },
    { expires_at_utc: "2027-01-01" },
    { expires_at_utc: ["2027-01-01T12:00", "2028-01-01T12:00"] },
    { expires_at_utc: null },
    { expires_at_utc: "", expires_at: "2027-01-01T12:00:00Z" }
  ])("rejects invalid or ambiguous dashboard expiry before creating a key: %j", async (expiry) => {
    const fixture = makeFixture();
    const user = await createUser(fixture, "invalid-expiry@example.com");
    fixture.db.ensureCredentialAccountsForScopes(["surface:codex:production"]);
    const response = await admin(fixture, "https://admin.example.test/admin/ui/keys", {
      method: "POST", body: {
        user_id: user.user.id, scopes: ["surface:codex:production"],
        codex_credential_account_id: SHARED_CODEX_AUTH_ID, ...expiry
      }
    });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "expires_at" in expiry ? "ambiguous_expiry" : "invalid_expires_at_utc" } });
    expect(fixture.db.apiKeys.size).toBe(0);
    expect(fixture.db.operatorMutationAudit.some(row => row.action === "key.create")).toBe(false);
  });

  it("keeps the existing ISO expiry field compatible with dashboard callers", async () => {
    const fixture = makeFixture();
    const user = await createUser(fixture, "legacy-expiry@example.com");
    fixture.db.ensureCredentialAccountsForScopes(["surface:codex:production"]);
    const expires_at = "2027-01-01T12:45:12.123+08:00";
    const response = await admin(fixture, "https://admin.example.test/admin/ui/keys", {
      method: "POST", body: { user_id: user.user.id, name: "Board key", scopes: ["surface:codex:production"], codex_credential_account_id: SHARED_CODEX_AUTH_ID, expires_at }
    });
    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({ expires_at });
  });

  it("renders three one-time client setup files without persisting the plaintext key", async () => {
    const fixture = makeFixture();
    const user = await createUser(fixture, "setup-package@example.com");
    fixture.db.ensureCredentialAccountsForScopes([
      "surface:codex:production",
      "surface:grok:production",
      "surface:xai:production"
    ]);
    const form = new URLSearchParams({ user_id: user.user.id, name: "Board key" });
    form.append("clients", "codex");
    form.append("clients", "grok");
    form.append("clients", "xai");
    form.set("codex_credential_account_id", SHARED_CODEX_AUTH_ID);
    form.set("grok_credential_account_id", "sub_grok_test");
    form.set("xai_credential_account_id", "sub_grok_test");

    const created = await adminForm(fixture, "https://admin.example.test/admin/ui/keys", form);
    expect(created.status).toBe(200);
    const html = await created.text();
    expect(html).toContain('data-dashboard-view="setup"');
    expect(html).toContain('data-one-time-key="true"');
    expect(html).not.toContain('data-action="create-setup-package"');
    expect(html).toContain('data-client-setup="codex"');
    expect(html).toContain('data-client-setup="grok"');
    expect(html).toContain('data-client-setup="xai"');
    expect(html).toContain("codex-config.toml");
    expect(html).toContain("grok-config.toml");
    expect(html).toContain("xai-api.env");
    expect(html).not.toContain("mini-claude.env");
    expect(html).not.toContain("mini-gemini.env");
    expect(html).toContain("安装到");
    const issued = [...fixture.db.apiKeys.values()].find((row) => row.user_id === user.user.id);
    expect(issued).toBeDefined();
    expect(html).toContain(`data-dashboard-url="/admin?view=setup&amp;range=7d&amp;person=${user.user.id}&amp;key=${issued!.id}"`);
    expect(html).not.toContain(String(issued?.key_hash));

    const modelOnlyUser = await createUser(fixture, "setup-model-only@example.com");
    const modelOnlyKey = await createKey(fixture, modelOnlyUser.user.id, ["surface:grok:production"]);
    await commitProviderAttemptAccounting(fixture.env, {
      audit_id: "audit_setup_grok_models_only",
      key_id: modelOnlyKey.key.id,
      route_profile_id: "grok.production.models",
      route: "/v1/models",
      user_id: modelOnlyUser.user.id,
      status: "ok",
      upstream_status: 200,
      usage_observer: "none",
      usage_capture: null
    }, new Date("2026-06-24T00:00:30.000Z"));
    await commitProviderAttemptAccounting(fixture.env, {
      audit_id: "audit_setup_grok_works",
      key_id: String(issued!.id),
      route_profile_id: "grok.production.responses",
      route: "/v1/responses",
      user_id: user.user.id,
      status: "ok",
      upstream_status: 200,
      usage_observer: "responses",
      usage_capture: null
    }, new Date("2026-06-24T00:01:00.000Z"));
    const nextPage = await admin(fixture, `https://admin.example.test/admin?view=setup&person=${user.user.id}&key=${issued!.id}`, { method: "GET" });
    const nextHtml = await nextPage.text();
    expect(nextHtml).not.toContain('data-one-time-key="true"');
    expect(nextHtml).not.toContain('data-created-token="true"');
    expect(nextHtml).toContain("换发密钥并下载配置包");
    expect(new JSDOM(nextHtml).window.document.querySelector('[data-local-config-sync]')?.hasAttribute('hidden')).toBe(true);
    expect(nextHtml).toContain('data-client-verification="grok"');
    expect(nextHtml).toContain('data-result="works"');
    expect(nextHtml).toContain("最近任务成功");
    const modelOnly = await admin(fixture, `https://admin.example.test/admin?view=setup&person=${modelOnlyUser.user.id}&key=${modelOnlyKey.key.id}`, { method: "GET" });
    expect(await modelOnly.text()).toContain('data-client-verification="grok" data-result="not-verified"');
  });

  it("adds a canonical organization member with a server ID and no implicit key or admin role", async () => {
    const fixture = makeFixture();
    const empty = await admin(fixture, "https://admin.example.test/admin?view=access&task=add-person", { method: "GET" });
    const emptyDoc = new JSDOM(await empty.text()).window.document;
    expect(emptyDoc.querySelector('input[name="id"]')).toBeNull();
    expect(emptyDoc.querySelector('input[name="email"]')?.hasAttribute("required")).toBe(true);
    const response = await adminForm(fixture, "https://admin.example.test/admin/ui/users", new URLSearchParams({ id: "attacker-chosen-id", email: " Alex+Work@Example.com " }));
    expect(response.status).toBe(200);
    const html = await response.text();
    const created = [...fixture.db.users.values()].find(user => user.email === "alex+work@example.com")!;
    expect(created).toMatchObject({ role: "user", status: "active", login_capable: 1 });
    expect(created.id).toMatch(/^usr_/);
    expect(fixture.db.users.has("attacker-chosen-id")).toBe(false);
    expect(new JSDOM(html).window.document.querySelector('[data-mutation-flash="user_created"]')?.textContent).toContain("已添加 alex+work@example.com。");
    expect(html).toContain(`data-dashboard-url="/admin?view=access&amp;range=7d&amp;person=${created.id}"`);
    expect(fixture.db.apiKeys.size).toBe(0);
    expect(fixture.db.operatorMutationAudit).toContainEqual(expect.objectContaining({ action: "user.create", target_id: created.id, actor_kind: "access" }));
    expect(html).not.toContain('data-one-time-key="true"');
    expect(html).not.toContain('action="/admin/ui/keys"');
    for (const client of ["codex", "grok", "xai"]) expect(html).toContain(`data-access-client="${client}" data-access-state="none"`);
  });
  it("issues access from the actual rendered native form, including its required key name", async () => {
    const fixture = makeFixture(); const person = await createUser(fixture, "rendered-form@example.com"); await importSharedAuth(fixture);
    const response = await admin(fixture, `https://admin.example.test/admin?view=access&person=${encodeURIComponent(person.user.id)}&task=give-access`, {method: "GET"});
    const page = new JSDOM(await response.text());
    const form = page.window.document.querySelector('form[action="/admin/ui/keys"]');
    const client = page.window.document.querySelector('input[name="clients"][value="codex"]');
    const account = page.window.document.querySelector('select[name="codex_credential_account_id"]');
    if (!(form instanceof page.window.HTMLFormElement) || !(client instanceof page.window.HTMLInputElement) || !(account instanceof page.window.HTMLSelectElement)) throw new Error("Missing access form controls");
    client.checked = true; account.value = SHARED_CODEX_AUTH_ID;
    const body = new URLSearchParams(); for (const [name, value] of new page.window.FormData(form)) {if (typeof value === "string") body.append(name, value);}
    expect(body.get("name")).toBe("客户端访问");
    const result = await adminForm(fixture, "https://admin.example.test/admin/ui/keys", body); expect(result.status).toBe(200); expect(fixture.db.apiKeys.size).toBe(1);
    expect(Array.from(fixture.db.apiKeys.values())[0]).toMatchObject({name: "客户端访问", user_id: person.user.id});
  });

  it("preserves invalid organization email and rejects collision or untrusted creation", async () => {
    const fixture = makeFixture();
    const url = "https://admin.example.test/admin/ui/users";
    for (const email of ["", "invalid email", "alex@example.test", "alex@notexample.com"]) {
      const response = await adminForm(fixture, url, new URLSearchParams({ email }));
      expect(response.status).toBe(400);
      const doc = new JSDOM(await response.text()).window.document;
      expect(doc.querySelector('[role="alert"]')).not.toBeNull();
      expect(doc.querySelector('input[name="email"]')?.getAttribute("value")).toBe(email);
      expect([...fixture.db.users.values()].filter(user => user.id !== "usr_dashboard_admin")).toHaveLength(0);
    }
    await adminForm(fixture, url, new URLSearchParams({ email: "alex@example.com" }));
    const duplicate = await adminForm(fixture, url, new URLSearchParams({ email: " ALEX@Example.com " }));
    expect(duplicate.status).toBe(409);
    const html = await duplicate.text();
    expect(new JSDOM(html).window.document.querySelector("[role=alert]")?.textContent).toContain("这个邮箱已属于另一个账号");
    expect(fixture.db.operatorMutationAudit.filter(row => row.action === "user.create")).toHaveLength(1);
    const crossOrigin = await adminForm(fixture, url, new URLSearchParams({ email: "untrusted@example.com" }), { Origin: "https://untrusted.example.test" });
    expect(crossOrigin.status).toBe(403);
    const denied = await handleRequest(new Request(url, { method: "POST", headers: { Authorization: "Bearer admin-secret", "Content-Type": "application/x-www-form-urlencoded" }, body: "email=untrusted@example.com" }), fixture.env, fixture.ctx, fixture.deps);
    expect(denied.status).toBe(403);
    expect([...fixture.db.users.values()].some(user => user.email === "untrusted@example.com")).toBe(false);
  });

  it("returns binding and revocation to the exact key with fresh state and preserved list context", async () => {
    const fixture = makeFixture();
    const user = await createUser(fixture, "key-detail@example.test");
    const key = await createKey(fixture, user.user.id, ["surface:codex:production"]);
    const person = encodeURIComponent(user.user.id);
    const returnTo = `/admin?view=access&person=${person}&key=${key.key.id}&range=30d&q=missing&key_q=missing&key_page=2`;
    const binding = await adminForm(fixture, `https://admin.example.test/admin/ui/keys/${key.key.id}/credential-bindings/codex?person=${person}`, new URLSearchParams({ credential_account_id: SHARED_CODEX_AUTH_ID, key_return: returnTo }));
    expect(binding.status).toBe(200);
    const boundHtml = await binding.text();
    expect(boundHtml).toContain(`data-key-detail="${key.key.id}"`);
    expect(boundHtml).toContain('data-dashboard-mutation="credential_binding"');
    const bindingNotice = new JSDOM(boundHtml).window.document.querySelector('[data-mutation-flash="credential_binding"]');
    expect(bindingNotice?.querySelector("h2")?.textContent).toBe("Codex 上游绑定已更新");
    expect(bindingNotice?.querySelector("code")?.textContent).toBe(key.key.id);
    expect(boundHtml).not.toContain("Grok 已刷新");
    expect(boundHtml).toContain('range=30d');
    expect(boundHtml).toContain('key_page=2');
    expect(new JSDOM(boundHtml).window.document.querySelector('select[name="credential_account_id"] option[selected]')?.getAttribute("value")).toBe(SHARED_CODEX_AUTH_ID);
    const revoked = await adminForm(fixture, `https://admin.example.test/admin/ui/keys/${key.key.id}/revoke?person=${person}`, new URLSearchParams({ confirm: "1", key_return: returnTo }));
    expect(revoked.status).toBe(200);
    const revokedHtml = await revoked.text();
    expect(revokedHtml).toContain(`data-key-detail="${key.key.id}"`);
    expect(new JSDOM(revokedHtml).window.document.querySelector('.key-detail-head .key-state')?.textContent).toBe('已撤销');
    expect(revokedHtml).not.toContain('data-action="replace-key"');
    expect(revokedHtml).not.toContain('data-action="revoke-key"');
    expect(fixture.db.apiKeys.get(key.key.id)?.status).toBe("revoked");
  });

  it("returns a replacement package to the original person's Keys context without revoking the old key", async () => {
    const fixture = makeFixture();
    const user = await createUser(fixture, "replacement-context@example.test");
    const key = await createKey(fixture, user.user.id, ["surface:codex:production"]);
    await importSharedAuth(fixture);
    const person = encodeURIComponent(user.user.id);
    const returnTo = `/admin?view=access&person=${person}&key=${key.key.id}&range=30d&q=person&key_page=2`;
    const result = await adminForm(fixture, `https://admin.example.test/admin/ui/keys/${key.key.id}/replace`, new URLSearchParams({ confirm: "1", key_return: returnTo }));
    expect(result.status).toBe(200);
    const html = await result.text();
    expect(html).toContain('data-dashboard-mutation="key_replacement_created"');
    expect(html).toContain('data-one-time-key');
    expect(html).toContain(`href="/admin?view=access&amp;person=${person}&amp;range=30d&amp;q=person&amp;key_page=2#keys"`);
    const replacement = [...fixture.db.apiKeys.values()].find(candidate => candidate.user_id === user.user.id && candidate.id !== key.key.id)!;
    expect(html).toContain(`data-dashboard-url="/admin?view=setup&amp;range=30d&amp;person=${person}&amp;key=${replacement.id}"`);
    expect(fixture.db.apiKeys.get(key.key.id)?.status).toBe("active");
    expect([...fixture.db.apiKeys.values()].filter(candidate => candidate.user_id === user.user.id && candidate.status === "active")).toHaveLength(2);
  });

  it("returns an expired-source native replacement without claiming the old secret is live", async () => {
    const fixture = makeFixture();
    const user = await createUser(fixture, "expired-replacement@example.test");
    const key = await createKey(fixture, user.user.id, ["surface:codex:production"]);
    await importSharedAuth(fixture);
    await fixture.env.DB.prepare("UPDATE api_keys SET expires_at = ? WHERE id = ?").bind("2020-01-01T00:00:00Z", key.key.id).run();
    const response = await adminForm(fixture, `https://admin.example.test/admin/ui/keys/${key.key.id}/replace`, new URLSearchParams({confirm:"1"}));
    expect(response.status).toBe(200);
    const html=await response.text();
    expect(html.includes('data-replacement-overlap="false"')).toBe(true);
    expect(html.includes("不会因为这次续发恢复有效")).toBe(true);
    expect(html.includes("在到期或撤销前仍然有效")).toBe(false);
    expect(fixture.db.apiKeys.get(key.key.id)?.expires_at).toBe("2020-01-01T00:00:00Z");
    expect([...fixture.db.apiKeys.values()].filter(candidate=>candidate.user_id===user.user.id)).toHaveLength(2);
  });

  it.each(["valid", "external", "foreign-key", "foreign-person", "task", "page", "path"])("selects the replacement key and validates Setup return context: %s", async variant => {
    const fixture = makeFixture();
    const user = await createUser(fixture, "setup-return@example.test");
    const key = await createKey(fixture, user.user.id, ["surface:codex:production"]);
    await importSharedAuth(fixture);
    await importSharedAuth(fixture);
    const person = encodeURIComponent(user.user.id);
    const context = new URL(`https://admin.example.test/admin?view=setup&person=${person}&key=${key.key.id}&q=absent&page=3&range=30d`);
    if (variant === "external") context.hostname = "other.example.test";
    if (variant === "foreign-key") context.searchParams.set("key", "other");
    if (variant === "foreign-person") context.searchParams.set("person", "other");
    if (variant === "task") context.searchParams.set("task", "sync-configuration");
    if (variant === "page") context.searchParams.set("page", "0");
    if (variant === "path") context.pathname = "/admin/ui/keys";
    const response = await adminForm(fixture, `https://admin.example.test/admin/ui/keys/${key.key.id}/replace`, new URLSearchParams({confirm:"1",key_return:context.href}));
    expect(response.status).toBe(200);
    const html = await response.text();
    const canonical = new URL(html.match(/data-dashboard-url="([^"]+)"/)![1]!.replaceAll("&amp;", "&"), "https://admin.example.test");
    const replacement = [...fixture.db.apiKeys.values()].find(candidate => candidate.user_id === user.user.id && candidate.id !== key.key.id)!;
    expect(canonical.searchParams.get("view")).toBe("setup");
    expect(canonical.searchParams.get("person")).toBe(user.user.id);
    expect(canonical.searchParams.get("key")).toBe(replacement.id);
    const accepted = variant === "valid" || variant === "task";
    expect(canonical.searchParams.get("range")).toBe(accepted ? "30d" : "7d");
    expect(canonical.searchParams.get("q")).toBe(accepted ? "absent" : null);
    expect(canonical.searchParams.get("page")).toBe(accepted ? "3" : null);
    expect(html).toContain(`data-setup-selected-key="${replacement.id}"`);
    expect(html).not.toContain('data-action="create-setup-package"');
    expect(html).not.toContain('data-result="works"');
    const overlap = html.match(/data-replacement-overlap="true"[\s\S]*?<\/p>/)![0];
    const previous = new URL(overlap.match(/href="([^"]+)"/)![1]!.replaceAll("&amp;", "&"), "https://admin.example.test");
    expect(previous.pathname).toBe("/admin");
    expect(previous.searchParams.get("view")).toBe("access");
    expect(previous.searchParams.get("person")).toBe(user.user.id);
    expect(previous.searchParams.get("key")).toBe(key.key.id);
    expect(previous.searchParams.has("q")).toBe(false);
    expect(fixture.db.apiKeys.get(key.key.id)?.status).toBe("active");
    expect(replacement.status).toBe("active");
  });

  it("ignores a forged key return address without losing a confirmed binding result", async () => {
    const fixture = makeFixture();
    const user = await createUser(fixture, "key-return@example.test");
    const key = await createKey(fixture, user.user.id, ["surface:codex:production"]);
    const person = encodeURIComponent(user.user.id);
    const good = `/admin?view=access&person=${person}&key=${key.key.id}`;
    for (const key_return of [`https://other.example.test${good}`, good.replace(`key=${key.key.id}`, "key=another"), good.replace(`person=${person}`, "person=another"), `${good}&task=give-access`, `${good}&page=0`, good.replace("/admin?", "/admin/ui/keys?")]) {
      const result = await adminForm(fixture, `https://admin.example.test/admin/ui/keys/${key.key.id}/credential-bindings/codex?person=${person}`, new URLSearchParams({ credential_account_id: SHARED_CODEX_AUTH_ID, key_return }));
      expect(result.status).toBe(200);
      const html = await result.text();
      expect(html).toContain('data-dashboard-mutation="credential_binding"');
      expect(html).toContain(`data-dashboard-url="/admin?view=access&amp;range=7d&amp;person=${person}"`);
      expect(html).not.toContain('data-key-detail=');
    }
  });

  it("returns person mutations to the same selected person and refreshes by GET", async () => {
    const fixture = makeFixture();
    const created = await admin(fixture, "https://api.trustedtunnel.app/admin/users", { method: "POST", body: { id: "Alex & Morgan / 团队" } });
    expect(created.status).toBe(201);
    const id = "Alex & Morgan / 团队";
    const encoded = encodeURIComponent(id);
    fixture.db.ensureCredentialAccountsForScopes(["surface:codex:production"]);
    const issued = await admin(fixture, "https://admin.example.test/admin/ui/keys", { method: "POST", body: { user_id: id, name: "Board key", scopes: ["surface:codex:production"], codex_credential_account_id: SHARED_CODEX_AUTH_ID } });
    expect(issued.status).toBe(201);
    const key = { key: await issued.json() as { id: string } };
    const canonical = `/admin?view=access&amp;range=7d&amp;person=${encoded}`;
    const mutations = [
      [`users/${encoded}/status`, { status: "disabled", confirm: "1" }],
      [`users/${encoded}/credits/codex`, { monthly_allowance: "10", confirm: "1" }],
      [`keys/${key.key.id}/credential-bindings/codex?person=${encoded}`, { credential_account_id: SHARED_CODEX_AUTH_ID }],
      [`keys/${key.key.id}/revoke?person=${encoded}`, { confirm: "1" }]
    ] as const;
    for (const [path, values] of mutations) {
      const result = await adminForm(fixture, `https://admin.example.test/admin/ui/${path}`, new URLSearchParams(values));
      expect(result.status, path).toBe(200);
      const html = await result.text();
      expect(html).toContain(`data-dashboard-url="${canonical}"`);
      expect(html).toContain('data-person-detail="Alex &amp; Morgan / 团队"');
      const refreshed = await admin(fixture, `https://admin.example.test/admin?view=access&person=${encoded}`, { method: "GET" });
      expect(refreshed.status).toBe(200);
      expect(await refreshed.text()).not.toContain('data-dashboard-mutation="');
    }
    expect(fixture.db.apiKeys.get(key.key.id)?.status).toBe("revoked");
    expect(fixture.db.users.get(id)?.status).toBe("disabled");
  });

  it("board can disable and enable users with audit", async () => {
    const fixture = makeFixture();
    const user = await createUser(fixture, "board-user@example.com");

    const disabled = await admin(fixture, `https://admin.example.test/admin/ui/users/${user.user.id}/status`, {
      method: "POST",
      body: { status: "disabled", confirm: true }
    });
    expect(disabled.status).toBe(200);
    await expect(disabled.json()).resolves.toMatchObject({
      id: user.user.id,
      status: "disabled",
      previous_status: "active"
    });
    expect(fixture.db.users.get(user.user.id)?.status).toBe("disabled");
    expect(fixture.db.operatorMutationAudit.some((row) => row.action === "user.disable")).toBe(true);

    const enabled = await admin(fixture, `https://admin.example.test/admin/ui/users/${user.user.id}/status`, {
      method: "POST",
      body: { status: "active", confirm: 1 }
    });
    expect(enabled.status).toBe(200);
    expect(fixture.db.users.get(user.user.id)?.status).toBe("active");
    expect(fixture.db.operatorMutationAudit.some((row) => row.action === "user.enable")).toBe(true);
  });

  it("sets, reads, renders, and removes one user Surface Credit allowance", async () => {
    const fixture = makeFixture();
    const user = await createUser(fixture, "credit-policy@example.com");

    const set = await admin(
      fixture,
      `https://api.trustedtunnel.app/admin/users/${user.user.id}/credits/grok`,
      { method: "PUT", body: { monthly_allowance: 2 } }
    );
    expect(set.status).toBe(200);
    await expect(set.json()).resolves.toMatchObject({
      state: {
        user_id: user.user.id,
        surface_grant: "surface:grok:production",
        monthly_allowance: 2,
        consumed_credits: 0,
        remaining_credits: 2
      }
    });

    const read = await admin(
      fixture,
      `https://api.trustedtunnel.app/admin/users/${user.user.id}/credits`,
      { method: "GET" }
    );
    const readBody = await read.json() as { states: Array<{ surface_grant: string; monthly_allowance: number; source: string }> };
    expect(readBody.states).toHaveLength(3);
    expect(readBody.states).toEqual(expect.arrayContaining([
      expect.objectContaining({ surface_grant: "surface:grok:production", monthly_allowance: 2, source: "personal" })
    ]));

    const access = await admin(fixture, `https://admin.example.test/admin?view=access&person=${user.user.id}`, { method: "GET" });
    const html = await access.text();
    expect([...new JSDOM(html).window.document.querySelectorAll('[data-credit-surface="grok"] td:nth-child(3), [data-credit-surface="grok"] td:nth-child(4) strong, [data-credit-surface="grok"] td:nth-child(5) strong')].map(node=>node.textContent)).toEqual(['2','0','2']);

    fixture.db.seedSurfaceCreditUsage(user.user.id, "surface:grok:production", {
      consumed_credits: 1,
      admitted_attempts: 1,
      last_seen_at: "2026-06-24T10:01:00.000Z"
    });
    const usedAccess = await admin(
      fixture,
      `https://admin.example.test/admin?view=access&person=${user.user.id}`,
      { method: "GET" }
    );
    const usedHtml = await usedAccess.text();
    expect([...new JSDOM(usedHtml).window.document.querySelectorAll('[data-credit-surface="grok"] td:nth-child(3), [data-credit-surface="grok"] td:nth-child(4) strong, [data-credit-surface="grok"] td:nth-child(5) strong')].map(node=>node.textContent)).toEqual(['2','1','1']);

    const removed = await admin(
      fixture,
      `https://api.trustedtunnel.app/admin/users/${user.user.id}/credits/grok`,
      { method: "DELETE" }
    );
    const removedBody = await removed.json();
    expect(removedBody).toMatchObject({
      deleted: true,
      state: { source: "organization", monthly_allowance: 1000000, consumed_credits: 1 }
    });
    expect(JSON.stringify(removedBody)).not.toContain("unlimited");
    expect(fixture.db.operatorMutationAudit.map((row) => row.action)).toEqual(expect.arrayContaining([
      "credit_policy.set",
      "credit_policy.delete"
    ]));
  });

  it("board ChatGPT Auth lifecycle: absent Connect, authorizing strip, forbidden chrome", async () => {
    const fixture = makeFixture();
    fixture.db.ensureCredentialAccountsForScopes(["surface:codex:production"]);

    const blockedImport = await admin(fixture, "https://admin.example.test/admin/ui/codex-auth/import", {
      method: "POST",
      body: { confirm: true, access_token: "should-not-work" }
    });
    expect([404, 405]).toContain(blockedImport.status);

    const accountsPage = await admin(fixture, "https://admin.example.test/admin?view=credentials&account=codex%3Ashared_default", { method: "GET" });
    const html = await accountsPage.text();
    expect(html).toContain('data-auth-management="lifecycle"');
    expect(html).toContain('data-mgmt-state="absent"');
    expect(html).toContain('data-action="oauth-codex-start"');
    expect(html).toContain(">连接<");
    // Limits belong to the exact selected ChatGPT account.
    expect(html).toContain('data-codex-admin="true"');
    expect(html).toContain('data-chatgpt-upstream="true"');
    expect(html).toContain("上游用量与限制");
    expect(html).toMatch(/data-account-detail="codex:shared_default"[\s\S]*data-chatgpt-upstream="true"/);
    expect(html).not.toContain("1. Generate");
    expect(html).not.toContain("New link");
    expect(html).not.toContain("Pending session");
    expect(html).not.toContain("auth-steps");
    expect(html).not.toContain("import-codex-session");
    expect(html).not.toContain("name=\"session\"");
    expect(html).not.toMatch(/sk-[a-zA-Z0-9]{10,}/);
    expect(html).not.toMatch(/eyJ[a-zA-Z0-9_-]{20,}\./);

    const formStart = await adminForm(
      fixture,
      "https://admin.example.test/admin/ui/codex-auths/shared_default/oauth/start",
      new URLSearchParams()
    );
    expect(formStart.status).toBe(200);
    expect(formStart.headers.get("Content-Type")).toContain("text/html");
    expect(formStart.headers.get("Content-Security-Policy") ?? "").toContain("form-action 'self'");
    const formHtml = await formStart.text();
    expect(formHtml).toContain('data-mgmt-state="authorizing"');
    expect(formHtml).toContain('data-oauth-pending="true"');
    expect(formHtml).toContain("credential-body");
    expect(formHtml).toContain(">打开登录<");
    expect(formHtml).toContain(">保存回调地址<");
    expect(formHtml).toContain(">取消<");
    expect(formHtml).toContain('data-action="oauth-cancel"');
    expect(formHtml).toContain("auth.openai.com/oauth/authorize");
    // Guidance sits in the OAuth strip callout inside the card body (not under the title).
    expect(formHtml).toContain("credential-oauth-guide");
    expect(formHtml).toContain("请在浏览器中完成登录，然后粘贴回调地址并保存。");
    expect(formHtml).not.toContain("New link");
    expect(formHtml).not.toContain("Pending session");
    expect(formHtml).not.toContain("1. Generate");
    expect(fixture.db.operatorMutationAudit.some((row) => row.action === "credential.codex_oauth_start")).toBe(true);
  });

  it("does not complete a ChatGPT OAuth session into another Credential Account", async () => {
    const fixture = makeFixture();
    fixture.db.ensureCredentialAccountsForScopes(["surface:codex:production"]);
    const created = await admin(fixture, "https://api.trustedtunnel.app/admin/codex-auths", {
      method: "POST",
      body: { label: "Second ChatGPT" }
    });
    const second = await created.json() as { auth: { id: string } };
    const started = await admin(fixture, "https://api.trustedtunnel.app/admin/codex-auths/shared_default/oauth/start", {
      method: "POST",
      body: {}
    });
    const pending = await started.json() as { session_id: string; authorize_url: string };
    const state = new URL(pending.authorize_url).searchParams.get("state");

    const wrongAccount = await admin(
      fixture,
      `https://api.trustedtunnel.app/admin/codex-auths/${second.auth.id}/oauth/complete`,
      {
        method: "POST",
        body: { session_id: pending.session_id, state, code: "test-code" }
      }
    );
    expect(wrongAccount.status).toBe(400);
    await expect(wrongAccount.json()).resolves.toMatchObject({ error: { code: "oauth_account_mismatch" } });
  });

  it("board ChatGPT active: Refresh account, Reconnect, Disconnect", async () => {
    const fixture = makeFixture();
    setSharedCodexAuth(fixture, {
      status: "active",
      upstream_email: "op@example.com",
      upstream_account_id: "acct_test",
      expires_at: "2026-08-01T06:08:02.000Z",
      last_refresh_at: "2026-07-22T06:08:00.000Z"
    });

    const page = await admin(fixture, "https://admin.example.test/admin?view=credentials&account=codex%3Ashared_default", { method: "GET" });
    const html = await page.text();
    expect(html).toContain('data-mgmt-state="active"');
    expect(html).toContain('data-action="refresh-codex"');
    expect(html).toContain('data-action="oauth-codex-start"');
    expect(html).toContain('data-action="logout-codex"');
    expect(html).toContain(">刷新账号<");
    expect(html).toContain(">重新连接<");
    expect(html).toContain(">断开<");
    expect(html).toContain("op@example.com");
    expect(new JSDOM(html).window.document.querySelector('[data-account-detail="codex:shared_default"] .credential-status-meta')?.textContent).toContain("已连接");
    // No steady-state marketing captions.
    expect(html).not.toContain("Shared subscription");
    expect(html).not.toContain("People you authorize share");
    expect(html).not.toContain("New link");
    expect(html).not.toContain("Continue authorization");
    expect(html).not.toContain(">打开登录<");
    // Identity and status are shown together once per account.
    expect(html).toContain('data-codex-admin="true"');
    // Each account keeps its status beside its own actions.
    expect(html).toContain('data-account-detail="codex:shared_default"');
    expect(html).toContain("account-detail");
    expect(html).not.toContain('data-account-health="true"');
    expect(html).toContain("credential-status-meta");
    expect(html).toContain("credential-title-stack");
    expect(html).toContain("tone-ok");
    // Limits follow the selected account controls as a peer section.
    expect(html).toContain('data-chatgpt-upstream="true"');
    expect(html).toContain("上游用量与限制");
    expect(html).not.toMatch(/data-codex-admin="true"[^>]*[\s\S]{0,200}data-account-details="true"/);
    expect(html).not.toContain('class="caption credential-label"');

    const logout = await adminForm(
      fixture,
      "https://admin.example.test/admin/ui/codex-auths/shared_default/logout",
      new URLSearchParams({ confirm: "1" })
    );
    expect(logout.status).toBe(200);
    const logoutHtml = await logout.text();
    expect(logoutHtml).toContain('data-mutation-flash="credential_disconnected"');
    expect(logoutHtml).toContain("连接已断开，令牌清理已确认");
    expect(fixture.db.codexAuths.get("shared_default")?.status).toBe("revoked");
    expect(fixture.db.operatorMutationAudit.some((row) => row.action === "credential.disconnect")).toBe(true);
  });

  it("board can add an independent Grok Credential Account", async () => {
    const fixture = makeFixture();
    const response = await adminForm(
      fixture,
      "https://admin.example.test/admin/ui/subscriptions",
      new URLSearchParams({
        capability_source: "grok",
        environment: "production",
        label: "Second Grok account"
      })
    );

    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('data-mutation-flash="grok_created"');
    expect(html).toContain("Second Grok account");
    expect([...fixture.db.subscriptionAccounts.values()]).toHaveLength(1);
  });

  it.each(["codex", "grok"])("keeps every %s account form result on its exact account, search, linked-key page and range", async provider => {
    const fixture = makeFixture();
    const originalFetch = fixture.deps.fetch;
    fixture.deps.fetch = (async (input, init) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.endsWith("/token")) return Response.json({ access_token: "synthetic-access", refresh_token: "synthetic-refresh", token_type: "Bearer", expires_in: 3600 });
      return originalFetch(input, init);
    }) as typeof fetch;
    const base = `https://admin.example.test/admin/ui/${provider === "codex" ? "codex-auths" : "subscriptions"}`;
    const created = await adminForm(fixture, base, new URLSearchParams({ label: "Exact account", capability_source: "grok", environment: "production", return_range: "30d", return_q: "Other & 中文", return_page: "2" }));
    expect(created.status).toBe(200);
    const createdHtml = await created.text();
    const selected = createdHtml.match(/data-account-detail="([^"]+)"/)?.[1];
    expect(selected).toMatch(new RegExp(`^${provider}:`));
    const id = selected!.slice(provider.length + 1);
    const canonical = `/admin?view=credentials&amp;range=30d&amp;account=${encodeURIComponent(selected!)}&amp;q=Other+%26+%E4%B8%AD%E6%96%87&amp;page=2`;
    expect(createdHtml).toContain(`data-dashboard-url="${canonical}"`);
    expect(createdHtml).toContain('data-mgmt-state="absent"');

    const started = await adminForm(fixture, `${base}/${id}/oauth/start`, new URLSearchParams({ return_range: "30d", return_q: "Other & 中文", return_page: "2" }));
    expect(started.status).toBe(200);
    const pending = await started.text();
    expect(pending).toContain(`data-dashboard-url="${canonical}"`);
    const session = pending.match(/name="session_id" value="([^"]+)"/)?.[1];
    const open = pending.match(/<a\b[^>]*data-oauth-open="true"[^>]*>/)?.[0] ?? "";
    const loginUrl = open.match(/href="([^"]+)"/)?.[1]?.replace(/&amp;/g, "&");
    expect(session).toBeDefined();
    expect(loginUrl).toBeDefined();
    const cancel = pending.match(/<a\b[^>]*data-action="oauth-cancel"[^>]*>/)?.[0] ?? "";
    const cancelPath = cancel.match(/href="([^"]+)"/)?.[1]?.replace(/&amp;/g, "&");
    expect(cancelPath).toBeDefined();
    expect([...new URL(cancelPath!, base).searchParams]).toEqual([...new URL(canonical.replace(/&amp;/g, "&"), base).searchParams]);
    const completed = await adminForm(fixture, `${base}/${id}/oauth/complete`, new URLSearchParams({ confirm: "1", session_id: session!, state: new URL(loginUrl!).searchParams.get("state")!, code: "synthetic-code", return_range: "30d", return_q: "Other & 中文", return_page: "2" }));
    expect(completed.status).toBe(200);
    const completeHtml = await completed.text();
    expect(completeHtml).toContain(`data-dashboard-url="${canonical}"`);
    expect(completeHtml).toContain(`data-mutation-flash="${provider}_imported"`);
    expect(completeHtml).not.toContain('data-oauth-pending="true"');

    for (const operation of ["refresh", "logout"]) {
      const result = await adminForm(fixture, `${base}/${id}/${operation}`, new URLSearchParams({ confirm: "1", return_range: "30d", return_q: "Other & 中文", return_page: "2" }));
      expect(result.status).toBe(200);
      const html = await result.text();
      expect(html).toContain(`data-dashboard-url="${canonical}"`);
      expect(html).toContain(`data-account-detail="${selected}"`);
      if (operation === "logout") expect(html).toContain('data-mgmt-state="revoked"');
    }
  });

  it("keeps a completed account creation visible when subsequent account-list reads fail", async () => {
    const fixture = makeFixture({ dashboardReadFailure: "auth" });
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    onTestFinished(() => log.mockRestore());
    const result = await adminForm(fixture, "https://admin.example.test/admin/ui/subscriptions", new URLSearchParams({
      label: "Created before read failure", capability_source: "grok", environment: "production", return_range: "30d", return_q: "Other & 中文", return_page: "2"
    }));
    expect(result.status).toBe(503);
    const html = await result.text();
    const account = [...fixture.db.subscriptionAccounts.values()][0];
    expect(account).toBeDefined();
    expect(html).toContain('data-mutation-flash="grok_created"');
    expect(html).toContain("已添加 Grok 账号");
    expect(html).toContain("控制台暂时打不开");
    expect(html).toContain(`data-dashboard-url="/admin?view=credentials&amp;range=30d&amp;account=grok%3A${account.id}&amp;q=Other+%26+%E4%B8%AD%E6%96%87&amp;page=2"`);
  });

  it.each(["a".repeat(257), "bad\u0000search"])("ignores invalid return context after a confirmed account creation", async returnQuery => {
    const fixture = makeFixture();
    const result = await adminForm(fixture, "https://admin.example.test/admin/ui/codex-auths", new URLSearchParams({
      label: "Range check", return_range: "https://example.test/?range=invalid", return_q: returnQuery, return_page: "9007199254740991"
    }));
    expect(result.status).toBe(200);
    const html = await result.text();
    expect(html).toContain('data-mutation-flash="codex_created"');
    expect(html).toContain('data-dashboard-url="/admin?view=credentials&amp;range=7d&amp;account=codex%3A');
    expect(html).not.toContain("页面参数不正确");
    expect(html).toContain('name="return_q" value=""');
  });

  it("refreshes an account without changing or revoking any end-user key", async () => {
    const fixture = makeFixture();
    const user = await createUser(fixture, "refresh-is-safe@example.com");
    const key = await createKey(fixture, user.user.id, ["surface:codex:production"]);
    await importSharedAuth(fixture);
    fixture.tokenAuthority.savedToken!.refresh_token = "refresh_token";
    const before = structuredClone(fixture.db.apiKeys.get(key.key.id));

    const refreshed = await admin(fixture, "https://admin.example.test/admin/ui/codex-auths/shared_default/refresh", {
      method: "POST",
      body: { confirm: true }
    });

    expect(refreshed.status).toBe(200);
    expect(fixture.db.apiKeys.size).toBe(1);
    expect(fixture.db.apiKeys.get(key.key.id)).toEqual(before);
    const models = await handleRequest(new Request("https://api.trustedtunnel.app/v1/models", {
      headers: { Authorization: `Bearer ${key.api_key}` }
    }), fixture.env, fixture.ctx, fixture.deps);
    expect(models.status).toBe(200);
  });

  it("board ChatGPT reauth_required shows Reconnect primary", async () => {
    const fixture = makeFixture();
    setSharedCodexAuth(fixture, {
      status: "reauth_required",
      upstream_email: "stale@example.com",
      upstream_account_id: null,
      expires_at: null,
      last_refresh_at: null
    });
    const page = await admin(fixture, "https://admin.example.test/admin?view=credentials&account=codex%3Ashared_default", { method: "GET" });
    const html = await page.text();
    expect(html).toContain('data-mgmt-state="reauth_required"');
    expect(html).toContain('data-mgmt-actions="reauth logout"');
    expect(html).toContain(">重新连接<");
    expect(html).toContain(">断开<");
    expect(html).not.toContain('data-action="refresh-codex"');
  });

  it("board Grok confirmations preserve quoted labels without inline code", async () => {
    const fixture = makeFixture();
    const created = await admin(fixture, "https://api.trustedtunnel.app/admin/subscriptions", {
      method: "POST",
      body: {
        capability_source: "grok",
        environment: "production",
        label: `prod "mirror" x"><img src=x onerror=alert(1)>`
      }
    });
    expect(created.status).toBe(201);
    const { account } = await created.json() as { account: { id: string } };
    fixture.db.updateSubscriptionAccount(account.id, "active", "2026-08-01T00:00:00.000Z");
    const page = await admin(fixture, `https://admin.example.test/admin?view=credentials&account=${encodeURIComponent("grok:"+account.id)}`, { method: "GET" });
    const html = await page.text();
    expect(html).toContain('data-action="logout-grok"');
    // Confirmation data stays text, with no inline event handler or HTML injection.
    expect(html).not.toContain(" onsubmit=");
    expect(html).not.toContain("<img src=x");
    expect(html).toContain('data-confirmation="断开 Grok');
    const fallback = html.match(/data-confirmation-fallback[\s\S]{0,180}/)?.[0] ?? "";
    expect(fallback).toContain('type="checkbox"');
    expect(fallback).toContain("required");
    expect(html).toContain("&quot;");
    // Label still visible as text (escaped).
    expect(html).toContain("prod &quot;mirror&quot;");
  });

  it("rejects a non-Grok subscription account on the product board", async () => {
    const fixture = makeFixture();
    const created = await admin(fixture, "https://api.trustedtunnel.app/admin/subscriptions", {
      method: "POST",
      body: { capability_source: "chatgpt", environment: "production", label: "chatgpt-prod" }
    });
    expect(created.status).toBe(400);
    const page = await admin(fixture, "https://admin.example.test/admin?view=credentials", { method: "GET" });
    const html = await page.text();
    expect(html).toContain("ChatGPT");
    expect(html).toContain("Grok");
  });

  it("board Grok Auth lifecycle: Connect, authorizing, logout", async () => {
    const fixture = makeFixture();
    const created = await admin(fixture, "https://api.trustedtunnel.app/admin/subscriptions", {
      method: "POST",
      body: { capability_source: "grok", environment: "production", label: "grok-prod" }
    });
    expect(created.status).toBe(201);
    const { account } = await created.json() as { account: { id: string } };

    const blockedImport = await admin(fixture, `https://admin.example.test/admin/ui/subscriptions/${account.id}/import`, {
      method: "POST",
      body: { confirm: true, session: "{}" }
    });
    expect([404, 405]).toContain(blockedImport.status);

    const page = await admin(fixture, `https://admin.example.test/admin?view=credentials&account=${encodeURIComponent("grok:"+account.id)}`, { method: "GET" });
    const html = await page.text();
    expect(html).toContain('data-grok-admin="true"');
    expect(html).toContain('data-action="oauth-grok-start"');
    expect(html).toContain(">连接<");
    expect(html).not.toContain("1. Generate Grok");
    expect(html).not.toContain("New link");
    expect(html).not.toContain("import-grok-session");
    expect(html).not.toContain("auth-steps");

    const formStart = await adminForm(
      fixture,
      `https://admin.example.test/admin/ui/subscriptions/${account.id}/oauth/start`,
      new URLSearchParams()
    );
    expect(formStart.status).toBe(200);
    const formHtml = await formStart.text();
    expect(formHtml).toContain('data-oauth-pending="true"');
    expect(formHtml).toContain(">打开登录<");
    expect(formHtml).toContain('data-action="oauth-grok-complete"');
    expect(formHtml).toContain(">保存回调地址<");
    expect(formHtml).not.toContain("Pending session");
    expect(formHtml).not.toContain("New link");
    expect(fixture.db.operatorMutationAudit.some((row) => row.action === "credential.grok_oauth_start")).toBe(true);

    // Mark account active then logout
    fixture.db.updateSubscriptionAccount(account.id, "active", "2026-08-01T00:00:00.000Z");
    const activePage = await admin(fixture, `https://admin.example.test/admin?view=credentials&account=${encodeURIComponent("grok:"+account.id)}`, { method: "GET" });
    const activeHtml = await activePage.text();
    expect(activeHtml).toContain('data-mgmt-state="active"');
    expect(activeHtml).toContain('data-action="logout-grok"');
    expect(activeHtml).toContain(">刷新账号<");
    expect(activeHtml).toContain(">重新连接<");
    // Product, account label, and state remain explicit on the same card.
    const header = new JSDOM(activeHtml).window.document.querySelector(".credential-card-head");
    const title = header?.querySelector(".credential-title-stack");
    expect(title?.querySelector("h2")?.textContent).toBe("grok-prod");
    expect(title?.querySelector(".credential-title-label")?.textContent).toBe("Grok");
    const connection = header?.querySelector(".credential-status-meta");
    expect(connection?.textContent).toBe("已连接");
    expect(connection?.classList.contains("tone-ok")).toBe(true);
    expect(activeHtml).not.toContain('data-account-health="true"');
    expect(activeHtml).toContain(`data-account-detail="grok:${account.id}"`);
    expect(activeHtml).not.toContain('data-chatgpt-upstream="true"');
    expect(activeHtml).not.toContain('class="caption credential-label"');

    const logout = await adminForm(
      fixture,
      `https://admin.example.test/admin/ui/subscriptions/${account.id}/logout`,
      new URLSearchParams({ confirm: "1" })
    );
    expect(logout.status).toBe(200);
    const logoutHtml = await logout.text();
    expect(logoutHtml).toContain('data-mutation-flash="credential_disconnected"');
    expect(logoutHtml).toContain("连接已断开，令牌清理已确认");
    expect(fixture.db.subscriptionAccounts.get(account.id)?.status).toBe("revoked");
    expect(fixture.db.operatorMutationAudit.some((row) => row.action === "credential.disconnect")).toBe(true);
  });

  it("does not complete a Grok OAuth session into another Credential Account", async () => {
    const fixture = makeFixture();
    const firstResponse = await admin(fixture, "https://api.trustedtunnel.app/admin/subscriptions", {
      method: "POST",
      body: { capability_source: "grok", environment: "production", label: "Grok A" }
    });
    const secondResponse = await admin(fixture, "https://api.trustedtunnel.app/admin/subscriptions", {
      method: "POST",
      body: { capability_source: "grok", environment: "production", label: "Grok B" }
    });
    const first = await firstResponse.json() as { account: { id: string } };
    const second = await secondResponse.json() as { account: { id: string } };
    const started = await admin(
      fixture,
      `https://api.trustedtunnel.app/admin/subscriptions/${first.account.id}/oauth/start`,
      { method: "POST", body: {} }
    );
    const pending = await started.json() as { session_id: string; authorize_url: string };
    const state = new URL(pending.authorize_url).searchParams.get("state");

    const wrongAccount = await admin(
      fixture,
      `https://api.trustedtunnel.app/admin/subscriptions/${second.account.id}/oauth/complete`,
      {
        method: "POST",
        body: { session_id: pending.session_id, state, code: "test-code" }
      }
    );
    expect(wrongAccount.status).toBe(400);
    await expect(wrongAccount.json()).resolves.toMatchObject({ error: { code: "oauth_account_mismatch" } });
  });

  it("CLI key create and revoke write operator mutation audit as admin_secret", async () => {
    const fixture = makeFixture();
    const user = await createUser(fixture, "cli-audit@example.com");
    const key = await createKey(fixture, user.user.id, ["surface:codex:production"]);
    expect(fixture.db.operatorMutationAudit.some((row) =>
      row.action === "key.create" && row.actor_kind === "admin_secret" && row.target_id === key.key.id
    )).toBe(true);

    const revoked = await admin(fixture, `https://api.trustedtunnel.app/admin/keys/${key.key.id}`, {
      method: "DELETE"
    });
    expect(revoked.status).toBe(200);
    expect(fixture.db.operatorMutationAudit.some((row) =>
      row.action === "key.revoke" && row.actor_kind === "admin_secret" && row.target_id === key.key.id
    )).toBe(true);
  });

  it("accepts a console session only on the dashboard host", async () => {
    const fixture = makeFixture();
    seedDashboardAdmin(fixture);
    const headers = { Cookie: `__Host-mini-console=${await consoleCookie(fixture, "operator@example.com")}` };

    const dashboard = await handleRequest(new Request("https://admin.example.test/", { headers }), fixture.env, fixture.ctx, fixture.deps);
    expect(dashboard.status).toBe(200);
    await expect(dashboard.text()).resolves.toContain("operator@example.com");

    for (const path of ["app.webmanifest", "app-worker.js", "app-icon-192.png", "app-icon-512.png", "console.js"]) {
      const resource = await handleRequest(new Request(`https://admin.example.test/admin/${path}`, { headers }), fixture.env, fixture.ctx, fixture.deps);
      expect(resource.status).toBe(200);
      const denied = await handleRequest(new Request(`https://admin.example.test/admin/${path}`, {
        headers: { Authorization: `Bearer ${fixture.env.ADMIN_SECRET}` }
      }), fixture.env, fixture.ctx, fixture.deps);
      expect(denied.status).toBe(403);
      const wrongHost = await admin(fixture, `https://api.trustedtunnel.app/admin/${path}`, { method: "GET" });
      expect(wrongHost.status).toBe(404);
    }

    const usage = await handleRequest(new Request("https://admin.example.test/admin/usage?scope=all&limit=10", { headers }), fixture.env, fixture.ctx, fixture.deps);
    expect(usage.status).toBe(200);
    expect(usage.headers.get("Cache-Control")).toBe("no-store");

    const codexAuth = await handleRequest(new Request("https://admin.example.test/admin/codex-auths", { headers }), fixture.env, fixture.ctx, fixture.deps);
    expect(codexAuth.status).toBe(200);
    expect(codexAuth.headers.get("Cache-Control")).toBe("no-store");

    const mutation = await handleRequest(new Request("https://admin.example.test/admin/request-audit/cleanup", {
      method: "POST",
      headers
    }), fixture.env, fixture.ctx, fixture.deps);
    expect([403, 404]).toContain(mutation.status);

    const apiAdmin = await handleRequest(new Request("https://api.trustedtunnel.app/admin/usage", { headers }), fixture.env, fixture.ctx, fixture.deps);
    expect(apiAdmin.status).toBe(403);
    await expect(apiAdmin.json()).resolves.toMatchObject({ error: { code: "admin_auth_required" } });

    const rejected = await handleRequest(new Request("https://admin.example.test/", {
      headers: { Cookie: "__Host-mini-console=not-a-session" }
    }), fixture.env, fixture.ctx, fixture.deps);
    expect(rejected.status).toBe(403);
    await expect(rejected.json()).resolves.toMatchObject({ error: { code: "admin_auth_required" } });
  });

  it("rejects non-admin usage queries", async () => {
    const fixture = makeFixture();

    const response = await handleRequest(new Request("https://admin.example.test/admin/usage?scope=all&limit=100"), fixture.env, fixture.ctx, fixture.deps);

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "admin_auth_required" }
    });
  });

  it("requires bearer authorization for admin requests", async () => {
    const fixture = makeFixture();
    const response = await handleRequest(new Request("https://api.trustedtunnel.app/admin/usage?scope=all&limit=100", {
      headers: {
        Authorization: "Basic admin-secret",
        "X-Authorization": "admin-secret"
      }
    }), fixture.env, fixture.ctx, fixture.deps);

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "admin_auth_required" }
    });
  });

  it("does not execute CLI mutations on the dashboard hostname", async () => {
    const fixture = makeFixture();
    const response = await handleRequest(new Request("https://admin.example.test/admin/request-audit/cleanup", {
      method: "POST",
      headers: { Authorization: "Bearer admin-secret" }
    }), fixture.env, fixture.ctx, fixture.deps);

    expect(response.status).toBe(404);
    expect(fixture.db.preparedSql.some((sql) => sql.includes("DELETE FROM request_audit"))).toBe(false);
  });

  it("returns admin usage summary rows from D1", async () => {
    const fixture = makeFixture();
    setUsageSummary(fixture, {
      requests: 11,
      ok_requests: 10,
      error_requests: 1,
      input_tokens: 124,
      cached_input_tokens: 62,
      output_tokens: 81,
      reasoning_tokens: 20,
      total_tokens: 205,
      token_measurements: 11,
      provider_cost_usd_ticks: 0,
      cost_measurements: 0,
      api_equivalent_usd_ticks: 0,
      api_equivalent_measurements: 0
    }, [
      usageRow({
        first_day: "2026-06-24",
        last_day: "2026-06-24",
        user_id: "usr_bob",
        email: "bob-usage@example.com",
        model: "gpt-5.5",
        requests: 5,
        ok_requests: 5,
        input_tokens: 40,
        cached_input_tokens: 8,
        output_tokens: 50,
        reasoning_tokens: 9,
        total_tokens: 90,
        token_measurements: 5,
        last_seen_at: "2026-06-24T02:30:00.000Z"
      }),
      usageRow({
        first_day: "2026-06-24",
        last_day: "2026-06-24",
        user_id: "usr_alice",
        email: "alice-usage@example.com",
        model: "gpt-5.5",
        requests: 3,
        ok_requests: 3,
        input_tokens: 70,
        cached_input_tokens: 50,
        output_tokens: 5,
        reasoning_tokens: 4,
        total_tokens: 75,
        token_measurements: 3,
        last_seen_at: "2026-06-24T02:00:00.000Z"
      }),
      usageRow({
        first_day: "2026-06-23",
        last_day: "2026-06-24",
        user_id: "usr_alice",
        email: "alice-usage@example.com",
        model: "gpt-5.4",
        requests: 3,
        ok_requests: 2,
        error_requests: 1,
        input_tokens: 14,
        cached_input_tokens: 4,
        output_tokens: 26,
        reasoning_tokens: 7,
        total_tokens: 40,
        token_measurements: 3,
        last_seen_at: "2026-06-24T01:00:00.000Z"
      })
    ]);
    setMediaUsageSummary(fixture, {
      started_jobs: 1,
      completed_jobs: 1,
      failed_jobs: 0,
      expired_jobs: 0,
      outputs: 1,
      video_seconds: 0,
      output_measurements: 1,
      duration_measurements: 0,
      provider_cost_usd_ticks: 500000000,
      cost_measurements: 1
    }, [{
      first_day: "2026-06-24",
      last_day: "2026-06-24",
      user_id: "usr_bob",
      email: "bob-usage@example.com",
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
      last_seen_at: "2026-06-24T03:00:00.000Z"
    }]);

    const response = await admin(fixture, "https://admin.example.test/admin/usage?scope=all&limit=10", { method: "GET" });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      kind: "usage_summary",
      source: ["usage_daily", "media_usage_daily"],
      timezone: "UTC",
      granularity: "user_plan_model",
      filters: {
        scope: "all",
        day: null,
        from: null,
        to: null,
        user_id: null,
        route_profile_id: null,
        response_model: null,
        q: null,
        limit: 10
      },
      totals: {
        requests: 11,
        ok_requests: 10,
        error_requests: 1,
        input_tokens: 124,
        cached_input_tokens: 62,
        output_tokens: 81,
        reasoning_tokens: 20,
        total_tokens: 205,
        token_measurements: 11,
        provider_cost_usd_ticks: 0,
        cost_measurements: 0,
        api_equivalent_usd_ticks: 0,
        api_equivalent_measurements: 0
      },
      rows: [
        {
          first_day: "2026-06-24",
          last_day: "2026-06-24",
          user_id: "usr_bob",
          email: "bob-usage@example.com",
          route_profile_id: "codex.responses",
          response_model: "gpt-5.5",
          requests: 5,
          ok_requests: 5,
          error_requests: 0,
          input_tokens: 40,
          cached_input_tokens: 8,
          output_tokens: 50,
          reasoning_tokens: 9,
          total_tokens: 90,
          token_measurements: 5,
          provider_cost_usd_ticks: 0,
          cost_measurements: 0,
          api_equivalent_usd_ticks: 0,
          api_equivalent_measurements: 0,
          last_seen_at: "2026-06-24T02:30:00.000Z"
        },
        {
          first_day: "2026-06-24",
          last_day: "2026-06-24",
          user_id: "usr_alice",
          email: "alice-usage@example.com",
          route_profile_id: "codex.responses",
          response_model: "gpt-5.5",
          requests: 3,
          ok_requests: 3,
          error_requests: 0,
          input_tokens: 70,
          cached_input_tokens: 50,
          output_tokens: 5,
          reasoning_tokens: 4,
          total_tokens: 75,
          token_measurements: 3,
          provider_cost_usd_ticks: 0,
          cost_measurements: 0,
          api_equivalent_usd_ticks: 0,
          api_equivalent_measurements: 0,
          last_seen_at: "2026-06-24T02:00:00.000Z"
        },
        {
          first_day: "2026-06-23",
          last_day: "2026-06-24",
          user_id: "usr_alice",
          email: "alice-usage@example.com",
          route_profile_id: "codex.responses",
          response_model: "gpt-5.4",
          requests: 3,
          ok_requests: 2,
          error_requests: 1,
          input_tokens: 14,
          cached_input_tokens: 4,
          output_tokens: 26,
          reasoning_tokens: 7,
          total_tokens: 40,
          token_measurements: 3,
          provider_cost_usd_ticks: 0,
          cost_measurements: 0,
          api_equivalent_usd_ticks: 0,
          api_equivalent_measurements: 0,
          last_seen_at: "2026-06-24T01:00:00.000Z"
        }
      ],
      media_totals: {
        started_jobs: 1,
        completed_jobs: 1,
        failed_jobs: 0,
        expired_jobs: 0,
        outputs: 1,
        video_seconds: 0,
        output_measurements: 1,
        duration_measurements: 0,
        provider_cost_usd_ticks: 500000000,
        cost_measurements: 1
      },
      media_rows: [{
        first_day: "2026-06-24",
        last_day: "2026-06-24",
        user_id: "usr_bob",
        email: "bob-usage@example.com",
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
        last_seen_at: "2026-06-24T03:00:00.000Z"
      }]
    });
  });

  it("filters admin usage by day, user, and response model", async () => {
    const fixture = makeFixture();
    const userId = "usr_filter";
    setUsageSummary(fixture, {
      requests: 2,
      ok_requests: 2,
      error_requests: 0,
      input_tokens: 20,
      cached_input_tokens: 4,
      output_tokens: 10,
      reasoning_tokens: 2,
      total_tokens: 30,
      token_measurements: 2,
      provider_cost_usd_ticks: 0,
      cost_measurements: 0,
      api_equivalent_usd_ticks: 0,
      api_equivalent_measurements: 0
    }, [
      usageRow({
        first_day: "2026-06-24",
        last_day: "2026-06-24",
        user_id: userId,
        email: "filter-usage@example.com",
        model: "gpt-5.5",
        response_model: "gpt-5.5-2026-07-01",
        requests: 2,
        ok_requests: 2,
        input_tokens: 20,
        cached_input_tokens: 4,
        output_tokens: 10,
        reasoning_tokens: 2,
        total_tokens: 30,
        last_seen_at: "2026-06-24T01:00:00.000Z"
      })
    ]);

    const response = await admin(fixture, `https://admin.example.test/admin/usage?day=2026-06-24&user_id=${userId}&route_profile_id=codex.responses&response_model=gpt-5.5-2026-07-01&limit=100`, { method: "GET" });

    expect(response.status).toBe(200);
    const body = await response.json() as {
      filters: Record<string, unknown>;
      totals: Record<string, unknown>;
      rows: Array<Record<string, unknown>>;
    };
    expect(body.filters).toEqual({
      scope: null,
      day: "2026-06-24",
      from: null,
      to: null,
      user_id: userId,
      route_profile_id: "codex.responses",
      response_model: "gpt-5.5-2026-07-01",
      q: null,
      limit: 100
    });
    expect(body.totals).toMatchObject({ requests: 2, total_tokens: 30 });
    expect(body.rows).toHaveLength(1);
    expect(body.rows[0]).toMatchObject({
      first_day: "2026-06-24",
      last_day: "2026-06-24",
      user_id: userId,
      response_model: "gpt-5.5-2026-07-01",
      requests: 2,
      total_tokens: 30
    });
    expect(fixture.db.preparedSql.join("\n")).toContain("ud.day = ?");
    expect(fixture.db.preparedSql.join("\n")).toContain("ud.user_id = ?");
    expect(fixture.db.preparedSql.join("\n")).toContain("ud.route_profile_id = ?");
    expect(fixture.db.preparedSql.join("\n")).toContain("mu.route_profile_id = ?");
    expect(fixture.db.preparedSql.join("\n")).toContain("ud.response_model = ?");
    expect(fixture.db.preparedBindings).toEqual(expect.arrayContaining([
      ["2026-06-24", userId, "codex.responses", "gpt-5.5-2026-07-01"],
      ["2026-06-24", userId, "codex.responses", "gpt-5.5-2026-07-01", 100],
      ["2026-06-24", userId, "codex.responses"],
      ["2026-06-24", userId, "codex.responses", 100]
    ]));
  });

  it("returns zero totals for empty admin usage ranges", async () => {
    const fixture = makeFixture();

    const response = await admin(fixture, "https://admin.example.test/admin/usage?from=2026-06-01&to=2026-06-02&limit=100", { method: "GET" });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      totals: {
        requests: 0,
        ok_requests: 0,
        error_requests: 0,
        input_tokens: 0,
        cached_input_tokens: 0,
        output_tokens: 0,
        reasoning_tokens: 0,
        total_tokens: 0
      },
      rows: []
    });
  });

  it.each([
    ["https://admin.example.test/admin/usage?scope=all", "invalid_limit"],
    ["https://admin.example.test/admin/usage?scope=all&limit=0", "invalid_limit"],
    ["https://admin.example.test/admin/usage?scope=all&limit=1001", "invalid_limit"],
    ["https://admin.example.test/admin/usage?scope=all&limit=1x", "invalid_limit"],
    ["https://admin.example.test/admin/usage?user_id=alice&limit=100", "invalid_usage_filters"],
    ["https://admin.example.test/admin/usage?scope=all&day=2026-06-24&limit=100", "invalid_usage_filters"],
    ["https://admin.example.test/admin/usage?from=2026-06-24&limit=100", "invalid_usage_filters"],
    ["https://admin.example.test/admin/usage?from=2026-06-25&to=2026-06-24&limit=100", "invalid_usage_range"],
    ["https://admin.example.test/admin/usage?day=2026-99-99&limit=100", "invalid_day"],
    ["https://admin.example.test/admin/usage?scope=latest&limit=100", "invalid_usage_filters"],
    ["https://admin.example.test/admin/usage?scope=all&day=&limit=100", "invalid_day"],
    ["https://admin.example.test/admin/usage?scope=all&limit=100&limit=1001", "invalid_usage_filters"],
    ["https://admin.example.test/admin/usage?scope=all&model=gpt-5.4&limit=100", "invalid_usage_filters"],
    ["https://admin.example.test/admin/usage?scope=all&requested_model=gpt-5.4&limit=100", "invalid_usage_filters"],
    ["https://admin.example.test/admin/usage?scope=all&timezone=Asia%2FShanghai&limit=100", "invalid_usage_filters"]
  ])("rejects invalid admin usage query %s", async (url, code) => {
    const fixture = makeFixture();

    const response = await admin(fixture, url, { method: "GET" });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code }
    });
  });

  it("reports usage schema failures as unavailable", async () => {
    const fixture = makeFixture({ usageSchema: "missing" });

    const response = await admin(fixture, "https://admin.example.test/admin/usage?scope=all&limit=100", { method: "GET" });

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "usage_schema_unavailable" }
    });
  });

  it("atomically commits audit metadata and Responses usage at terminal observation", async () => {
    const fixture = makeFixture();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      const user = await createUser(fixture, "hank@example.com");
      const key = await createKey(fixture, user.user.id, ["surface:codex:production"]);
      await importSharedAuth(fixture);

      const response = await handleRequest(new Request("https://api.trustedtunnel.app/v1/responses", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${key.api_key}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ model: "gpt-5.4", input: "stream-usage", stream: true })
      }), fixture.env, fixture.ctx, fixture.deps);
      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Type")).toContain("text/event-stream");

      expect(fixture.db.audit).toHaveLength(0);
      expect(fixture.db.usageDaily.size).toBe(0);

      await response.text();
      await fixture.ctx.flush();
      expect(fixture.db.audit).toHaveLength(1);
      expect(fixture.db.audit[0]).toMatchObject({
        user_id: user.user.id,
        key_id: key.key.id,
        route: "/v1/responses",
        status: "ok",
        upstream_status: 200,
        response_id: "resp_stream_usage",
        input_tokens: 11,
        output_tokens: 13,
        total_tokens: 24
      });
      expect(fixture.db.usageDaily.get(`${user.user.id}:2026-06-24:codex.responses:gpt-5.4`)).toMatchObject({
        requests: 1,
        input_tokens: 11,
        cached_input_tokens: 4,
        output_tokens: 13,
        reasoning_tokens: 5,
        total_tokens: 24
      });
    } finally {
      logSpy.mockRestore();
    }
  });

  it("keeps streaming request counters when the client cancels before response.completed", async () => {
    const fixture = makeFixture();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      const user = await createUser(fixture, "iris@example.com");
      const key = await createKey(fixture, user.user.id, ["surface:codex:production"]);
      await importSharedAuth(fixture);

      const response = await handleRequest(new Request("https://api.trustedtunnel.app/v1/responses", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${key.api_key}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ model: "gpt-5.4", input: "stream-cancel-before-completed", stream: true })
      }), fixture.env, fixture.ctx, fixture.deps);
      expect(response.status).toBe(200);
      const reader = response.body?.getReader();
      expect(reader).toBeTruthy();
      const firstChunk = await reader!.read();
      expect(new TextDecoder().decode(firstChunk.value)).toContain("response.created");
      await reader!.cancel("client disconnected");

      await fixture.ctx.flush();

      expect(fixture.db.usageDaily.get(`${user.user.id}:2026-06-24:codex.responses:N/A`)).toMatchObject({
        requests: 1,
        ok_requests: 1,
        error_requests: 0,
        input_tokens: 0,
        output_tokens: 0,
        total_tokens: 0
      });
      expect(fixture.db.audit[0]).toMatchObject({
        route: "/v1/responses",
        status: "ok",
        response_id: null,
        input_tokens: null,
        output_tokens: null,
        total_tokens: null
      });
    } finally {
      logSpy.mockRestore();
    }
  });

  it("captures streaming usage after pass-through consumption", async () => {
    const fixture = makeFixture();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      const user = await createUser(fixture, "fran@example.com");
      const key = await createKey(fixture, user.user.id, ["surface:codex:production"]);
      await importSharedAuth(fixture);

      const response = await handleRequest(new Request("https://api.trustedtunnel.app/v1/responses", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${key.api_key}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ model: "gpt-5.4", input: "stream-usage", stream: true })
      }), fixture.env, fixture.ctx, fixture.deps);
      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Type")).toContain("text/event-stream");
      const streamed = await response.text();
      expect(streamed).toContain("response.created");
      expect(streamed).toContain("response.completed");

      await fixture.ctx.flush();
      expect(fixture.db.usageDaily.get(`${user.user.id}:2026-06-24:codex.responses:gpt-5.4`)).toMatchObject({
        requests: 1,
        ok_requests: 1,
        error_requests: 0,
        input_tokens: 11,
        cached_input_tokens: 4,
        output_tokens: 13,
        reasoning_tokens: 5,
        total_tokens: 24
      });
      expect(fixture.db.audit[0]).toMatchObject({
        response_id: "resp_stream_usage",
        input_tokens: 11,
        cached_input_tokens: 4,
        output_tokens: 13,
        reasoning_tokens: 5,
        total_tokens: 24
      });
    } finally {
      logSpy.mockRestore();
    }
  });

  it("keeps a streaming response model on the request-start UTC day", async () => {
    const fixture = makeFixture();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      const user = await createUser(fixture, "midnight@example.com");
      const key = await createKey(fixture, user.user.id, ["surface:codex:production"]);
      await importSharedAuth(fixture);
      fixture.deps.now = () => new Date("2026-06-24T23:59:59.900Z");

      const response = await handleRequest(new Request("https://api.trustedtunnel.app/v1/responses", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${key.api_key}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ model: "gpt-5.4", input: "stream-usage", stream: true })
      }), fixture.env, fixture.ctx, fixture.deps);
      fixture.deps.now = () => new Date("2026-06-25T00:00:00.100Z");

      await response.text();
      await fixture.ctx.flush();

      expect(fixture.db.usageDaily.get(`${user.user.id}:2026-06-24:codex.responses:gpt-5.4`)).toMatchObject({
        requests: 1,
        total_tokens: 24
      });
      expect([...fixture.db.usageDaily.keys()].some((keyValue) => keyValue.includes(":2026-06-25:"))).toBe(false);
    } finally {
      logSpy.mockRestore();
    }
  });

  it("keeps first and last seen ordered when streams complete out of request order", async () => {
    const fixture = makeFixture();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      const user = await createUser(fixture, "out-of-order@example.com");
      const key = await createKey(fixture, user.user.id, ["surface:codex:production"]);
      await importSharedAuth(fixture);
      const request = () => new Request("https://api.trustedtunnel.app/v1/responses", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${key.api_key}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ model: "gpt-5.4", input: "stream-usage", stream: true })
      });

      fixture.deps.now = () => new Date("2026-06-24T10:00:00.000Z");
      const first = await handleRequest(request(), fixture.env, fixture.ctx, fixture.deps);
      fixture.deps.now = () => new Date("2026-06-24T10:01:00.000Z");
      const second = await handleRequest(request(), fixture.env, fixture.ctx, fixture.deps);

      await second.text();
      await fixture.ctx.flush();
      await first.text();
      await fixture.ctx.flush();

      expect(fixture.db.usageDaily.get(`${user.user.id}:2026-06-24:codex.responses:gpt-5.4`)).toMatchObject({
        requests: 2,
        first_seen_at: "2026-06-24T10:00:00.000Z",
        last_seen_at: "2026-06-24T10:01:00.000Z"
      });
    } finally {
      logSpy.mockRestore();
    }
  });

  it("applies duplicate streaming terminal usage exactly once", async () => {
    const fixture = makeFixture();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      const user = await createUser(fixture, "jules@example.com");
      const key = await createKey(fixture, user.user.id, ["surface:codex:production"]);
      await importSharedAuth(fixture);

      const response = await handleRequest(new Request("https://api.trustedtunnel.app/v1/responses", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${key.api_key}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ model: "gpt-5.4", input: "stream-duplicate-usage", stream: true })
      }), fixture.env, fixture.ctx, fixture.deps);
      expect(response.status).toBe(200);
      await response.text();
      await fixture.ctx.flush();

      expect(fixture.db.usageDaily.get(`${user.user.id}:2026-06-24:codex.responses:gpt-5.4`)).toMatchObject({
        requests: 1,
        ok_requests: 1,
        input_tokens: 11,
        cached_input_tokens: 4,
        output_tokens: 13,
        reasoning_tokens: 5,
        total_tokens: 24
      });
      expect(fixture.db.audit).toHaveLength(1);
      expect(fixture.db.audit[0]).toMatchObject({
        response_id: "resp_stream_usage",
        total_tokens: 24
      });
    } finally {
      logSpy.mockRestore();
    }
  });

  it("cleans up old request_audit rows without deleting usage_daily", async () => {
    const fixture = makeFixture({ env: { REQUEST_AUDIT_RETENTION_DAYS: "30" } });
    fixture.db.seedAudits(
      { id: "old", user_id: "usr_old", status: "ok", created_at: "2026-05-01T00:00:00.000Z" },
      { id: "fresh", user_id: "usr_new", status: "ok", created_at: "2026-06-01T00:00:00.000Z" }
    );
    fixture.db.seedUsage({
      user_id: "usr_old",
      day: "2026-05-01",
      route_profile_id: "N/A",
      response_model: "N/A",
      requests: 10
    });

    const cleanup = await admin(fixture, "https://api.trustedtunnel.app/admin/request-audit/cleanup", { method: "POST" });
    expect(cleanup.status).toBe(200);
    await expect(cleanup.json()).resolves.toEqual({
      deleted: 1,
      retention_days: 30,
      cutoff: "2026-05-25T00:00:00.000Z"
    });
    expect(fixture.db.audit.map((row) => row.id)).toEqual(["fresh"]);
    expect(fixture.db.usageDaily.get("usr_old:2026-05-01:N/A:N/A")).toMatchObject({ requests: 10 });
  });

  it("runs scheduled request_audit cleanup with the admin retention logic", async () => {
    const fixture = makeFixture({ env: { REQUEST_AUDIT_RETENTION_DAYS: "10" } });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      fixture.db.seedAudits(
        { id: "old", user_id: "usr_old", status: "ok", created_at: "2026-06-01T00:00:00.000Z" },
        { id: "fresh", user_id: "usr_new", status: "ok", created_at: "2026-06-20T00:00:00.000Z" }
      );
      fixture.db.seedUsage({
        user_id: "usr_old",
        day: "2026-06-01",
        route_profile_id: "N/A",
        response_model: "N/A",
        requests: 3
      });
      fixture.db.seedVideoJobs(
        { request_id_hash: "old", updated_at: "2026-06-01T00:00:00.000Z" },
        { request_id_hash: "fresh", updated_at: "2026-06-20T00:00:00.000Z" }
      );

      const retentionCron = scheduledCrons().find((cron) => cron !== IDENTITY_VERSION_CRON);
      expect(retentionCron).toBeTruthy();
      handleScheduled({
        cron: retentionCron ?? "",
        scheduledTime: Date.parse("2026-06-24T03:17:00.000Z"),
        noRetry: vi.fn()
      } as unknown as ScheduledController, fixture.env, fixture.ctx, fixture.deps);
      await fixture.ctx.flush();

      expect(fixture.db.audit.map((row) => row.id)).toEqual(["fresh"]);
      expect(fixture.db.videoJobs.map((row) => row.request_id_hash)).toEqual(["fresh"]);
      expect(fixture.db.usageDaily.get("usr_old:2026-06-01:N/A:N/A")).toMatchObject({ requests: 3 });
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("\"retention_days\":10"));
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("\"cutoff\":\"2026-06-14T00:00:00.000Z\""));
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("\"video_jobs_deleted\":1"));
    } finally {
      logSpy.mockRestore();
    }
  });

  it.each([undefined, "0", "30days", "3651"])(
    "rejects invalid request audit retention config %j",
    async (retentionDays) => {
      const fixture = makeFixture({
        env: { REQUEST_AUDIT_RETENTION_DAYS: retentionDays } as Partial<Env>
      });
      const cleanup = await admin(fixture, "https://api.trustedtunnel.app/admin/request-audit/cleanup", { method: "POST" });
      expect(cleanup.status).toBe(500);
      await expect(cleanup.json()).resolves.toMatchObject({
        error: { code: "invalid_request_audit_retention_days" }
      });
    }
  );

  it("reports request_audit schema drift without suppressing the accounting failure", async () => {
    const fixture = makeFixture({ requestAuditSchema: "missing" });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const user = await createUser(fixture, "gina@example.com");
      const key = await createKey(fixture, user.user.id, ["surface:codex:production"]);
      await importSharedAuth(fixture);

      const response = await handleRequest(new Request("https://api.trustedtunnel.app/v1/responses", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${key.api_key}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ model: "gpt-5.4", input: "with-usage", stream: true })
      }), fixture.env, fixture.ctx, fixture.deps);
      expect(response.status).toBe(200);
      await response.text();
      await fixture.ctx.flush();

      expect(fixture.db.audit).toHaveLength(0);
      expect(logSpy).toHaveBeenCalledTimes(1);
      const outcome = String(logSpy.mock.calls[0][0]);
      expect(outcome).toContain('"observation_error_code":"request_accounting_failed"');
      expect(outcome).toContain('"observation_stage":"request_accounting"');
      expect(outcome).not.toContain("no column named request_id");
      expect(errorSpy).toHaveBeenCalledTimes(1);
      expect(String(errorSpy.mock.calls[0][0])).toBe(
        '{"event":"request_accounting_failed","plan_id":"codex.responses"}'
      );
    } finally {
      logSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });
});

function setUsageSummary(fixture: Fixture, totals: UsageSummaryTotals, rows: UsageSummaryRow[]): void {
  fixture.db.seedUsageSummary(totals, rows);
}

function setMediaUsageSummary(fixture: Fixture, totals: MediaUsageSummaryTotals, rows: MediaUsageSummaryRow[]): void {
  fixture.db.seedMediaUsageSummary(totals, rows);
}

function setSharedCodexAuth(fixture: Fixture, input: {
  status: string;
  upstream_email: string | null;
  upstream_account_id: string | null;
  expires_at: string | null;
  last_refresh_at: string | null;
}): void {
  fixture.db.seedCodexAuth({
    id: SHARED_CODEX_AUTH_ID,
    kind: "shared",
    ...input,
    created_at: "2026-06-23T00:00:00.000Z",
    updated_at: "2026-06-24T00:00:00.000Z"
  });
}

function usageRow(row: Partial<UsageSummaryRow> & Pick<UsageSummaryRow, "first_day" | "last_day" | "user_id" | "email" | "last_seen_at"> & { model: string }): UsageSummaryRow {
  const { model, ...rest } = row;
  return {
    ...zeroUsageTotals(),
    route_profile_id: row.route_profile_id ?? "codex.responses",
    response_model: row.response_model ?? model,
    ...rest
  };
}

/** Board HTML form POST (browser Accept + urlencoded) — exercises wantsHtml + CSP form path. */
async function adminForm(fixture: Fixture, url: string, body: URLSearchParams, headers: Record<string, string> = {}): Promise<Response> {
  seedDashboardAdmin(fixture);
  return handleRequest(new Request(url, {
    method: "POST",
    headers: {
      Cookie: `__Host-mini-console=${await consoleCookie(fixture, "operator@example.com")}`,
      "Content-Type": "application/x-www-form-urlencoded",
      "Accept": "text/html,application/xhtml+xml",
      "Origin": new URL(url).origin,
      ...headers
    },
    body: body.toString()
  }), fixture.env, fixture.ctx, fixture.deps);
}

function zeroUsageTotals(): UsageSummaryTotals {
  return {
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
    api_equivalent_usd_ticks: 0,
    api_equivalent_measurements: 0
  };
}
