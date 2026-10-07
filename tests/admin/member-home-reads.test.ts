import { JSDOM } from "jsdom";
import { describe, expect, it, onTestFinished } from "vitest";
import { commitServiceAccount } from "../../src/auth/service-accounts";
import { commitServiceOwner } from "../../src/auth/service-delegation";
import { handleRequest } from "../../src/router";
import { consoleCookie, createUser, makeFixture } from "../router/fixture";
import { createTestD1 } from "../support/sqlite-d1";

const origin = "https://admin.example.test";
const operator = {kind: "admin_secret" as const, userId: null, email: null, role: null, subject: null, requestId: "setup"};

async function homeFixture(options: Parameters<typeof createTestD1>[0] = {}) {
  const db = createTestD1(options);
  onTestFinished(() => db.close());
  const fixture = makeFixture({env: {DB: db.binding}});
  const owner = await createUser(fixture, "home-owner@example.com");
  const foreign = await createUser(fixture, "foreign-home@example.com");
  const cookie = await consoleCookie(fixture, "home-owner@example.com");
  const at = fixture.deps.now().toISOString();
  const insertKey = db.sqlite.prepare(`INSERT INTO api_keys
    (id,user_id,key_prefix,key_hash,status,scopes,name,family_id,created_at)
    VALUES (?,?,?,?,'active','["surface:codex:production"]',?,?,?)`);
  insertKey.run("home-key", owner.user.id, "display-home", "invalid-home-hash", "Personal desk", "family:home", at);
  insertKey.run("foreign-key", foreign.user.id, "display-foreign", "invalid-foreign-hash", "Foreign-only key", "family:foreign", at);
  db.sqlite.prepare(`INSERT INTO user_surface_credit_policies
    (user_id,surface_grant,monthly_allowance,created_at,updated_at)
    VALUES (?,'surface:codex:production',40,?,?)`).run(owner.user.id, at, at);
  db.sqlite.prepare(`INSERT INTO user_surface_credit_usage
    (user_id,surface_grant,period_start,consumed_credits,admitted_attempts,last_seen_at)
    VALUES (?,'surface:codex:production','2026-06-01',9,1,?)`).run(owner.user.id, at);
  db.sqlite.prepare(`INSERT INTO request_audit
    (id,request_id,route_profile_id,user_id,key_id,status,upstream_status,created_at)
    VALUES ('home-task','home-correlation','codex.responses',?,'home-key','ok',200,?)`).run(owner.user.id, at);
  const open = (path = "/admin?area=me&view=home") => handleRequest(new Request(origin + path, {
    headers: {Cookie: `__Host-mini-console=${cookie}`, Accept: "text/html"}
  }), fixture.env, fixture.ctx, fixture.deps);
  return {db, fixture, owner, open};
}

describe("independent member Home reads", () => {
  it("keeps known personal keys, quota and task results when the delegated inventory SQL read fails", async () => {
    const {db, open} = await homeFixture();
    db.sqlite.exec("DROP TABLE service_account_owners");
    const response = await open();
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const html = await response.text();
    const doc = new JSDOM(html).window.document;
    const personal = doc.querySelector('[data-member-home="true"]')!;
    expect(personal).not.toBeNull();
    expect(personal.querySelector('[data-surface="codex"]')?.textContent).toContain("9 / 40");
    expect(personal.querySelector('a[href="/admin?area=me&view=keys&key=home-key"]')?.textContent).toContain("Personal desk");
    expect(personal.querySelector('[data-surface="codex"] time[datetime="2026-06-24T00:00:00.000Z"]')).not.toBeNull();
    const unavailable = doc.querySelector('[data-delegated-read-state="unknown"]')!;
    expect(unavailable.getAttribute("role")).toBe("alert");
    expect(unavailable.querySelector("a")?.getAttribute("href")).toBe("/admin?area=me&view=home");
    expect(doc.querySelector('main')?.getAttribute('data-console-read-url')).toBe('/admin?area=me&view=home');
    expect(html).not.toContain("Foreign-only key");
    expect(html).not.toContain("invalid-home-hash");
  });

  it("hides a verified-empty delegated inventory while preserving personal Home", async () => {
    const {open} = await homeFixture();
    const response = await open();
    expect(response.status).toBe(200);
    const doc = new JSDOM(await response.text()).window.document;
    expect(doc.querySelector('[data-member-home="true"]')).not.toBeNull();
    expect(doc.querySelector('.member-delegated-services')).toBeNull();
    expect(doc.querySelector('[data-delegated-read-state="unknown"]')).toBeNull();
  });

  it("identifies same-name services, skips delegated inventory in their Home and rejects withdrawn assignments", async () => {
    let rejectInventory = false;
    const {db, fixture, owner, open} = await homeFixture({onPrepare: sql => {
      if (rejectInventory && /FROM service_account_owners AS d\b/.test(sql)) throw new Error("Delegated inventory unavailable");
    }});
    const service = await commitServiceAccount(fixture.env, operator, "Scoped automation", fixture.deps.now());
    const sameName = await commitServiceAccount(fixture.env, operator, "Scoped automation", fixture.deps.now());
    await commitServiceOwner(fixture.env, operator, service.id, {owner_user_id: owner.user.id, expected_revision: 0}, fixture.deps.now());
    await commitServiceOwner(fixture.env, operator, sameName.id, {owner_user_id: owner.user.id, expected_revision: 0}, fixture.deps.now());
    const personal = await open();
    expect(personal.status).toBe(200);
    const personalDoc = new JSDOM(await personal.text()).window.document;
    for (const assigned of [service, sameName]) {
      const link = personalDoc.querySelector(`.member-delegated-services a[href="/me/service-accounts/${assigned.id}?view=home"]`)!;
      expect(link.textContent).toContain("Scoped automation");
      expect(link.querySelector("code")?.textContent).toBe(assigned.id);
    }
    rejectInventory = true;
    const path = `/me/service-accounts/${service.id}?view=home`;
    const response = await open(path);
    expect(response.status).toBe(200);
    const doc = new JSDOM(await response.text()).window.document;
    expect(doc.querySelector('[data-service-id]')?.getAttribute('data-service-id')).toBe(service.id);
    expect(doc.querySelector('[aria-label="当前服务账号"] code')?.textContent).toBe(service.id);
    expect(doc.querySelector('[aria-label="当前服务账号"]')?.textContent).not.toContain(sameName.id);
    expect(doc.querySelector('[data-member-home="true"]')).not.toBeNull();
    expect(doc.querySelector('.member-delegated-services')).toBeNull();
    expect(doc.querySelector('[data-delegated-read-state="unknown"]')).toBeNull();
    expect(doc.querySelector('a[href="/admin?area=me&view=keys&key=home-key"]')).toBeNull();
    db.sqlite.prepare("DELETE FROM service_account_owners WHERE service_user_id = ?").run(service.id);
    expect((await open(path)).status).toBe(404);
  });
});
