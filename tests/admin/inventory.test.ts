import { JSDOM } from "jsdom";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { adminDashboardResponse } from "../../src/admin/dashboard";

import { createTestD1 } from "../support/sqlite-d1";
import { makeFixture } from "../router/fixture";

function inventoryFixture(populated = true) {
  const db = createTestD1({ onBind: (_sql, values) => {
    if (values.length > 100) throw new Error("D1 query exceeds the bound-parameter limit");
  } });
  onTestFinished(() => db.close());
  const instant = "2026-09-12T12:00:00.000Z";
  const person = (id: string, email: string | null = null, created = instant) => db.sqlite.prepare(
    "INSERT INTO users(id,email,canonical_email,login_capable,account_kind,status,created_at,updated_at) VALUES(?,?,?,?,?,'active',?,?)"
  ).run(id, email, email, email ? 1 : 0, email ? "human" : "legacy_unresolved", created, created);
  const key = (id: string, owner: string, client: string, created = instant) => db.sqlite.prepare(
    "INSERT INTO api_keys(id,user_id,key_prefix,key_hash,status,scopes,created_at) VALUES(?,?,?,?,'active',?,?)"
  ).run(id, owner, `prefix_${id}`, `private_hash_${id}`, JSON.stringify([`surface:${client}:production`]), created);
  if (populated) {
    for (let i = 0; i < 101; i++) person(`person-${String(i).padStart(3, "0")}`, `person${i}@example.test`, i ? instant : "2020-01-01T00:00:00.000Z");
    for (let i = 0; i < 201; i++) key(`key-${String(i).padStart(3, "0")}`, i ? "person-100" : "person-000", i > 1 ? "grok" : "codex", i > 1 ? instant : "2020-01-01T00:00:00.000Z");
  }
  const render = async (query: string) => {
    const response = await adminDashboardResponse({
      env: makeFixture({env: {DB: db.binding, ADMIN_DASHBOARD_HOST: "admin.example.test"}}).env,
      url: new URL(`https://admin.example.test/admin?${query}`),
      identity: { kind: "console", email: "operator@example.test", subject: "inventory" },
      now: new Date(instant), requestId: "inventory-check",
      loadCodexAccount: async () => { throw new Error("No accounts seeded"); }
    });
    return { status: response.status, html: await response.text() };
  };
  return { db, person, key, render };
}

const ids = (html: string, attribute: string) => [...html.matchAll(new RegExp(`${attribute}="([^"]+)"`, "g"))].map(match => match[1]);
const hrefs = (html: string) => [...html.matchAll(/<a\b[^>]*>/g)].flatMap((match) => {
  const tag = match[0];
  if (!tag.includes("data-dashboard-link")) return [];
  const href = tag.match(/\bhref="([^"]+)"/);
  return href?.[1] ? [new URL(href[1].replaceAll("&amp;", "&"), "https://admin.example.test")] : [];
});

describe("complete dashboard inventories", () => {
  it.each([
    ["active", null, "granted", "：密钥有效", null],
    ["active", "2020-01-01T00:00:00.000Z", "expired", "：密钥已过期", " · 已过期"],
    ["disabled", null, "paused", "：账号已停用", " · 已暂停"]
  ] as const)("exposes %s key coverage with expiry %s through readable status text rather than an unsupported span name", async (status, expiry, state, accessible, visible) => {
    const f = inventoryFixture();
    f.db.sqlite.prepare("UPDATE users SET status=? WHERE id='person-100'").run(status);
    f.db.sqlite.prepare("UPDATE api_keys SET expires_at=? WHERE user_id='person-100'").run(expiry);
    const { html } = await f.render("view=access&q=person-100");
    const doc = new JSDOM(html).window.document;
    const badge = doc.querySelector('[data-user-id="person-100"] .person-access');
    expect(badge?.getAttribute("aria-label")).toBeNull();
    expect(badge?.getAttribute("data-access-state")).toBe(state);
    expect(badge?.querySelector(".sr-only")?.textContent).toBe(accessible);
    expect(badge?.querySelector('[aria-hidden="true"]')?.textContent ?? null).toBe(visible);
    expect(doc.querySelectorAll('[data-slot="badge"][aria-label]')).toHaveLength(0);
  });

  it("filters disjoint account categories before search and pagination and retains exact selection", async () => {
    const f = inventoryFixture();
    f.db.sqlite.exec("UPDATE users SET account_kind='legacy_unresolved', login_capable=0, canonical_email=NULL WHERE id='person-000'");
    f.db.sqlite.exec("UPDATE users SET role='admin' WHERE id BETWEEN 'person-001' AND 'person-015'");
    f.person("build-service");
    f.db.sqlite.exec("UPDATE users SET account_kind='service', display_name='Nightly build' WHERE id='build-service'");
    const legacy = await f.render("view=access&kind=legacy_unresolved");
    expect(ids(legacy.html, "data-user-id")).toEqual(["person-000"]);
    expect(hrefs(legacy.html).find(url => url.searchParams.get("person") === "person-000")?.searchParams.get("kind")).toBe("legacy_unresolved");
    const humans = await f.render("view=access&kind=human&page=3&person=person-005&page_size=20");
    expect(ids(humans.html, "data-user-id")).toHaveLength(20);
    expect(ids(humans.html, "data-user-id")).not.toContain("person-000");
    expect(ids(humans.html, "data-user-id").every(id => id > "person-015")).toBe(true);
    const humanDoc = new JSDOM(humans.html).window.document;
    expect(humanDoc.querySelector('[data-person-detail="person-005"]')).not.toBeNull();
    expect(humanDoc.querySelector('.people-kinds [aria-current="page"]')?.textContent).toBe("成员");
    expect(humanDoc.querySelectorAll('.people-table .person-badge')).toHaveLength(0);
    const admins = await f.render("view=access&kind=admin&page_size=10&page=2");
    expect(ids(admins.html, "data-user-id")).toEqual(["person-011", "person-012", "person-013", "person-014", "person-015"]);
    expect(new JSDOM(admins.html).window.document.querySelector('.people-kinds [aria-current="page"]')?.textContent).toBe("管理员");
    const adminLinks = hrefs(admins.html).filter(url => url.searchParams.get("person"));
    expect(adminLinks.every(url => url.searchParams.get("kind") === "admin" && url.searchParams.get("page_size") === "10" && url.searchParams.get("page") === "2")).toBe(true);
    expect(ids((await f.render("view=access&kind=admin&q=person-005")).html, "data-user-id")).toEqual(["person-005"]);
    expect(ids((await f.render("view=access&kind=human&q=person-005")).html, "data-user-id")).toEqual([]);
    expect(ids((await f.render("view=access&kind=service&q=Nightly")).html, "data-user-id")).toEqual(["build-service"]);
    const legacyAll = await f.render("view=access&kind=all");
    const members = await f.render("view=access");
    expect(ids(legacyAll.html, "data-user-id")).toEqual(ids(members.html, "data-user-id"));
    expect(new JSDOM(legacyAll.html).window.document.querySelector('.people-kinds [aria-current="page"]')?.textContent).toBe("成员");
    expect((await f.render("view=access&kind=unknown")).status).toBe(400);
    expect((await f.render("view=overview&kind=human")).status).toBe(400);
  });

  it("searches Setup keys by service name without changing an exact selected key", async () => {
    const f = inventoryFixture(false);
    f.person("build-service");
    f.db.sqlite.exec("UPDATE users SET account_kind='service', display_name='Nightly build' WHERE id='build-service'");
    f.key("build-key", "build-service", "grok");
    f.person("different-person", "different@example.test");
    f.key("different-key", "different-person", "codex");
    const result = await f.render("view=setup&q=Nightly&person=different-person&key=different-key");
    expect(result.status).toBe(200);
    const doc = new JSDOM(result.html).window.document;
    expect(ids(result.html, "data-setup-key-id")).toEqual(["build-key"]);
    expect(doc.querySelector('[data-setup-key-id="build-key"]')?.textContent).toContain("Nightly build");
    expect(doc.querySelector('[data-setup-selected-key="different-key"]')).not.toBeNull();
    expect(result.html).not.toContain("private_hash_");
  });

  it("keeps list, creation and person tasks readable when unrelated provider inventories fail", async () => {
    const f = inventoryFixture();
    const prepare = f.db.binding.prepare.bind(f.db.binding);
    vi.spyOn(f.db.binding, "prepare").mockImplementation(sql => {
      if (sql.includes("SELECT * FROM codex_auths") || sql.includes("SELECT * FROM subscription_accounts ORDER BY")) throw new Error("synthetic provider inventory failure");
      return prepare(sql);
    });
    for (const query of ["view=access", "view=access&task=add-person", "view=access&task=add-service", "view=access&person=person-000"]) {
      const result = await f.render(query);
      expect(result.status).toBe(200);
      expect(ids(result.html, "data-user-id")).toHaveLength(20);
      expect(result.html).not.toContain("data-dashboard-unavailable");
      if (query.includes("person=person-000")) {
        const doc = new JSDOM(result.html).window.document;
        expect(doc.querySelector('[data-key-id="key-000"]')).not.toBeNull();
        expect(doc.querySelector('[data-action="user-status"]')).not.toBeNull();
        expect(doc.querySelectorAll('[data-credit-surface]')).toHaveLength(3);
      }
    }
  });

  it("shows an unread provider as unknown while keeping a known provider binding and key operations available", async () => {
    const f = inventoryFixture();
    f.db.sqlite.exec(`UPDATE api_keys SET scopes='["surface:codex:production","surface:grok:production"]' WHERE id='key-000'`);
    const prepare = f.db.binding.prepare.bind(f.db.binding);
    vi.spyOn(f.db.binding, "prepare").mockImplementation(sql => {
      if (sql.includes("SELECT * FROM codex_auths")) throw new Error("synthetic Codex inventory failure");
      return prepare(sql);
    });
    const result = await f.render("view=access&person=person-000&key=key-000&range=30d&q=absent");
    expect(result.status).toBe(200);
    const doc = new JSDOM(result.html).window.document;
    expect(doc.querySelector('[data-key-detail="key-000"]')).not.toBeNull();
    const unknown = doc.querySelector('[data-credential-read-state="unknown"]');
    expect(unknown?.textContent).toContain("Codex");
    expect(unknown?.textContent).toContain("连接列表暂时未读到");
    expect(unknown?.querySelector("form,select")).toBeNull();
    const recovery = new URL(unknown!.querySelector("a")!.getAttribute("href")!, "https://admin.example.test");
    expect(Object.fromEntries(recovery.searchParams)).toMatchObject({ view: "access", person: "person-000", key: "key-000", range: "30d", q: "absent" });
    expect(doc.querySelector('[data-action="credential-binding-set"][action*="/grok"]')).not.toBeNull();
    expect(doc.querySelector('[data-action="credential-binding-set"][action*="/codex"]')).toBeNull();
    expect(doc.querySelector('[data-action="replace-key"]')).not.toBeNull();
    expect(doc.querySelector('[data-action="revoke-key"]')).not.toBeNull();
  });

  it("omits an unread service choice without disabling a known provider in the creation task", async () => {
    const f = inventoryFixture();
    const at = "2026-09-12T12:00:00.000Z";
    f.db.sqlite.prepare(`INSERT INTO subscription_accounts
      (id,capability_source,environment,label,status,refresh_available,created_at,updated_at)
      VALUES ('grok-known','grok','production','Known Grok','active',1,?,?)`).run(at, at);
    const prepare = f.db.binding.prepare.bind(f.db.binding);
    vi.spyOn(f.db.binding, "prepare").mockImplementation(sql => {
      if (sql.includes("SELECT * FROM codex_auths") || sql.includes("LEFT JOIN user_surface_credit_modes AS explicit")) throw new Error("synthetic unrelated read failure");
      return prepare(sql);
    });
    const result = await f.render("view=access&person=person-000&task=give-access");
    expect(result.status).toBe(200);
    const doc = new JSDOM(result.html).window.document;
    const unknown = doc.querySelector('[data-credential-read-state="unknown"]');
    expect(unknown?.textContent).toContain("Codex");
    expect(unknown?.textContent).not.toContain("没有可用账号");
    expect(doc.querySelector('[name="codex_credential_account_id"]')).toBeNull();
    expect(doc.querySelector('[name="grok_credential_account_id"] option[value="grok-known"]')?.textContent).toContain("Known Grok");
    expect(doc.querySelector('#give-access form[action="/admin/ui/keys"]')).not.toBeNull();
  });

  it("preserves known key coverage while a failed quota read shows no fabricated zero or policy control", async () => {
    const f = inventoryFixture();
    const prepare = f.db.binding.prepare.bind(f.db.binding);
    vi.spyOn(f.db.binding, "prepare").mockImplementation(sql => {
      if (sql.includes("LEFT JOIN user_surface_credit_modes AS explicit")) throw new Error("synthetic quota failure");
      return prepare(sql);
    });
    const result = await f.render("view=access&person=person-000");
    expect(result.status).toBe(200);
    const doc = new JSDOM(result.html).window.document;
    expect(doc.querySelector('[data-key-id="key-000"]')).not.toBeNull();
    expect(doc.querySelector('[data-access-client="codex"]')?.getAttribute("data-access-state")).toBe("granted");
    const rows = [...doc.querySelectorAll('[data-credit-surface]')];
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row.textContent).toContain("未读到");
      expect(row.querySelector('[role="alert"]')?.textContent).toBe("读取失败");
      expect(row.querySelector("form,input,button")).toBeNull();
      expect(row.querySelector(".credit-used strong")?.textContent).toBe("未读到");
    }
    expect(doc.querySelector('#credits [data-action="credit-set"]')).toBeNull();
  });

  it("retains an exact service key when neighboring owner and quota reads are unavailable", async () => {
    const f = inventoryFixture(false);
    f.person("build-service");
    f.db.sqlite.exec("UPDATE users SET account_kind='service', display_name='Nightly build' WHERE id='build-service'");
    f.key("build-key", "build-service", "grok");
    const prepare = f.db.binding.prepare.bind(f.db.binding);
    vi.spyOn(f.db.binding, "prepare").mockImplementation(sql => {
      if (sql.includes("FROM service_account_owners") || sql.includes("LEFT JOIN user_surface_credit_modes AS explicit")) throw new Error("synthetic person-only read failure");
      return prepare(sql);
    });
    const result = await f.render("view=access&kind=service&person=build-service&key=build-key");
    expect(result.status).toBe(200);
    expect(new JSDOM(result.html).window.document.querySelector('[data-key-detail="build-key"]')).not.toBeNull();
    expect(result.html).not.toContain("data-dashboard-unavailable");
  });

  it("keeps key rows read-only and opens an exact key beyond the current search and page", async () => {
    const f = inventoryFixture();
    const list = await f.render("view=access&person=person-100&range=30d&key_page=5");
    const row = new JSDOM(list.html).window.document.querySelector('[data-key-id="key-001"]')?.outerHTML;
    expect(row).toContain('aria-label="管理密钥 prefix_key-001"');
    expect(row).not.toContain("<form");
    expect(row).not.toContain("<button");
    expect(hrefs(row!).find(url => url.searchParams.get("key") === "key-001")?.searchParams.get("key_page")).toBe("5");
    const detail = await f.render("view=access&person=person-100&key=key-001&range=30d&q=absent&key_q=absent&key_page=5");
    expect(detail.status).toBe(200);
    expect(detail.html).toContain('data-key-detail="key-001"');
    expect(detail.html).toContain('action="/admin/ui/keys/key-001/replace"');
    expect(detail.html).toContain('action="/admin/ui/keys/key-001/credential-bindings/codex?person=person-100"');
    expect(detail.html).not.toContain('data-key-id=');
    expect(new JSDOM(detail.html).window.document.querySelector('[data-person-detail="person-100"] [data-action="credit-set"]')).not.toBeNull();
    expect(new JSDOM(detail.html).window.document.querySelector('[data-person-detail="person-100"] [data-action="user-status"]')).not.toBeNull();
    const parent = new URL(new JSDOM(detail.html).window.document.querySelector('a[aria-label="收起密钥详情"]')!.getAttribute("href")!, "https://console.invalid");
    expect(parent?.searchParams.has("key")).toBe(false);
    expect(parent?.searchParams.get("person")).toBe("person-100");
    expect(parent?.searchParams.get("range")).toBe("30d");
    expect(parent?.searchParams.get("key_page")).toBe("5");
    expect(parent?.searchParams.get("q")).toBe("absent");
    expect(detail.html).not.toContain("private_hash_");
  });

  it.each(["missing", "key-000"])("never substitutes controls for a missing or foreign key: %s", async key => {
    const { html } = await inventoryFixture().render(`view=access&person=person-100&key=${key}`);
    expect(html).toContain("没有这个密钥");
    expect(html).toContain('data-key-missing');
    expect(html).not.toContain('data-action="replace-key"');
    expect(html).not.toContain('data-action="credential-binding-set"');
    expect(html).not.toContain('data-action="revoke-key"');
    expect(new JSDOM(html).window.document.querySelector('[data-key-detail]')).toBeNull();
  });

  it.each(["active", "expired", "revoked", "paused"])("preserves exact-key controls and facts for %s", async state => {
    const f = inventoryFixture();
    if (state === "expired") f.db.sqlite.prepare("UPDATE api_keys SET expires_at='2026-09-12T12:00:00.000Z' WHERE id='key-000'").run();
    if (state === "revoked") f.db.sqlite.prepare("UPDATE api_keys SET status='revoked' WHERE id='key-000'").run();
    if (state === "paused") f.db.sqlite.prepare("UPDATE users SET status='disabled' WHERE id='person-000'").run();
    const { html } = await f.render("view=access&person=person-000&key=key-000");
    expect(html).toContain('data-key-detail="key-000"');
    const doc = new JSDOM(html).window.document;
    expect(doc.querySelector('.key-detail-head .eyebrow')?.textContent).toBe('person0@example.test');
    expect(html).toContain("2020-01-01 00:00 UTC");
    expect(doc.querySelector('.key-detail-head .key-state')?.textContent).toBe({ active: "有效", expired: "已过期", revoked: "已撤销", paused: "已暂停 — 人员已停用" }[state]);
    expect(html.includes('data-action="replace-key"')).toBe(state === "active" || state === "paused");
    expect(html.includes('data-action="credential-binding-set"')).toBe(state === "active" || state === "paused");
    expect(html.includes('data-action="revoke-key"')).toBe(state !== "revoked");
    if (state === "expired") {
      const next = hrefs(html).find(url => url.searchParams.get("task") === "give-access");
      expect(next?.searchParams.get("person")).toBe("person-000");
      expect(next?.searchParams.has("key")).toBe(false);
    }
  });

  it.each(["FROM api_keys WHERE id", "FROM api_key_surface_credentials"])("reports unavailable when exact key data cannot be read: %s", async failure => {
    const f = inventoryFixture();
    const prepare = f.db.binding.prepare.bind(f.db.binding);
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    onTestFinished(() => log.mockRestore());
    vi.spyOn(f.db.binding, "prepare").mockImplementation(sql => {
      if (sql.includes(failure)) throw new Error("private read failure");
      return prepare(sql);
    });
    const result = await f.render("view=access&person=person-000&key=key-000");
    expect(result.status).toBe(503);
    expect(result.html).toContain("data-dashboard-unavailable");
    expect(result.html).not.toContain("没有这个密钥");
    expect(result.html).not.toContain('data-action="revoke-key"');
  });

  it("counts the whole inventory while traversing bounded pages without duplicates at tied timestamps", async () => {
    const f = inventoryFixture();
    const home = await f.render("view=overview");
    expect(home.status).toBe(200);
    const homeDoc = new JSDOM(home.html).window.document;
    const summaries = [...homeDoc.querySelectorAll('[data-home-summary] a')];
    expect(summaries.find(link => link.querySelector('span')?.textContent === '成员与服务账号')?.querySelector('strong')?.textContent).toBe('101');
    expect(summaries.find(link => link.querySelector('span')?.textContent === '密钥')?.querySelector('strong')?.textContent).toBe('201');
    for (const [view, attribute, pages, total] of [
      ["access", "data-user-id", 6, 101], ["setup", "data-setup-key-id", 6, 201]
    ] as const) {
      const all: string[] = [];
      for (let page = 1; page <= pages; page++) {
        const { status, html } = await f.render(`view=${view}&page=${page}`);
        expect(status).toBe(200);
        const visible = ids(html, attribute);
        expect(visible.length).toBeLessThanOrEqual(view === "access" ? 20 : 40);
        expect(visible.length).toBeGreaterThan(0);
        all.push(...visible as string[]);
        expect(html).not.toContain("private_hash_");
        expect(html).not.toContain("Person not loaded");
        const next = hrefs(html).find(url => url.searchParams.get("page") === String(page + 1));
        expect(Boolean(next)).toBe(page < pages);
      }
      expect(all).toHaveLength(total);
      expect(new Set(all).size).toBe(total);
    }
  });

  it("loads an older exact person and their key state independently of the visible list", async () => {
    const f = inventoryFixture();
    f.db.sqlite.prepare("UPDATE users SET status='disabled' WHERE id='person-000'").run();
    const { html } = await f.render("view=access&q=person-100&person=person-000");
    expect(ids(html, "data-user-id")).toEqual(["person-100"]);
    expect(html).toContain('data-person-detail="person-000"');
    expect(html).toContain('data-access-client="codex" data-access-state="paused"');
    expect(new JSDOM(html).window.document.querySelector('[data-key-id="key-000"] [data-key-state="paused"]')?.textContent).toBe("已暂停 — 人员已停用");
    expect(html).not.toContain("未显示人员");
    expect(html).not.toContain("Person not loaded");
    const missing = await f.render("view=access&person=missing&task=give-access");
    expect(missing.html).toContain("未显示人员");
    expect(missing.html).not.toContain('name="user_id"');
  });

  it("keeps complete grant summaries when the relevant key is on a later page or excluded by search", async () => {
    const f = inventoryFixture();
    for (const suffix of ["", "&key_page=5", "&key_q=absent"]) {
      const { html } = await f.render(`view=access&person=person-100${suffix}`);
      expect(html).toContain('data-access-client="codex" data-access-state="granted"');
      expect(html).toContain('data-access-client="grok" data-access-state="granted"');
      expect(ids(html, "data-key-id").length).toBeLessThanOrEqual(40);
    }
    const last = await f.render("view=access&person=person-100&key_page=5");
    expect(ids(last.html, "data-key-id")).toContain("key-001");
    const filtered = await f.render("view=access&person=person-100&key_q=prefix_key-001");
    expect(ids(filtered.html, "data-key-id")).toEqual(["key-001"]);
  });

  it("preserves expiry, revocation and disabled-person meanings regardless of key filters", async () => {
    const f = inventoryFixture();
    f.key("expired", "person-098", "codex");
    f.key("invalid-expiry", "person-098", "grok");
    f.key("revoked", "person-098", "xai");
    f.db.sqlite.prepare("UPDATE api_keys SET expires_at=? WHERE id='expired'").run("2026-09-12T12:00:00.000Z");
    f.db.sqlite.prepare("UPDATE api_keys SET expires_at='invalid' WHERE id='invalid-expiry'").run();
    f.db.sqlite.prepare("UPDATE api_keys SET status='revoked' WHERE id='revoked'").run();
    const { html } = await f.render("view=access&person=person-098&key_q=absent");
    expect(html).toContain('data-access-client="codex" data-access-state="expired"');
    expect(html).toContain('data-access-client="grok" data-access-state="granted"');
    expect(html).toContain('data-access-client="xai" data-access-state="none"');
    expect(html).toContain("没有匹配的密钥。");
  });

  it("keeps Setup inventory read-only and selects an exact key beyond its search and page", async () => {
    const f = inventoryFixture();
    const prepare = f.db.binding.prepare.bind(f.db.binding);
    const reads = vi.spyOn(f.db.binding, "prepare");
    const list = await f.render("view=setup");
    expect(list.status).toBe(200);
    expect(list.html).not.toContain('data-action="create-setup-package"');
    const listDoc = new JSDOM(list.html).window.document;
    expect(listDoc.querySelector('[data-local-config-sync]')?.hasAttribute('hidden')).toBe(true);
    expect(listDoc.querySelector('[data-local-config-sync]')?.getAttribute('method')).toBeNull();
    expect(reads.mock.calls.some(([sql]) => sql.includes("request_audit"))).toBe(false);
    const detail = await f.render("view=setup&person=person-000&key=key-000&q=absent&page=3&range=30d");
    expect(detail.status).toBe(200);
    expect(ids(detail.html, "data-setup-key-id")).toEqual([]);
    expect(detail.html).toContain('data-setup-selected-key="key-000"');
    expect(detail.html).toContain('action="/admin/ui/keys/key-000/replace"');
    expect(detail.html).toContain('data-setup-client="codex"');
    expect(new JSDOM(detail.html).window.document.querySelector('[data-setup-selected-key="key-000"] [data-setup-client="grok"]')).toBeNull();
    expect(new JSDOM(detail.html).window.document.querySelector('[data-setup-selected-key="key-000"] [data-setup-client="xai"]')).toBeNull();
    const search = detail.html.match(/<form class="inventory-search"[\s\S]*?<\/form>/)?.[0];
    expect(search).toContain('name="person" value="person-000"');
    expect(search).toContain('name="key" value="key-000"');
    const parent = hrefs(detail.html).find(url => url.searchParams.get("q") === "absent" && !url.searchParams.has("person") && !url.searchParams.has("task"));
    expect(parent?.searchParams.get("page")).toBe("3");
    expect(parent?.searchParams.get("range")).toBe("30d");
    reads.mockImplementation(sql => {
      if (sql.includes("request_audit")) throw new Error("Synthetic verification failure");
      return prepare(sql);
    });
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    onTestFinished(() => log.mockRestore());
    const failed = await f.render("view=setup&person=person-000&key=key-000");
    expect(failed.status).toBe(503);
    expect(failed.html).toContain("data-dashboard-unavailable");
    expect(failed.html).not.toContain('data-result="not-verified"');
  });

  it.each(["missing", "key-001"])("does not substitute a Setup key for missing or foreign selection %s", async key => {
    const result = await inventoryFixture().render(`view=setup&person=person-000&key=${key}`);
    expect(result.status).toBe(200);
    expect(result.html).toContain("没有这个密钥");
    expect(result.html).not.toContain('data-action="create-setup-package"');
    expect(result.html).not.toContain('data-client-verification=');
  });

  it.each(["active", "paused", "expired", "revoked"])("keeps Setup state and actions accurate for %s", async state => {
    const f = inventoryFixture();
    if (state === "paused") f.db.sqlite.prepare("UPDATE users SET status='disabled' WHERE id='person-000'").run();
    if (state === "expired") f.db.sqlite.prepare("UPDATE api_keys SET expires_at='2020-01-01T00:00:00Z' WHERE id='key-000'").run();
    if (state === "revoked") f.db.sqlite.prepare("UPDATE api_keys SET status='revoked' WHERE id='key-000'").run();
    const { html } = await f.render("view=setup&person=person-000&key=key-000");
    const badge = new JSDOM(html).window.document.querySelector('.setup-config-card .key-state');
    expect(badge?.getAttribute('data-key-state')).toBe(state);
    expect(badge?.textContent).toBe({active:"有效",paused:"已暂停 — 人员已停用",expired:"已过期",revoked:"已撤销"}[state]);
    expect(html.includes('data-action="create-setup-package"')).toBe(["active", "paused"].includes(state));
    expect([...new JSDOM(html).window.document.querySelectorAll('.setup-config-card a')].some(link => link.textContent === "创建新密钥")).toBe(state === "expired");
    if (state === "expired") {
      const next = hrefs(html).find(url => url.searchParams.get("task") === "give-access");
      expect(next?.searchParams.get("person")).toBe("person-000");
      expect(next?.searchParams.has("key")).toBe(false);
    }
  });

  it("keeps local configuration beside inventory with only a non-secret client draft", async () => {
    const { html, status } = await inventoryFixture().render("view=setup&task=sync-configuration&q=absent&page=2&range=30d");
    expect(status).toBe(200);
    expect(html).toContain('data-sync-configuration="local-only"');
    expect(html).toMatch(/<form\b[^>]*data-dashboard-draft="sync"[^>]*\bhidden/);
    expect(html).toContain("要在这台设备上生成文件，请启用 JavaScript。");
    expect(html).toContain('name="existing_key"');
    expect(html).toContain('type="password"');
    expect(html).not.toContain('data-action="create-setup-package"');
    const clientChoices = new JSDOM(html).window.document.querySelectorAll('select[name="client"] option');
    expect(Array.from(clientChoices, option => option.getAttribute("value"))).toEqual(["codex", "grok", "xai"]);
    const doc = new JSDOM(html).window.document;
    expect(doc.querySelector('#setup-list input[name="q"]')?.getAttribute("value")).toBe("absent");
    expect(doc.querySelector('#setup-list input[name="range"]')?.getAttribute("value")).toBe("30d");
  });

  it("finds older setup packages and attributes real-task evidence to the displayed key", async () => {
    const f = inventoryFixture();
    f.db.sqlite.prepare("INSERT INTO request_audit(id,route_profile_id,user_id,key_id,status,upstream_status,created_at) VALUES('proof','codex.responses','person-000','key-000','ok',200,'2026-09-12T11:00:00.000Z')").run();
    const { html } = await f.render("view=setup&q=person0@example.test&person=person-000&key=key-000");
    expect(ids(html, "data-setup-key-id")).toEqual(["key-000"]);
    expect(html).toContain("最近任务成功");
    expect(html).not.toContain("Person not loaded");
    const other = await f.render("view=setup&q=prefix_key-001&person=person-100&key=key-001");
    expect(ids(other.html, "data-setup-key-id")).toEqual(["key-001"]);
    expect(other.html).not.toContain("最近任务成功");
  });

  it("treats punctuation and non-ASCII search as literal input without HTML or SQL injection", async () => {
    const f = inventoryFixture();
    const literal = "张 %_'\"<& OR 1=1 --";
    f.person(literal, "literal@example.test");
    f.key("literal", literal, "codex");
    for (const view of ["access", "setup"]) {
      const { status, html } = await f.render(`view=${view}&q=${encodeURIComponent(literal)}`);
      expect(status).toBe(200);
      expect(ids(html, view === "access" ? "data-user-id" : "data-setup-key-id")).toHaveLength(1);
      expect(html).not.toContain(literal);
      expect(html).toContain("&lt;&amp;");
    }
    expect(ids((await f.render("view=access&q=PERSON100@EXAMPLE.TEST")).html, "data-user-id")).toEqual(["person-100"]);
  });

  it("preserves exact task context in GET search, pagination and parent/cancel links", async () => {
    const f = inventoryFixture();
    const query = "view=access&range=30d&person=person-100&task=give-access&q=person-&page=2&page_size=10&key_q=prefix&key_page=3";
    const { html } = await f.render(query);
    const searchForm = html.match(/<form class="inventory-search"[\s\S]*?<\/form>/)?.[0];
    expect(searchForm).toContain('method="get"');
    expect(searchForm).toContain('action="/admin"');
    for (const [name, value] of [["view", "access"], ["range", "30d"], ["person", "person-100"], ["task", "give-access"], ["key_page", "3"], ["page_size", "10"]]) {
      expect(searchForm).toContain(`name="${name}" value="${value}"`);
    }
    expect(searchForm).not.toContain('name="page"');
    const next = hrefs(html).find(url => url.searchParams.get("page") === "3" && url.searchParams.get("task") === "give-access");
    expect(next?.pathname).toBe("/admin");
    expect(next?.searchParams.get("person")).toBe("person-100");
    expect(next?.searchParams.get("key_page")).toBe("3");
    const cancel = new JSDOM(html).window.document.querySelector("a[data-discard-draft]")?.getAttribute("href");
    if (!cancel) throw new Error("Missing access-task cancel link");
    const parent = new URL(cancel, "https://admin.example.test");
    expect(parent.searchParams.has("task")).toBe(false);
    expect(parent.searchParams.get("page")).toBe("2");
    expect(parent.searchParams.get("person")).toBe("person-100");
    expect(parent.searchParams.get("key_q")).toBe("prefix");
    expect(parent.searchParams.get("page_size")).toBe("10");
  });

  it.each([10, 20, 40])("traverses the filtered member inventory at %i per page and exposes a native size form", async pageSize => {
    const f = inventoryFixture();
    f.db.sqlite.exec("UPDATE users SET role='admin' WHERE id BETWEEN 'person-001' AND 'person-015'");
    const all: string[] = [];
    for (let page = 1; page <= Math.ceil(86 / pageSize); page++) {
      const {status, html} = await f.render(`view=access&q=person-&page_size=${pageSize}&page=${page}&person=person-001&range=30d`);
      expect(status).toBe(200);
      const visible = ids(html, "data-user-id");
      expect(visible.length).toBeLessThanOrEqual(pageSize);
      all.push(...visible);
      const doc = new JSDOM(html).window.document;
      const form = doc.querySelector('form.inventory-page-size');
      expect(form?.getAttribute("method")).toBe("get");
      expect(form?.querySelector('[name="page_size"] option[selected]')?.getAttribute("value")).toBe(String(pageSize));
      expect(form?.querySelector('[name="page"]')).toBeNull();
      for (const [name, value] of [["q", "person-"], ["person", "person-001"], ["range", "30d"]]) {
        expect(form?.querySelector(`[name="${name}"]`)?.getAttribute("value")).toBe(value);
      }
      expect(hrefs(html).filter(url => url.searchParams.get("page")).every(url => url.searchParams.get("page_size") === String(pageSize))).toBe(true);
    }
    expect(all).toHaveLength(86);
    expect(new Set(all).size).toBe(86);
    expect(all.some(id => id >= "person-001" && id <= "person-015")).toBe(false);
  });

  it.each(["view=access&page_size=0", "view=access&page_size=15", "view=access&page_size=10.0", "view=access&page_size=20&page_size=40", "view=setup&page_size=20", "view=quotas&page_size=10", "view=access&page_size="])("rejects an invalid or cross-route people page size: %s", async query => {
    expect((await inventoryFixture(false).render(query)).status).toBe(400);
  });

  it("distinguishes no matches, an empty page and an empty inventory with recovery controls", async () => {
    const f = inventoryFixture(false);
    expect((await f.render("view=access")).html).toContain("这个分类下还没有账号。");
    expect((await f.render("view=access&q=absent")).html).toContain("没有匹配的账号，试试其他邮箱或名称。");
    const page = await f.render("view=access&page=2");
    expect(page.html).toContain("这一页没有账号。");
    expect(page.html).toContain("上一页</a>");
    expect(page.html).not.toContain("Next ");
    expect((await f.render("view=setup&q=absent")).html).toContain("没有匹配的密钥。");
    expect((await f.render("view=setup&page=2")).html).toContain("这一页没有密钥。");
    expect((await f.render("view=setup")).html).toContain("还没有密钥。");
  });

  it.each(["view=access&page=0", "view=access&page=1.5", "view=access&page=9999999999999999", "view=access&q=a&q=b", "view=overview&q=a", "view=access&key_page=2", "view=setup&key_q=a", `view=access&q=${"x".repeat(257)}`, "view=access&q=%00", "view=access&key=key-000", "view=access&person=p&key=", "view=setup&person=p", "view=setup&key=k", "view=setup&person=p&task=sync-configuration", "view=access&person=p&key=k&task=give-access", "view=access&person=p&key=k&key=j"])("rejects invalid inventory query: %s", async query => {
    expect((await inventoryFixture(false).render(query)).status).toBe(400);
  });

  it("returns unavailable when an exact person or setup owner cannot be read", async () => {
    for (const query of ["view=access&person=person-000", "view=setup&q=prefix_key-000"]) {
      const f = inventoryFixture();
      const prepare = f.db.binding.prepare.bind(f.db.binding);
      const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
      onTestFinished(() => log.mockRestore());
      vi.spyOn(f.db.binding, "prepare").mockImplementation(sql => {
        if (sql.includes("FROM users WHERE id")) throw new Error("private read failure");
        return prepare(sql);
      });
      const result = await f.render(query);
      expect(result.status).toBe(503);
      expect(result.html).toContain("data-dashboard-unavailable");
      expect(result.html).not.toContain("private read failure");
      expect(result.html).not.toContain("这个分类下还没有账号。");
    }
  });
});
