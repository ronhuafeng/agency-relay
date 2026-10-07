import { describe, expect, it, onTestFinished } from "vitest";
import { JSDOM } from "jsdom";
import { handleRequest } from "../../src/router";
import { admin, consoleCookie, createUser, makeFixture } from "../router/fixture";
import { createTestD1 } from "../support/sqlite-d1";

describe("role-aware console", () => {
  it("keeps local configuration available when key, quota, binding and task metadata cannot be read", async () => {
    const db = createTestD1(); onTestFinished(() => db.close());
    const fixture = makeFixture({env:{DB:db.binding}});
    await createUser(fixture, "configuration-only@example.com");
    const cookie = await consoleCookie(fixture, "configuration-only@example.com");
    db.sqlite.exec(`DROP TABLE request_audit;
      DROP TABLE api_key_surface_credentials;
      DROP TABLE organization_surface_credential_defaults;
      DROP TABLE api_keys;
      DROP TABLE user_surface_credit_usage;
      DROP TABLE user_surface_credit_modes;
      DROP TABLE user_surface_credit_policies;
      DROP TABLE organization_surface_credit_defaults;
      DROP TABLE codex_auths;
      DROP TABLE subscription_accounts;`);
    const response = await handleRequest(new Request("https://admin.example.test/admin?area=me&view=setup&key=absent-key", {
      headers:{Cookie:`__Host-mini-console=${cookie}`}
    }), fixture.env, fixture.ctx, fixture.deps);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const doc = new JSDOM(await response.text()).window.document;
    const setup = doc.querySelector('[data-member-view="setup"]')!;
    expect(setup.querySelector('form[data-local-config-sync] input[name="existing_key"]')).not.toBeNull();
    expect(setup.querySelectorAll('[popover]')).toHaveLength(1);
    expect(setup.querySelector('[popover]')?.getAttribute('aria-label')).toBe('配置说明');
    expect([...setup.querySelectorAll('[popover] a')].map(link=>link.getAttribute('href'))).toEqual(['/admin?area=me&view=keys','/admin?area=me&view=quota']);
    expect(setup.querySelector('.member-setup-evidence,[data-setup-key],[role="alert"]')).toBeNull();
    expect(doc.querySelector('main')?.getAttribute('data-console-read-url')).toBe('/admin?area=me&view=setup');
  });

  it("keeps task observations attached to the exact key in key management", async () => {
    const db = createTestD1(); onTestFinished(() => db.close());
    const fixture = makeFixture({env:{DB:db.binding}});
    const owner = await createUser(fixture, "exact-task@example.com");
    const cookie = await consoleCookie(fixture, "exact-task@example.com");
    const at = fixture.deps.now().toISOString();
    const insertKey = db.sqlite.prepare(`INSERT INTO api_keys
      (id,user_id,key_prefix,key_hash,status,scopes,name,family_id,created_at)
      VALUES (?,?,?,?,'active','["surface:codex:production"]',?, ?,?)`);
    for (const id of ['selected-key','other-key']) insertKey.run(id,owner.user.id,`display-${id}`,`invalid-${id}`,id,`family:${id}`,at);
    const insertTask = db.sqlite.prepare(`INSERT INTO request_audit
      (id,request_id,route_profile_id,user_id,key_id,status,upstream_status,created_at)
      VALUES (?,?,'codex.responses',?,?,?,?,?)`);
    insertTask.run('selected-task','selected-correlation',owner.user.id,'selected-key','error',500,at);
    insertTask.run('other-task','other-correlation',owner.user.id,'other-key','ok',200,new Date(Date.parse(at)-3600000).toISOString());
    const response = await handleRequest(new Request('https://admin.example.test/admin?area=me&view=keys&key=selected-key', {
      headers:{Cookie:`__Host-mini-console=${cookie}`}
    }), fixture.env, fixture.ctx, fixture.deps);
    expect(response.status).toBe(200);
    const doc = new JSDOM(await response.text()).window.document;
    const evidence = doc.querySelector('[data-key-detail="selected-key"] .key-task-evidence')!;
    expect(evidence).not.toBeNull();
    expect(evidence.querySelector('[data-key-task="codex"]')?.textContent).toContain('最近失败');
    expect(evidence.querySelector('[data-key-task="codex"]')?.textContent).toContain('未记录成功任务');
    expect(evidence.querySelector('[data-key-task="codex"]')?.textContent).not.toContain('最近成功');
    const home = await handleRequest(new Request('https://admin.example.test/admin?area=me&view=home', {
      headers:{Cookie:`__Host-mini-console=${cookie}`}
    }), fixture.env, fixture.ctx, fixture.deps);
    expect(home.status).toBe(200);
    const homeDoc = new JSDOM(await home.text()).window.document;
    expect(homeDoc.querySelector('[data-surface="codex"] td:last-child a')?.getAttribute('href')).toBe('/admin?area=me&view=keys&key=selected-key');
    const result=homeDoc.querySelector('[data-surface="codex"] td:last-child')!;
    expect(result.querySelector('time')?.getAttribute('data-tone')).toBe('bad');
    expect(result.querySelector('time')?.getAttribute('datetime')).toBe(at);
    expect(result.querySelector('time .sr-only')?.textContent).toBe('最近任务失败：');
    expect(result.querySelector('strong')).toBeNull();
    expect(homeDoc.querySelector('[data-surface="grok"] td:last-child')?.textContent).toBe('');
    db.sqlite.exec('DROP TABLE request_audit');
    const unread=await handleRequest(new Request('https://admin.example.test/admin?area=me&view=home',{
      headers:{Cookie:`__Host-mini-console=${cookie}`}
    }),fixture.env,fixture.ctx,fixture.deps);
    expect(unread.status).toBe(200);
    const unreadDoc=new JSDOM(await unread.text()).window.document;
    expect(unreadDoc.querySelector('[data-surface="codex"] td:last-child [role="alert"]')?.textContent).toBe('结果未读到');
  });

  it("lets an exhausted member create a key without refilling their allowance", async () => {
    const fixture = makeFixture();
    const owner = await createUser(fixture, "exhausted-member@example.com");
    fixture.db.ensureCredentialAccountsForScopes(["surface:codex:production"]);
    await fixture.tokenAuthority.saveToken({auth_id: "shared_default", access_token: "synthetic-access", expires_at: "2026-07-01T00:00:00.000Z", status: "active"});
    expect((await admin(fixture, "https://api.trustedtunnel.app/admin/credential-defaults/codex", {method: "PUT", body: {credential_account_id: "shared_default"}})).status).toBe(200);
    expect((await admin(fixture, `https://api.trustedtunnel.app/admin/users/${owner.user.id}/credits/codex`, {method: "PUT", body: {monthly_allowance: 1}})).status).toBe(200);
    fixture.db.seedSurfaceCreditUsage(owner.user.id, "surface:codex:production", {consumed_credits: 1, admitted_attempts: 1, last_seen_at: "2026-06-24T00:00:00.000Z"});
    const cookie = await consoleCookie(fixture, "exhausted-member@example.com");
    const open = (path: string) => handleRequest(new Request(`https://admin.example.test${path}`, {headers: {Cookie: `__Host-mini-console=${cookie}`}}), fixture.env, fixture.ctx, fixture.deps);
    const home = new JSDOM(await (await open("/admin")).text()).window.document;
    expect(home.querySelector('[data-surface="codex"]')?.getAttribute("data-service-reason")).toBe("exhausted");
    const keys = new JSDOM(await (await open("/admin?view=keys")).text()).window.document;
    expect(keys.querySelector('input[name="surfaces"][value="codex"]')?.hasAttribute("disabled")).toBe(false);
    const created = await handleRequest(new Request("https://admin.example.test/me/ui/keys", {
      method: "POST",
      headers: {Cookie: `__Host-mini-console=${cookie}`, Origin: "https://admin.example.test", "Content-Type": "application/x-www-form-urlencoded"},
      body: new URLSearchParams({name: "Next month", surfaces: "codex", submission_id: keys.querySelector<HTMLInputElement>('input[name="submission_id"]')!.value})
    }), fixture.env, fixture.ctx, fixture.deps);
    expect(created.status).toBe(200);
    const quota = new JSDOM(await (await open("/admin?view=quota")).text()).window.document;
    expect(quota.querySelector('[data-surface="codex"]')?.getAttribute("data-credit-mode")).toBe("limited");
    expect([...quota.querySelectorAll('[data-surface="codex"] td')].slice(1).map(n=>n.textContent)).toEqual(["1","已用 / 上限：1 / 1","0"]);
    expect(quota.querySelector('[data-surface="codex"] [role="progressbar"]')?.getAttribute('aria-valuenow')).toBe('100');
  });

  it("shows a member only their own pages and usage", async () => {
    const fixture = makeFixture();
    const owner = await createUser(fixture, "member@example.com");
    const other = await createUser(fixture, "hidden-person@example.com");
    fixture.db.ensureCredentialAccountsForScopes(["surface:codex:production"]);
    expect((await admin(fixture, `https://api.trustedtunnel.app/admin/users/${other.user.id}/keys`, {
      method: "POST",
      body: {
        name: "Hidden key",
        scopes: ["surface:codex:production"],
        credential_bindings: [{ surface_grant: "surface:codex:production", credential_account_id: "shared_default" }]
      }
    })).status).toBe(201);
    const open = async (path: string) => handleRequest(new Request(`https://admin.example.test${path}`, {
      headers: { Cookie: `__Host-mini-console=${await consoleCookie(fixture, "member@example.com")}` }
    }), fixture.env, fixture.ctx, fixture.deps);

    const home = await open("/admin");
    expect(home.status).toBe(200);
    const homeHtml = await home.text();
    expect(homeHtml).toContain("我的密钥");
    expect(homeHtml).toContain("我的用量");
    expect(homeHtml).toContain("我的额度");
    expect(homeHtml).toContain('data-sign-out="true"');
    expect(homeHtml).toContain('id="console-dialog-root"');
    expect(homeHtml).toContain('src="/admin/console.js"');
    expect(homeHtml).not.toContain("hidden-person@example.com");
    expect(homeHtml).not.toContain("shared_default");
    expect(homeHtml).not.toContain("Accounts");

    const blocked = await open("/admin?view=credentials");
    expect(blocked.status).toBe(404);
    expect(await blocked.text()).not.toContain("shared_default");

    const quota = await open("/admin?view=quota");
    const quotaHtml = await quota.text();
    expect(quotaHtml).toContain('data-member-quota="true"');
    expect(quotaHtml).toContain("codex");
    expect(quotaHtml).toContain("xai");
    expect(quotaHtml).not.toContain("hidden-person@example.com");

    const keys = await open("/admin?view=keys");
    const keysHtml = await keys.text();
    expect(keysHtml).toContain('data-member-key-create="true"');
    expect(keysHtml).not.toContain("credential_account");
    expect(keysHtml).not.toContain("撤销我的全部密钥");
    await fixture.tokenAuthority.saveToken({
      auth_id: "shared_default",
      access_token: "shared_access",
      expires_at: "2026-07-01T00:00:00.000Z",
      status: "active"
    });
    expect((await admin(fixture, "https://api.trustedtunnel.app/admin/credential-defaults/codex", {
      method: "PUT",
      body: { credential_account_id: "shared_default" }
    })).status).toBe(200);
    const created = await handleRequest(new Request("https://admin.example.test/me/ui/keys", {
      method: "POST",
      headers: {
        Cookie: `__Host-mini-console=${await consoleCookie(fixture, "member@example.com")}`,
        Origin: "https://admin.example.test",
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: new URLSearchParams({ name: "Desk", surfaces: "codex", submission_id: `submit_${crypto.randomUUID()}` })
    }), fixture.env, fixture.ctx, fixture.deps);
    expect(created.status).toBe(200);
    const createdHtml = await created.text();
    const token = createdHtml.match(/data-created-token="true">([^<]+)/)?.[1] ?? "";
    expect(token.startsWith("cfwd_")).toBe(true);
    const reread = await open("/admin?view=keys");
    const rereadHtml = await reread.text();
    expect(rereadHtml).not.toContain(token);
    expect(rereadHtml).toContain("撤销我的全部密钥");

    fixture.db.seedUsage({
      user_id: owner.user.id,
      day: "2026-06-24",
      route_profile_id: "codex.responses",
      response_model: "gpt-5",
      requests: 2,
      ok_requests: 2,
      error_requests: 0,
      input_tokens: 4,
      cached_input_tokens: 0,
      output_tokens: 6,
      reasoning_tokens: 0,
      total_tokens: 10,
      token_measurements: 1,
      provider_cost_usd_ticks: 0,
      cost_measurements: 0
    });
    fixture.db.seedUsage({
      user_id: other.user.id,
      day: "2026-06-24",
      route_profile_id: "codex.responses",
      response_model: "gpt-5",
      requests: 9,
      ok_requests: 9,
      error_requests: 0,
      input_tokens: 9,
      cached_input_tokens: 0,
      output_tokens: 9,
      reasoning_tokens: 0,
      total_tokens: 18,
      token_measurements: 1,
      provider_cost_usd_ticks: 0,
      cost_measurements: 0
    });
    const usage = await open(`/me/usage?user_id=${other.user.id}&scope=all`);
    expect(usage.status).toBe(200);
    const usageBody: unknown = await usage.json();
    expect(usageBody).toMatchObject({scope: "self", usage: {totals: {requests: 2}}});
    expect(JSON.stringify(usageBody)).not.toContain(other.user.id);
    const report = await open(`/admin?view=usage&user_id=${other.user.id}&range=7d`);
    expect(report.status).toBe(200);
    const reportHtml = await report.text();
    const reportDoc = new JSDOM(reportHtml).window.document;
    expect(reportDoc.querySelectorAll('.usage-record')).toHaveLength(1);
    expect(reportDoc.querySelector('.usage-metrics')?.textContent).toContain('Requests2');
    expect(reportDoc.querySelector('.usage-metrics')?.textContent).toContain('Token10');
    expect(reportDoc.querySelector('.usage-record [popover] p')?.textContent).toContain('1 次请求未记录');
    expect(reportDoc.querySelector('a[download]')?.getAttribute('href')).toBe('/me/usage?from=2026-06-18&to=2026-06-24');
    expect(reportDoc.querySelector('input[type="search"]')?.getAttribute('placeholder')).toBe('搜索模型');
    expect(reportHtml).not.toContain(other.user.id);
    expect(reportHtml).not.toContain('hidden-person@example.com');
  });

  it("shows a bounded personal usage list and keeps the export limit truthful", async () => {
    const fixture = makeFixture();
    const owner = await createUser(fixture, "bounded-usage@example.com");
    for (let i = 0; i < 101; i++) fixture.db.seedUsage({user_id: owner.user.id, day: "2026-06-24", route_profile_id: "codex.responses", response_model: `model-${i}`, requests: 1, ok_requests: 1, error_requests: 0, input_tokens: 1, output_tokens: 0, total_tokens: 1, token_measurements: 1, provider_cost_usd_ticks: 0, cost_measurements: 0});
    const cookie = await consoleCookie(fixture, "bounded-usage@example.com");
    const open = (path: string) => handleRequest(new Request(`https://admin.example.test${path}`, {headers: {Cookie: `__Host-mini-console=${cookie}`}}), fixture.env, fixture.ctx, fixture.deps);
    const html = await (await open('/admin?view=usage')).text();
    const document = new JSDOM(html).window.document;
    expect(document.querySelectorAll('.usage-record')).toHaveLength(100);
    expect(document.querySelector('.usage-report-tools')?.textContent).toContain('未显示全部记录');
    expect(document.querySelector('.usage-report>.caption')?.textContent).toContain('分别显示最多 100 条');
    const exported: unknown = await (await open('/me/usage')).json();
    if (typeof exported !== 'object' || exported === null || !('usage' in exported) || typeof exported.usage !== 'object' || exported.usage === null || !('rows' in exported.usage)) throw new Error('Usage export missing');
    expect(exported.usage.rows).toHaveLength(100);
  });

  it("lets an administrator open quotas and the control-plane audit without treating activity as audit", async () => {
    const fixture = makeFixture();
    const quotas = await admin(fixture, "https://admin.example.test/admin?view=quotas", { method: "GET" });
    expect(quotas.status).toBe(200);
    const quotasHtml = await quotas.text();
    expect(quotasHtml).toContain('data-view-role="quotas"');
    const quotaDoc = new JSDOM(quotasHtml).window.document;
    const amount = quotaDoc.querySelector('[data-quota-default="codex"] input[name="codex"]');
    expect(amount?.getAttribute("min")).toBe("0");
    expect(amount?.hasAttribute("required")).toBe(true);
    expect(quotaDoc.querySelector('.organization-policy-form')?.getAttribute("data-confirmation")).toContain("0 credits 只允许已授权的零消耗操作");
    expect(quotasHtml).not.toContain(">Unlimited<");
    const audit = await admin(fixture, "https://admin.example.test/admin?view=control-audit", { method: "GET" });
    expect(audit.status).toBe(200);
    const auditHtml = await audit.text();
    expect(auditHtml).toContain('data-view-role="control-audit"');
    const auditDoc = new JSDOM(auditHtml).window.document;
    const nav = auditDoc.querySelector('[role="navigation"][aria-label="控制台页面"]');
    expect(nav?.querySelector('a[href*="view=control-audit"]')?.textContent).toBe("管理记录");
    expect(nav?.querySelector('a[href*="view=audit"]')?.textContent).toBe("请求记录");
    expect(auditDoc.querySelector('table[aria-label="管理操作记录"] .empty')?.textContent).toBe("还没有管理操作记录。");
    const accounts = await admin(fixture, "https://admin.example.test/admin?view=credentials", { method: "GET" });
    const accountsHtml = await accounts.text();
    expect(accountsHtml).toContain("data-default-boundary=\"true\"");
    const defaults = new JSDOM(accountsHtml).window.document.querySelector("[data-default-boundary]");
    expect(defaults?.querySelector("h2")?.textContent).toBe("新密钥默认连接");
    expect(defaults?.querySelector("th:nth-child(2)")?.textContent).toBe("连接");
    expect(defaults?.querySelectorAll('form[action^="/admin/ui/credential-defaults/"]')).toHaveLength(3);
  });
});
