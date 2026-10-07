import { JSDOM } from "jsdom";
import { expect, it, vi } from "vitest";
import { createConsoleSession } from "../../src/auth/console-session";
import { resolveConsolePrincipal } from "../../src/auth/principal";
import { handleRequest } from "../../src/router";
import { makeFixture, consoleCookie, type Fixture } from "../router/fixture";
import { createTestD1 } from "../support/sqlite-d1";

const host = "https://admin.example.test";
function form(fixture: Fixture, token: string, id: string, action: string, values: Record<string, string>): Promise<Response> {
  return handleRequest(new Request(`${host}/admin/ui/users/${encodeURIComponent(id)}/${action}`, {
    method: "POST", headers: { Cookie: `__Host-mini-console=${token}`, Origin: host, Accept: "text/html", "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ confirm: "1", ...values })
  }), fixture.env, fixture.ctx, fixture.deps);
}

it("returns native role/email outcomes to the exact member and bounded list context", async () => {
  const fixture = makeFixture();
  fixture.db.seedConsoleUser({ id: "admin", email: "admin@example.com", role: "admin" });
  fixture.db.seedConsoleUser({ id: "target", email: "target@example.com" });
  const token = await consoleCookie(fixture, "admin@example.com");
  const person_return = "/admin?view=access&person=target&range=30d&q=target&page=2";
  for (const [action, input] of [["role", { role: "admin" }], ["email", { email: " Next+Work@Example.com " }]] as const) {
    const response = await form(fixture, token, "target", action, { ...input, person_return });
    expect(response.status).toBe(200);
    const doc = new JSDOM(await response.text()).window.document;
    const destination = new URL(doc.querySelector("main")?.getAttribute("data-dashboard-url") ?? "", host);
    expect(destination.searchParams.get("person")).toBe("target");
    expect(destination.searchParams.get("range")).toBe("30d");
    expect(destination.searchParams.get("q")).toBe("target");
    expect(destination.searchParams.get("page")).toBe("2");
    expect(doc.querySelector(`[data-mutation-flash="user_${action}"]`)).not.toBeNull();
  }
  const invalid = await form(fixture, token, "target", "email", { email: "new@other.test", person_return });
  expect(invalid.status).toBe(400);
  const invalidDoc = new JSDOM(await invalid.text()).window.document;
  expect(invalidDoc.querySelector('form[action="/admin/ui/users/target/email"] input[name="email"]')?.getAttribute("value")).toBe("new@other.test");
  expect(invalidDoc.querySelector('[data-mutation-input-error]')?.textContent).toContain("邮箱域名");
  expect(fixture.db.users.get("target")?.email).toBe("next+work@example.com");
  const outside = await form(fixture, token, "target", "role", { role: "user", person_return: "https://evil.test/admin?view=access&person=target" });
  const outsideDoc = new JSDOM(await outside.text()).window.document;
  expect(outsideDoc.querySelector("main")?.getAttribute("data-dashboard-url")).toBe("/admin?view=access&range=7d&person=target");
});

it("finishes self-demotion without loading a forbidden management page", async () => {
  const fixture = makeFixture();
  fixture.db.seedConsoleUser({ id: "admin", email: "admin@example.com", role: "admin" });
  fixture.db.seedConsoleUser({ id: "other", email: "other@example.com", role: "admin" });
  const token = await consoleCookie(fixture, "admin@example.com");
  const response = await form(fixture, token, "admin", "role", { role: "user" });
  expect(response.status).toBe(200);
  const doc = new JSDOM(await response.text()).window.document;
  expect(doc.querySelector('[data-console-terminal-result]')?.textContent).toContain("你现在是普通成员");
  expect(doc.querySelector('a[href="/admin?view=keys"]')).not.toBeNull();
  expect(doc.querySelector('[data-dashboard-nav]')).toBeNull();
  const rejected = await form(fixture, token, "other", "role", { role: "user" });
  expect(rejected.status).toBe(403);
  expect(await rejected.text()).toContain("这次管理操作没有执行");
  expect(fixture.db.users.get("other")?.role).toBe("admin");
});

it("ends self-email migration at reauthentication and renders login for the stale cookie", async () => {
  const fixture = makeFixture();
  fixture.db.seedConsoleUser({ id: "admin", email: "admin@example.com", role: "admin" });
  const token = await consoleCookie(fixture, "admin@example.com");
  const response = await form(fixture, token, "admin", "email", { email: "new@example.com" });
  expect(response.status).toBe(200);
  expect(response.headers.get("Set-Cookie")).toContain("Max-Age=0");
  const html = await response.text();
  expect(html).toContain("旧控制台会话已失效");
  expect(html).toContain("API 密钥和历史不变");
  expect(html).not.toContain("data-dashboard-nav");
  const login = await handleRequest(new Request(`${host}/login`, { headers: { Cookie: `__Host-mini-console=${token}` } }), fixture.env, fixture.ctx, fixture.deps);
  expect(login.status).toBe(200);
  expect(login.headers.has("Location")).toBe(false);
  const rejected = await form(fixture, token, "admin", "email", { email: "again@example.com" });
  expect(rejected.status).toBe(403);
  expect(await rejected.text()).toContain("这次管理操作没有执行");
  expect(fixture.db.users.get("admin")?.email).toBe("new@example.com");
});

it("retains a confirmed mailbox change when its follow-up inventory read fails", async () => {
  let failRead = false;
  const db = createTestD1({ onPrepare: sql => { if (failRead && sql.includes("ORDER BY created_at DESC, id ASC")) throw new Error("synthetic inventory failure"); } });
  const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
  const fixture = makeFixture({ env: { DB: db.binding } });
  try {
    const principal = await resolveConsolePrincipal(fixture.env, "admin@example.com", fixture.deps.now());
    const target = await resolveConsolePrincipal(fixture.env, "target@example.com", fixture.deps.now());
    db.sqlite.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(principal.id);
    const token = await createConsoleSession(fixture.env, principal, fixture.deps.now());
    failRead = true;
    const response = await form(fixture, token, target.id, "email", { email: "changed@example.com" });
    expect(response.status).toBe(503);
    const html = await response.text();
    expect(html).toContain('data-mutation-flash="user_email"');
    expect(html).toContain("邮箱已迁移");
    expect(html).toContain("data-dashboard-unavailable");
    expect(db.sqlite.prepare("SELECT canonical_email FROM users WHERE id = ?").get(target.id)).toEqual({ canonical_email: "changed@example.com" });
  } finally { log.mockRestore(); db.close(); }
});

it("gives native human creation a known rejection when authority changes before its committing insert", async () => {
  let revoke = false;
  const db = createTestD1({ onBind: (sql, values) => {
    if (revoke && sql.startsWith("INSERT INTO users") && values[1] === "new@example.com") {
      revoke = false;
      db.sqlite.exec("UPDATE users SET role = 'user' WHERE canonical_email = 'admin@example.com'");
    }
  } });
  const fixture = makeFixture({ env: { DB: db.binding } });
  try {
    const principal = await resolveConsolePrincipal(fixture.env, "admin@example.com", fixture.deps.now());
    db.sqlite.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(principal.id);
    const token = await createConsoleSession(fixture.env, principal, fixture.deps.now());
    revoke = true;
    const response = await handleRequest(new Request(`${host}/admin/ui/users`, {
      method: "POST", headers: { Cookie: `__Host-mini-console=${token}`, Origin: host, Accept: "text/html", "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ email: "new@example.com" })
    }), fixture.env, fixture.ctx, fixture.deps);
    expect(response.status).toBe(403);
    expect(response.headers.get("Content-Type")).toContain("text/html");
    const doc = new JSDOM(await response.text()).window.document;
    expect(doc.querySelector('[data-console-terminal-result]')?.textContent).toContain("这次人员创建没有执行");
    expect(doc.querySelector('a[href="/login"]')).not.toBeNull();
    expect(db.sqlite.prepare("SELECT COUNT(*) AS count FROM users WHERE canonical_email = 'new@example.com'").get()).toEqual({ count: 0 });
    expect(db.sqlite.prepare("SELECT COUNT(*) AS count FROM operator_mutation_audit WHERE action = 'user.create'").get()).toEqual({ count: 0 });
  } finally { db.close(); }
});
