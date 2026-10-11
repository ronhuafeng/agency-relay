import { JSDOM } from "jsdom";
import { expect, it, onTestFinished, vi } from "vitest";
import { createConsoleSession } from "../../src/auth/console-session";
import { commitServiceAccount } from "../../src/auth/service-accounts";
import { commitServiceOwner } from "../../src/auth/service-delegation";
import { handleRequest } from "../../src/router";
import { createTestD1 } from "../support/sqlite-d1";

const now = new Date("2026-10-06T12:00:00.000Z");
const origin = "https://admin.example.test";
async function fixture() {
  let duringRead: (() => void) | undefined;
  const db = createTestD1({onPrepare: sql => {
    if (duringRead && sql.includes("organization_surface_credit_defaults")) { const action = duringRead; duringRead = undefined; action(); }
  }});
  onTestFinished(() => db.close());
  const provider = vi.fn(async () => { throw new Error("Quiet reads cannot probe providers"); });
  const env = {DB: db.binding, ADMIN_DASHBOARD_HOST: "admin.example.test", CONSOLE_EMAIL_DOMAIN: "example.test", API_KEY_HASH_PEPPER: "synthetic-revision", ADMIN_SECRET: "synthetic-operator"} as unknown as Env;
  for (const [id, role] of [["admin-a", "admin"], ["member-a", "user"], ["member-b", "user"]]) {
    db.sqlite.prepare(`INSERT INTO users (id,email,canonical_email,role,status,account_kind,login_capable,created_at,updated_at)
      VALUES (?,?,?,?,'active','human',1,?,?)`).run(id!, `${id}@example.test`, `${id}@example.test`, role!, now.toISOString(), now.toISOString());
  }
  const sessions = new Map<string, string>();
  for (const id of ["admin-a", "member-a", "member-b"]) sessions.set(id, await createConsoleSession(env, {id, email: `${id}@example.test`, sessionEpoch: 0}, now));
  const read = (path: string, actor = "admin-a", revision?: string) => {
    const headers = new Headers({Accept: "text/html", Cookie: `__Host-mini-console=${sessions.get(actor)}`});
    if (revision) headers.set("X-Console-Revision", revision);
    return handleRequest(new Request(origin + path, {headers}), env, {waitUntil: () => {}}, {now: () => now, fetch: provider});
  };
  return {db, env, read, provider, duringRead: (action: () => void) => {duringRead = action;}};
}
async function model(response: Response) {
  expect(response.status).toBe(200);
  const doc = new JSDOM(await response.text()).window.document;
  const main = doc.querySelector("main")!;
  const revision = main.getAttribute("data-console-revision")!;
  expect(revision).toMatch(/^[a-f0-9]{64}$/);
  return {revision, path: main.getAttribute("data-console-read-url")!, doc};
}
it.each([["/admin?view=quotas", "admin-a"], ["/admin?area=me&view=quota", "member-a"]])("acknowledges unchanged authorized %s without a document payload", async (path, actor) => {
  const f = await fixture(); const initial = await model(await f.read(path!, actor));
  const response = await f.read(initial.path, actor, initial.revision);
  expect(response.status).toBe(204); expect(await response.text()).toBe("");
  expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  expect(response.headers.get("X-Console-Actor-Id")).toBe(actor); expect(response.headers.get("X-Console-Revision")).toBe(initial.revision);
  expect(f.provider).not.toHaveBeenCalled();
});
it("returns changed server data as HTML, and binds the acknowledgement to actor and exact view", async () => {
  const f = await fixture(); const initial = await model(await f.read("/admin?area=me&view=quota", "member-a"));
  const other = await model(await f.read(initial.path, "member-b", initial.revision));
  expect(other.revision).not.toBe(initial.revision);
  const otherView = await model(await f.read("/admin?area=me&view=setup", "member-a", initial.revision));
  expect(otherView.revision).not.toBe(initial.revision);
  f.db.sqlite.prepare("UPDATE organization_surface_credit_defaults SET monthly_allowance=123 WHERE surface_grant='surface:codex:production'").run();
  const changed = await model(await f.read(initial.path, "member-a", initial.revision));
  expect(changed.revision).not.toBe(initial.revision); expect(changed.doc.body.textContent).toContain("123");
});
it.each(["admin-a", "member-a"])("rechecks %s authority after read-model awaits before acknowledging retained private content", async actor => {
  const f = await fixture(); const initial = await model(await f.read(actor === "admin-a" ? "/admin?view=quotas" : "/admin?area=me&view=quota", actor));
  f.duringRead(() => f.db.sqlite.prepare("UPDATE users SET status='disabled' WHERE id=?").run(actor));
  const response = await f.read(initial.path, actor, initial.revision);
  expect(response.status).toBe(403); expect(await response.json()).toMatchObject({error: {code: "console_identity_changed"}});
  expect(response.headers.get("X-Console-Revision")).toBeNull();
});
it("does not acknowledge a former delegated owner or conflate same-label service scopes", async () => {
  const f = await fixture();
  const operator = {kind: "admin_secret" as const, userId: null, email: null, role: null, subject: null, requestId: "setup"};
  const first = await commitServiceAccount(f.env, operator, "Same label", now); const second = await commitServiceAccount(f.env, operator, "Same label", now);
  for (const service of [first, second]) await commitServiceOwner(f.env, operator, service.id, {owner_user_id: "member-a", expected_revision: 0}, now);
  const initial = await model(await f.read(`/me/service-accounts/${first.id}?view=setup`, "member-a"));
  const unchanged = await f.read(initial.path, "member-a", initial.revision); expect(unchanged.status).toBe(204);
  const different = await model(await f.read(`/me/service-accounts/${second.id}?view=setup`, "member-a", initial.revision)); expect(different.revision).not.toBe(initial.revision);
  await commitServiceOwner(f.env, operator, first.id, {owner_user_id: "member-b", expected_revision: 1}, now);
  const denied = await f.read(initial.path, "member-a", initial.revision);
  expect(denied.status).toBe(404); expect(await denied.json()).toMatchObject({error: {code: "service_not_found"}});
});
it("returns fresh HTML for a mismatched revision and required-read failure remains unavailable", async () => {
  const f = await fixture(); const initial = await model(await f.read("/admin?view=quotas"));
  const fresh = await model(await f.read(initial.path, "admin-a", "not-the-current-revision")); expect(fresh.revision).toBe(initial.revision);
  const error = vi.spyOn(console, "error").mockImplementation(() => {}); onTestFinished(() => error.mockRestore());
  f.duringRead(() => {throw new Error("Synthetic unavailable quota read");});
  const failed = await f.read(initial.path, "admin-a", initial.revision);
  expect(failed.status).toBe(503); expect(failed.headers.get("X-Console-Revision")).toBeNull();
  expect(await failed.text()).toContain("data-dashboard-unavailable");
});
it("never turns a creation task into an unchanged acknowledgement", async () => {
  const f = await fixture(); const initial = await model(await f.read("/admin?view=access"));
  const response = await f.read("/admin?view=access&task=add-person", "admin-a", initial.revision);
  expect(response.status).toBe(200);
  const doc = new JSDOM(await response.text()).window.document;
  expect(doc.querySelector("main")?.hasAttribute("data-console-revision")).toBe(false);
});
