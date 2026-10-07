import { JSDOM } from "jsdom";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { adminDashboardResponse } from "../../src/admin/dashboard";
import { type DashboardMutationFlash } from "../../src/admin/dashboard-data";
import { unavailableCodexAccountSnapshot } from "../../src/codex/account";
import { createTestD1 } from "../support/sqlite-d1";

function fixture(failure?: string) {
  const db = createTestD1({ onPrepare: sql => { if (failure && sql.includes(failure)) throw new Error("Synthetic required read failure"); } });
  onTestFinished(() => db.close());
  const at = "2026-09-12T09:00:00.000Z";
  for (const id of ["collision", "chatgpt-only", "name / & 中文"]) {
    db.sqlite.prepare("INSERT INTO codex_auths(id,kind,label,environment,status,expires_at,created_at,updated_at) VALUES(?,'shared',?,'production','active',?,?,?)")
      .run(id, id === "name / & 中文" ? "Long <script> label & 中文" : "Same label", at, at, at);
  }
  for (const id of ["collision", "grok-only"]) {
    db.sqlite.prepare("INSERT INTO subscription_accounts(id,capability_source,environment,label,status,created_at,updated_at) VALUES(?,'grok','production','Same label','reauth_required',?,?)").run(id, at, at);
  }
  const load = vi.fn(async () => unavailableCodexAccountSnapshot());
  const render = async (query = "", mutationFlash?: DashboardMutationFlash, path = "/admin") => {
    const response = await adminDashboardResponse({
      env: { DB: db.binding, ADMIN_DASHBOARD_HOST: "admin.example.test" } as Env,
      url: new URL(`https://admin.example.test${path}?view=credentials&range=30d${query}`),
      identity: { kind: "console", email: "operator@example.test", subject: "fixture" },
      now: new Date("2026-09-12T12:00:00.000Z"), requestId: "account-detail", loadCodexAccount: load, mutationFlash
    });
    return { response, html: await response.text() };
  };
  return { db, render, load, recover: () => { failure = undefined; } };
}

const detail = (html: string) => new JSDOM(html).window.document.querySelector('.account-detail')?.outerHTML ?? "";
const linkedSection = (html: string) => html.match(/<section id="account-keys"[\s\S]*?<\/section>/)?.[0] ?? "";

function seedLinkedKey(f: ReturnType<typeof fixture>, id: string, input: { person?: string; status?: string; expires?: string; personStatus?: string; grants?: string[]; rawScopes?: string; provider?: "codex" | "grok"; account?: string; bound?: string[] } = {}) {
  const person = input.person ?? `Person ${id}`;
  const grants = input.grants ?? ["surface:grok:production", "surface:xai:production"];
  const at = "2026-09-12T09:00:00.000Z";
  f.db.sqlite.prepare("INSERT OR IGNORE INTO users(id,status,created_at,updated_at) VALUES(?,?,?,?)").run(person, input.personStatus ?? "active", at, at);
  f.db.sqlite.prepare("INSERT INTO api_keys(id,user_id,key_prefix,key_hash,status,scopes,expires_at,created_at) VALUES(?,?,?,?,?,?,?,?)")
    .run(id, person, `prefix_${id}`, `private_hash_${id}`, input.status ?? "active", input.rawScopes ?? JSON.stringify(grants), input.expires ?? null, at);
  for (const grant of input.bound ?? grants) {
    const codex = (input.provider ?? "grok") === "codex";
    f.db.sqlite.prepare("INSERT INTO api_key_surface_credentials(api_key_id,surface_grant,codex_auth_id,subscription_account_id,created_at,updated_at) VALUES(?,?,?,?,?,?)")
      .run(id, grant, codex ? input.account ?? "collision" : null, codex ? null : input.account ?? "collision", at, at);
  }
}

describe("account linked access", () => {
  it("isolates providers and accounts, groups a key's clients, and links its exact owner", async () => {
    const f = fixture();
    seedLinkedKey(f, "grok-both", { person: "People / <team> & 中文" });
    seedLinkedKey(f, "codex-only", { provider: "codex", grants: ["surface:codex:production"] });
    seedLinkedKey(f, "grok-other", { account: "grok-only" });
    f.db.sqlite.prepare("UPDATE api_key_surface_credentials SET subscription_account_id='grok-only' WHERE api_key_id='grok-both' AND surface_grant='surface:xai:production'").run();
    const { html } = await f.render("&account=grok%3Acollision&q=not-matching");
    const list = linkedSection(html);
    expect(html).toContain('href="#account-keys">1 个关联密钥');
    expect(list.match(/data-linked-key=/g)).toHaveLength(1);
    expect(list).toContain("People / &lt;team&gt; &amp; 中文");
    expect(list).toContain("Grok");
    expect(list).not.toContain("xAI API");
    expect(list).not.toContain("codex-only");
    expect(list).not.toContain("grok-other");
    expect(list).toContain('href="/admin?view=access&amp;range=30d&amp;person=People%20%2F%20%3Cteam%3E%20%26%20%E4%B8%AD%E6%96%87&amp;key=grok-both"');
    expect(list).not.toContain("<form");
    expect(html).not.toContain("private_hash_");
    const other = await f.render("&account=grok%3Agrok-only");
    expect(linkedSection(other.html).match(/data-linked-key=/g)).toHaveLength(2);
    expect(linkedSection(other.html)).toContain("Grok · xAI API");
    const codex = await f.render("&account=codex%3Acollision");
    expect(linkedSection(codex.html)).toContain('data-linked-key="codex-only"');
    expect(linkedSection(codex.html)).not.toContain("grok-both");
    expect(f.load.mock.calls).toEqual([["collision"]]);
  });

  it.each([
    [{}, "有效"], [{ status: "revoked" }, "已撤销"], [{ expires: "2026-09-12T12:00:00.000Z" }, "已过期"],
    [{ personStatus: "disabled" }, "已暂停 — 人员已停用"],
    [{ rawScopes: "surface:grok:production" }, "Grok — 未授予"],
    [{ grants: ["surface:grok:production"], bound: ["surface:grok:production", "surface:xai:production"] }, "xAI API — 未授予"]
  ] as const)("keeps access state explicit: %j", async (input, label) => {
    const f = fixture();
    seedLinkedKey(f, "state-key", input as Parameters<typeof seedLinkedKey>[2]);
    const { html } = await f.render("&account=grok%3Acollision");
    expect(linkedSection(html)).toContain(label);
    expect(linkedSection(html)).not.toContain("Verified");
  });

  it("counts every linked key and pages without duplicating multi-client bindings", async () => {
    const f = fixture();
    for (let i = 0; i < 65; i++) seedLinkedKey(f, `key-${String(i).padStart(3, "0")}`);
    const first = await f.render("&account=grok%3Acollision&q=ChatGPT");
    expect(first.html).toContain('href="#account-keys">65 个关联密钥');
    expect(linkedSection(first.html).match(/data-linked-key=/g)).toHaveLength(40);
    expect(linkedSection(first.html)).toContain('q=ChatGPT&amp;page=2#account-keys');
    const second = await f.render("&account=grok%3Acollision&q=ChatGPT&page=2");
    expect(linkedSection(second.html).match(/data-linked-key=/g)).toHaveLength(25);
    expect(linkedSection(second.html)).toContain('data-linked-key="key-064"');
    expect(second.html).toContain('name="return_page" value="2"');
    expect(new JSDOM(second.html).window.document.querySelector("a[data-task-close]")?.getAttribute("href")).toBe("/admin?view=credentials&range=30d&q=ChatGPT#accounts-list");
    const switchLink = second.html.match(/class="account-link"[^>]*href="([^"]*account=codex%3Acollision[^"]*)"/)?.[1];
    expect(switchLink).toBeDefined();
    expect(switchLink).not.toContain("page=");
    const beyond = await f.render("&account=grok%3Acollision&page=3");
    expect(beyond.html).toContain("这一页没有密钥。");
    expect(beyond.html).not.toContain("没有密钥使用这个账号。");
    expect(beyond.html).toContain("65 个关联密钥");
    expect(f.load).not.toHaveBeenCalled();
  });

  it("keeps missing linked-access reads unavailable and skips them outside exact details", async () => {
    const f = fixture("FROM api_keys AS k");
    for (const query of ["", "&task=add-account", "&account=grok%3Amissing"]) expect((await f.render(query)).response.status).toBe(200);
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    onTestFinished(() => log.mockRestore());
    const { response, html } = await f.render("&account=grok%3Acollision", { kind: "grok_refreshed", account_id: "collision" });
    expect(response.status).toBe(503);
    expect(html).toContain('data-mutation-flash="grok_refreshed"');
    expect(html).toContain("控制台暂时打不开");
    expect(html).not.toContain("0 个关联密钥");
    expect(html).not.toContain("没有密钥使用这个账号。");
    expect(f.load).not.toHaveBeenCalled();
  });

  it("keeps disconnect unavailable until the retirement impact is known and recovers on a fresh read", async () => {
    const f = fixture("FROM organization_surface_credential_defaults AS d");
    f.db.sqlite.prepare("UPDATE codex_auths SET expires_at=NULL WHERE id='collision'").run();
    const failed = await f.render("&account=codex%3Acollision");
    expect(failed.response.status).toBe(200);
    const failedDocument = new JSDOM(failed.html).window.document;
    expect(failedDocument.querySelector('[data-read-state="unavailable"]')?.textContent).toContain("暂时无法读取停用影响");
    const disconnect = failedDocument.querySelector<HTMLButtonElement>('[data-action="logout-codex"] button');
    expect(disconnect?.disabled).toBe(true);
    expect(disconnect?.title).toBe("请先重新读取停用影响");
    expect(failedDocument.querySelector<HTMLButtonElement>('[data-action="refresh-codex"] button')?.disabled).toBe(false);
    expect(failedDocument.querySelector('[data-action="logout-codex"] .confirmation-fallback')).toBeNull();

    f.recover();
    const recovered = await f.render("&account=codex%3Acollision");
    const recoveredDocument = new JSDOM(recovered.html).window.document;
    expect(recovered.response.status).toBe(200);
    expect(recoveredDocument.querySelector('[data-retirement="true"]')?.textContent).toContain("没有未撤销密钥绑定");
    expect(recoveredDocument.querySelector<HTMLButtonElement>('[data-action="logout-codex"] button')?.disabled).toBe(false);
    expect(recoveredDocument.querySelector('[data-action="logout-codex"] .confirmation-fallback')).not.toBeNull();
  });

  it.each([false,true])("keeps unrevoked bindings blocking disconnect without disabling connection recovery (expired and disabled=%s)", async expired => {
    const f = fixture();
    f.db.sqlite.prepare("UPDATE codex_auths SET expires_at=NULL WHERE id='collision'").run();
    seedLinkedKey(f, "live-codex", { provider: "codex", grants: ["surface:codex:production"], ...(expired ? {expires:"2026-01-01T00:00:00.000Z",personStatus:"disabled"} : {}) });
    const { html } = await f.render("&account=codex%3Acollision");
    const document = new JSDOM(html).window.document;
    expect(document.querySelector('[data-retirement-block="true"]')?.textContent).toContain("1 个未撤销密钥仍绑定此连接");
    const disconnect = document.querySelector<HTMLButtonElement>('[data-action="logout-codex"] button');
    expect(disconnect?.disabled).toBe(true);
    expect(disconnect?.title).toBe("请先处理未撤销密钥绑定");
    expect(document.querySelector<HTMLButtonElement>('[data-action="refresh-codex"] button')?.disabled).toBe(false);
  });
});

describe("exact account tasks", () => {
  it.each([["  CHatGPT  ", 3], ["Grok", 2], ["需要重新连接", 2], ["访问已过期", 3], ["<script>", 1], ["中文", 1], ["not present", 0]] as const)("searches displayed metadata with %s", async (query, count) => {
    const f = fixture();
    const { response, html } = await f.render(`&q=${encodeURIComponent(query)}`);
    expect(response.status).toBe(200);
    expect([...html.matchAll(/<li data-account-key=/g)]).toHaveLength(count);
    expect(html).toContain('class="inventory-search"');
    expect(html).toContain('method="get"');
    expect(html).toContain('action="/admin"');
    expect(html).toContain('data-dashboard-search');
    expect(new JSDOM(html).window.document.querySelector('#accounts-list form[method="post"]')).toBeNull();
    expect(f.load).not.toHaveBeenCalled();
    if (!count) {
      expect(html).toContain("没有匹配的账号。");
      expect(html).not.toContain("还没有账号。");
    }
  });

  it("keeps exact detail, parent, creation and native search context independent of matches", async () => {
    const f = fixture();
    const { html } = await f.render("&q=Grok&account=codex%3Acollision");
    expect(html.match(/<li data-account-key=/g)).toHaveLength(2);
    expect(detail(html)).toContain('data-codex-admin="true"');
    expect(f.load.mock.calls).toEqual([["collision"]]);
    expect(new JSDOM(html).window.document.querySelector("a[data-task-close]")?.getAttribute("href")).toBe("/admin?view=credentials&range=30d&q=Grok#accounts-list");
    expect(html).toContain('href="/admin?view=credentials&amp;range=30d&amp;q=Grok&amp;task=add-account#account-detail"');
    expect(html).toContain('name="q" value="Grok"');
    expect(html).toContain('name="return_q" value="Grok"');
    expect(html).toContain('name="account" value="codex:collision"');
    const add = await f.render("&q=Grok&task=add-account");
    expect(detail(add.html).match(/name="return_q" value="Grok"/g)).toHaveLength(2);
    expect(detail(add.html)).toContain('action="/admin/ui/codex-auths"');
    const empty = await f.render("&q=not-present&account=codex%3Acollision");
    expect(empty.html).toContain("没有匹配的账号。");
    expect(detail(empty.html)).toContain('data-codex-admin="true"');
  });

  it("escapes search context without turning it into HTML or navigation fields", async () => {
    const f = fixture();
    const { html } = await f.render(`&q=${encodeURIComponent('"<&task=add-account')}&task=add-account`);
    expect(html).toContain('name="return_q" value="&quot;&lt;&amp;task=add-account"');
    expect(html).toContain('q=%22%3C%26task%3Dadd-account');
    expect(html).not.toContain('value=""<&');
  });

  it("keeps root-path selection links in the current document's navigation scope", async () => {
    const f = fixture();
    const { html } = await f.render("", undefined, "/");
    expect(html).toContain('href="/?view=credentials&amp;range=30d&amp;account=codex%3Acollision#account-detail"');
    expect(new JSDOM(html).window.document.querySelector('#accounts-list a[href^="/admin?view=credentials"]')).toBeNull();
  });
  it("shows a complete inventory and independent default tasks without reading provider snapshots", async () => {
    const f = fixture();
    const { response, html } = await f.render();
    expect(response.status).toBe(200);
    expect(html.match(/<li data-account-key=/g)).toHaveLength(5);
    expect(html).toContain("account=codex%3Acollision");
    expect(html).toContain("account=grok%3Acollision");
    expect(html).toContain("task=add-account");
    expect(new JSDOM(html).window.document.querySelector('#accounts-list form[method="post"]')).toBeNull();
    expect(new JSDOM(html).window.document.querySelectorAll('.account-defaults form')).toHaveLength(3);
    expect(html).not.toContain("data-chatgpt-upstream");
    expect(f.load).not.toHaveBeenCalled();
  });

  it.each(["codex", "grok"])("keeps same-ID, same-label %s controls isolated", async provider => {
    const f = fixture();
    const { response, html } = await f.render(`&account=${provider}%3Acollision`);
    expect(response.status).toBe(200);
    const pane = detail(html);
    expect(pane).toContain(`data-${provider}-admin="true"`);
    expect(pane).not.toContain(`data-${provider === "codex" ? "grok" : "codex"}-admin="true"`);
    const actions = [...pane.matchAll(/<form[^>]*\saction="([^"]+)"/g)].map(match => match[1]);
    const prefix = `/admin/ui/${provider === "codex" ? "codex-auths" : "subscriptions"}/collision/`;
    expect(actions.length).toBeGreaterThan(0);
    expect(actions.every(action => action.startsWith(prefix))).toBe(true);
    expect(html).toContain(`data-dashboard-url="/admin?view=credentials&amp;range=30d&amp;account=${provider}%3Acollision"`);
    expect(new JSDOM(html).window.document.querySelector("a[data-task-close]")?.getAttribute("href")).toBe("/admin?view=credentials&range=30d#accounts-list");
    if (provider === "codex") {
      expect(f.load.mock.calls).toEqual([["collision"]]);
      const dossier = new JSDOM(pane).window.document.querySelector('[data-chatgpt-dossier]')!;
      expect(dossier.getAttribute('data-upstream-read')).toBe('unavailable');
      expect(dossier.querySelector('[data-slot="badge"]')?.textContent).toBe('未读到');
    } else expect(f.load).not.toHaveBeenCalled();
  });

  it.each(["codex:missing", "grok:chatgpt-only", "codex:grok-only"])("never substitutes controls for %s", async key => {
    const f = fixture();
    const { response, html } = await f.render(`&account=${encodeURIComponent(key)}`);
    expect(response.status).toBe(200);
    expect(html).toContain("没有这个账号");
    expect(detail(html)).not.toContain('method="post"');
    expect(f.load).not.toHaveBeenCalled();
  });

  it("preserves and escapes an exact identifier independently of its display label", async () => {
    const f = fixture();
    const { html } = await f.render(`&account=${encodeURIComponent("codex:name / & 中文")}`);
    expect(f.load.mock.calls).toEqual([["name / & 中文"]]);
    expect(detail(html)).toContain("Long &lt;script&gt; label &amp; 中文");
    expect(detail(html)).toContain('/admin/ui/codex-auths/name%20%2F%20%26%20%E4%B8%AD%E6%96%87/refresh');
  });

  it("keeps creation separate and native without provider reads", async () => {
    const f = fixture();
    const { html } = await f.render("&task=add-account");
    expect(detail(html)).toContain('<h2>添加账号</h2>');
    expect(detail(html)).toContain('action="/admin/ui/codex-auths"');
    expect(detail(html)).toContain('action="/admin/ui/subscriptions"');
    expect(detail(html)).toContain('name="return_range" value="30d"');
    expect(detail(html)).not.toContain('data-mgmt-state=');
    expect(f.load).not.toHaveBeenCalled();
  });

  it.each(["codex", "grok"])("keeps %s sign-in material and cancel bound to its selected account", async provider => {
    const f = fixture();
    const flash = { kind: `${provider}_oauth_started`, [provider === "codex" ? "auth_id" : "account_id"]: "collision", session_id: "synthetic-pending", authorize_url: "https://example.test/login", redirect_uri: "http://localhost/callback" } as DashboardMutationFlash;
    const { html } = await f.render("", flash);
    const pane = detail(html);
    expect(pane).toContain('data-mgmt-state="authorizing"');
    expect(pane).toContain('name="session_id" value="synthetic-pending"');
    expect(pane).toMatch(new RegExp(`<a[^>]*href="/admin\\?view=credentials&amp;range=30d&amp;account=${provider}%3Acollision"[^>]*data-action="oauth-cancel"`));
    expect(pane).not.toContain('data-dashboard-draft=');
    expect(pane).toContain('name="return_range" value="30d"');
    const returned = await f.render(`&account=${provider}%3Acollision`);
    expect(returned.html).not.toContain('data-oauth-pending="true"');
    expect(returned.html).not.toContain('synthetic-pending');
  });

  it.each(["FROM codex_auths", "FROM subscription_accounts"])("keeps required metadata failures unavailable: %s", async failure => {
    const f = fixture(failure);
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    onTestFinished(() => spy.mockRestore());
    const { response, html } = await f.render("&account=codex%3Acollision");
    expect(response.status).toBe(503);
    expect(html).toContain("控制台暂时打不开");
    expect(html).not.toContain("没有这个账号");
    expect(html).not.toContain('method="post"');
  });

  it.each(["&account=", "&account=unknown%3Acollision", "&account=codex%3A", "&account=codex%3A%20", "&account=codex%3Acollision&account=grok%3Acollision", "&account=codex%3Acollision&task=add-account", "&account=codex%3Ax%00", "&task=give-access", "&q=one&q=two", "&q=%00", `&q=${"a".repeat(257)}`, "&page=1", "&account=grok%3Acollision&page=0", "&account=grok%3Acollision&page=2&page=3", "&account=grok%3Acollision&page=9007199254740991", "&key_q=test", "&key_page=1"])("rejects an ambiguous or invalid account query: %s", async query => {
    const f = fixture();
    const { response, html } = await f.render(query);
    expect(response.status).toBe(400);
    expect(html).toContain("页面参数不正确");
    expect(f.load).not.toHaveBeenCalled();
  });
});
