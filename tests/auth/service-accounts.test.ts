import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { describe, expect, it } from "vitest";
import { commitServiceAccount, commitServiceName, commitLegacyServiceClassification, normalizeServiceName } from "../../src/auth/service-accounts";
import { commitHumanUser, commitUserEmail, commitUserRole, commitUserStatus, resolveConsolePrincipal, type LifecycleActor } from "../../src/auth/principal";
import { createConsoleSession } from "../../src/auth/console-session";
import { commitIssuedKey } from "../../src/auth/api-keys";
import { listSurfaceCreditStates, consumeSurfaceCredits } from "../../src/auth/credits";
import { createTestD1 } from "../support/sqlite-d1";
import { admin, consoleCookie, createKey, createUser, makeFixture } from "../router/fixture";
import { handleRequest } from "../../src/router";
import { authenticateEndUser } from "../../src/auth/authenticate";

const now = new Date("2026-08-10T00:00:00.000Z");
const at = now.toISOString();
const actor: LifecycleActor = { kind: "admin_secret", email: null, subject: null, userId: null, role: null, requestId: "service-test" };
const environment = (DB: D1Database) => ({ DB, CONSOLE_EMAIL_DOMAIN: "example.com", API_KEY_HASH_PEPPER: "synthetic-pepper" } as Env);
const grant = "surface:codex:production";
const legacy = (id: string) => ({ display_name: id, expected_updated_at: at });
function seedLegacy(db: ReturnType<typeof createTestD1>, id = "legacy") {
  db.sqlite.prepare("INSERT INTO users (id, email, status, created_at, updated_at) VALUES (?, NULL, 'active', ?, ?)").run(id, at, at);
}

it("accepts bounded duplicate service labels and rejects control characters", () => {
  expect(normalizeServiceName("  Nightly build  ")).toBe("Nightly build");
  for (const name of [null, "", " ", "a".repeat(65), "run\njob", "run\u202eexe", "a\u0000b"]) expect(() => normalizeServiceName(name)).toThrow();
});

it("creates explicit Disabled rather than finite zero despite positive defaults and permits later canonical grants", async () => {
  const db = createTestD1(); const env = environment(db.binding);
  try {
    db.sqlite.exec("UPDATE organization_surface_credit_defaults SET monthly_allowance = 100");
    const service = await commitServiceAccount(env, actor, "Same name", now);
    const second = await commitServiceAccount(env, actor, "Same name", now);
    expect(second.id).not.toBe(service.id);
    expect(service).toMatchObject({ account_kind: "service", login_capable: 0, role: "user", email: null });
    expect((await listSurfaceCreditStates(env, now, service.id)).map(row => [row.mode, row.monthly_allowance, row.source])).toEqual(Array(3).fill(["disabled", null, "personal"]));
    expect(db.sqlite.prepare("SELECT * FROM user_surface_credit_policies").all()).toEqual([]);
    await expect(consumeSurfaceCredits(env, { user_id: service.id, surface_grant: grant, credit_charge: 0, plan_id: "test" }, now)).rejects.toMatchObject({ code: "surface_disabled" });
    await expect(commitIssuedKey(env, actor, { user_id: service.id, name: "Blocked", scopes: [grant], expires_at: "2026-12-01T00:00:00.000Z", action: "key.create" }, now)).rejects.toMatchObject({ code: "surface_not_entitled" });
    expect(db.sqlite.prepare("SELECT action, target_id FROM operator_mutation_audit ORDER BY target_id").all()).toHaveLength(2);
  } finally { db.close(); }
});

for (const failure of ["policy", "audit"]) it(`rolls back identity, all policies and audit on ${failure} failure`, async () => {
  const db = createTestD1();
  try {
    db.sqlite.exec(failure === "policy" ? "CREATE TRIGGER inject_failure BEFORE INSERT ON user_surface_credit_modes WHEN NEW.surface_grant = 'surface:grok:production' BEGIN SELECT RAISE(ABORT, 'injected'); END;" : "CREATE TRIGGER inject_failure BEFORE INSERT ON operator_mutation_audit BEGIN SELECT RAISE(ABORT, 'injected'); END;");
    await expect(commitServiceAccount(environment(db.binding), actor, "Never created", now)).rejects.toThrow("injected");
    for (const table of ["users", "user_surface_credit_modes", "operator_mutation_audit"]) expect(db.sqlite.prepare(`SELECT * FROM ${table}`).all()).toEqual([]);
  } finally { db.close(); }
});

it("rejects a stale actor atomically with no dependent policies or success audit", async () => {
  const db = createTestD1(); const env = environment(db.binding);
  try {
    const user = await commitHumanUser(env, actor, "admin@example.com", now);
    await commitUserRole(env, actor, user.id, "admin", now);
    const adminRow = db.sqlite.prepare("SELECT console_session_epoch FROM users WHERE id = ?").get(user.id)!;
    const stale: LifecycleActor = { kind: "access", userId: user.id, email: user.email, subject: null, role: "admin", sessionEpoch: Number(adminRow.console_session_epoch), requestId: "denied-create" };
    db.sqlite.prepare("UPDATE users SET console_session_epoch = console_session_epoch + 1 WHERE id = ?").run(user.id);
    await expect(commitServiceAccount(env, stale, "Never created", now)).rejects.toMatchObject({ code: "admin_required" });
    expect(db.sqlite.prepare("SELECT * FROM users WHERE account_kind = 'service'").all()).toEqual([]);
    expect(db.sqlite.prepare("SELECT * FROM user_surface_credit_modes").all()).toEqual([]);
    expect(db.sqlite.prepare("SELECT * FROM operator_mutation_audit WHERE request_id = 'denied-create'").all()).toEqual([]);
  } finally { db.close(); }
});

it("classification preserves finite, Unlimited, usage, families, material, expiry and sticky bindings exactly", async () => {
  const fixture = makeFixture(); const db = fixture.env.DB;
  const created = await admin(fixture, "https://api.trustedtunnel.app/admin/users", { method: "POST", body: {} });
  const { user } = await created.json() as { user: { id: string } };
  const key = await createKey(fixture, user.id, [grant]);
  await db.prepare("UPDATE api_keys SET name = NULL, expires_at = NULL WHERE id = ?").bind(key.key.id).run();
  await db.prepare("INSERT INTO user_surface_credit_policies VALUES (?, ?, 9, ?, ?)").bind(user.id, grant, at, at).run();
  await db.prepare("INSERT INTO user_surface_credit_modes VALUES (?, 'surface:grok:production', 'unlimited', ?, ?)").bind(user.id, at, at).run();
  await db.prepare("INSERT INTO user_surface_credit_usage VALUES (?, ?, '2026-08-01', 7, 7, ?)").bind(user.id, grant, at).run();
  await db.prepare("INSERT INTO request_audit (id, route_profile_id, user_id, key_id, status, created_at, total_tokens) VALUES ('historical-request','codex.production.responses',?,?,'ok',?,123)").bind(user.id, key.key.id, at).run();
  await db.prepare("INSERT INTO usage_daily (user_id,day,route_profile_id,requests,ok_requests,total_tokens,token_measurements,last_seen_at) VALUES (?,'2026-08-10','codex.production.responses',1,1,123,1,?)").bind(user.id, at).run();
  const inspected = await admin(fixture, `https://api.trustedtunnel.app/admin/users/${user.id}`, { method: "GET" });
  expect(inspected.status).toBe(200);
  expect(await inspected.json()).toMatchObject({ user: { account_kind: "legacy_unresolved", login_capable: 0, email: null } });
  const tables = ["request_audit", "usage_daily", "api_keys", "api_key_surface_credentials", "user_surface_credit_policies", "user_surface_credit_modes", "user_surface_credit_usage"];
  const before = await Promise.all(tables.map(async table => (await db.prepare(`SELECT * FROM ${table}`).all()).results));
  const target = (await db.prepare("SELECT updated_at FROM users WHERE id = ?").bind(user.id).first<{ updated_at: string }>())!;
  const classified = await commitLegacyServiceClassification(fixture.env, actor, user.id, { display_name: "Old project", expected_updated_at: String(target.updated_at) }, now);
  expect(classified).toMatchObject({ id: user.id, status: "active", account_kind: "service", display_name: "Old project" });
  expect(await Promise.all(tables.map(async table => (await db.prepare(`SELECT * FROM ${table}`).all()).results))).toEqual(before);
  await commitServiceName(fixture.env, actor, user.id, "Renamed project", now);
  expect(await Promise.all(tables.map(async table => (await db.prepare(`SELECT * FROM ${table}`).all()).results))).toEqual(before);
  expect((await db.prepare("SELECT action FROM operator_mutation_audit WHERE target_id = ? AND action LIKE 'service.%' ORDER BY rowid").bind(user.id).all()).results).toEqual([{ action: "service.classify" }, { action: "service.rename" }]);
});

it("rejects human conversion, service login/promotion/email/session attempts and protects the last human admin", async () => {
  const db = createTestD1(); const env = environment(db.binding);
  try {
    const human = await resolveConsolePrincipal(env, "admin@example.com", now);
    await commitUserRole(env, actor, human.id, "admin", now);
    const service = await commitServiceAccount(env, actor, "Robot", now);
    await expect(commitLegacyServiceClassification(env, actor, human.id, legacy("Robot"), now)).rejects.toMatchObject({ code: "service_identity_changed" });
    await expect(commitUserRole(env, actor, service.id, "admin", now)).rejects.toMatchObject({ code: "human_identity_required" });
    await expect(commitUserEmail(env, actor, service.id, "robot@example.com", now)).rejects.toMatchObject({ code: "human_identity_required" });
    await expect(createConsoleSession(env, { id: service.id, email: "robot@example.com", sessionEpoch: 0 }, now)).rejects.toMatchObject({ code: "console_identity_changed" });
    expect(() => db.sqlite.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(service.id)).toThrow("invalid_service_identity");
    expect(() => db.sqlite.prepare("UPDATE users SET email = 'robot@example.com', canonical_email = 'robot@example.com', login_capable = 1 WHERE id = ?").run(service.id)).toThrow("invalid_service_identity");
    await expect(commitUserStatus(env, actor, human.id, "disabled", now)).rejects.toMatchObject({ code: "last_active_admin" });
    await expect(commitUserRole(env, actor, human.id, "user", now)).rejects.toMatchObject({ code: "last_active_admin" });
    // A similarly named verified mailbox is a new human, never the service ID.
    expect((await resolveConsolePrincipal(env, "robot@example.com", now)).id).not.toBe(service.id);
  } finally { db.close(); }
});

it("rejects stale reviews and source drift at classification commit, without a false success audit", async () => {
  let changed = false;
  const db = createTestD1({ onBatch: () => {
    if (changed) return;
    changed = true;
    db.sqlite.exec("UPDATE users SET status = 'disabled' WHERE id = 'legacy'");
  } }); const env = environment(db.binding);
  try {
    seedLegacy(db);
    await expect(commitLegacyServiceClassification(env, actor, "legacy", { ...legacy("Robot"), expected_updated_at: "old" }, now)).rejects.toMatchObject({ code: "service_identity_changed" });
    await expect(commitLegacyServiceClassification(env, actor, "legacy", legacy("Robot"), now)).rejects.toMatchObject({ code: "service_identity_changed" });
    expect(db.sqlite.prepare("SELECT account_kind, status FROM users").get()).toEqual({ account_kind: "legacy_unresolved", status: "disabled" });
    expect(db.sqlite.prepare("SELECT * FROM operator_mutation_audit").all()).toEqual([]);
    db.sqlite.exec("CREATE TRIGGER fail_audit BEFORE INSERT ON operator_mutation_audit BEGIN SELECT RAISE(ABORT, 'injected'); END;");
    await expect(commitLegacyServiceClassification(env, actor, "legacy", legacy("Robot"), now)).rejects.toThrow("injected");
    expect(db.sqlite.prepare("SELECT account_kind, display_name FROM users").get()).toEqual({ account_kind: "legacy_unresolved", display_name: null });
  } finally { db.close(); }
});

it("concurrent issuance sees either no identity or a fully Disabled service, never positive inherited defaults", async () => {
  const directory = mkdtempSync(join(tmpdir(), "mini-service-race-"));
  const file = join(directory, "db.sqlite"); const hold = join(directory, "held");
  const db = createTestD1({ file }); db.sqlite.exec("UPDATE organization_surface_credit_defaults SET monthly_allowance = 100");
  const worker = new Worker(new URL("./service-account-race-worker.ts", import.meta.url), { execArgv: ["--import", "tsx"], workerData: { file, hold } });
  const completed = new Promise<{ ok: boolean; id: string }>((resolve, reject) => { worker.once("message", resolve); worker.once("error", reject); });
  try {
    const deadline = Date.now() + 8_000;
    while (!existsSync(hold) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    expect(existsSync(hold)).toBe(true);
    const id = readFileSync(hold, "utf8");
    expect(db.sqlite.prepare("SELECT id FROM users WHERE id = ?").get(id)).toBeUndefined();
    await expect(commitIssuedKey(environment(db.binding), actor, { user_id: id, name: "Concurrent", scopes: [grant], expires_at: "2027-01-01T00:00:00.000Z", action: "key.create" }, now)).rejects.toMatchObject({ code: "user_not_found" });
    worker.postMessage("release");
    const created = await completed; expect(created).toMatchObject({ ok: true, id });
    await expect(commitIssuedKey(environment(db.binding), actor, { user_id: id, name: "After", scopes: [grant], expires_at: "2027-01-01T00:00:00.000Z", action: "key.create" }, now)).rejects.toMatchObject({ code: "surface_not_entitled" });
    expect(db.sqlite.prepare("SELECT * FROM api_keys").all()).toEqual([]);
    expect(db.sqlite.prepare("SELECT mode FROM user_surface_credit_modes WHERE user_id = ?").all(id)).toEqual(Array(3).fill({ mode: "disabled" }));
  } finally { await worker.terminate(); db.close(); rmSync(directory, { recursive: true, force: true }); }
}, 15_000);

describe("service HTTP and existing account resources", () => {
  it("enforces admin/browser guards, exact targets, canonical policy grants, independent families/usage and disable/re-enable", async () => {
    const fixture = makeFixture();
    const db = fixture.env.DB;
    const person = await createUser(fixture, "admin@example.com");
    await admin(fixture, `https://api.trustedtunnel.app/admin/users/${person.user.id}/role`, { method: "POST", body: { role: "admin" } });
    const cookie = await consoleCookie(fixture, "admin@example.com");
    const call = (path: string, origin: string | null, body: unknown) => handleRequest(new Request(`https://admin.example.test${path}`, { method: "POST", headers: { Cookie: `__Host-mini-console=${cookie}`, ...(origin ? { Origin: origin } : {}), "Content-Type": "application/json" }, body: JSON.stringify(body) }), fixture.env, fixture.ctx, fixture.deps);
    for (const host of ["api.trustedtunnel.app", "admin.example.test"]) {
      const inspected = await handleRequest(new Request(`https://${host}/admin/users/${person.user.id}`, { headers: { Cookie: `__Host-mini-console=${cookie}` } }), fixture.env, fixture.ctx, fixture.deps);
      expect(inspected.status).toBe(host === "api.trustedtunnel.app" ? 403 : 404);
    }
    const beforeLegacyAttempt = (await db.prepare("SELECT COUNT(*) AS count FROM users").first<{ count: number }>())!.count;
    expect((await call("/admin/users", "https://admin.example.test", { id: "forbidden-legacy", email: null })).status).toBe(404);
    expect((await db.prepare("SELECT COUNT(*) AS count FROM users").first<{ count: number }>())!.count).toBe(beforeLegacyAttempt);
    const protectedLegacy = await admin(fixture, "https://api.trustedtunnel.app/admin/users", { method: "POST", body: { id: "operator-legacy", email: null } });
    expect(protectedLegacy.status).toBe(201);
    expect(await protectedLegacy.json()).toMatchObject({ user: { id: "operator-legacy", account_kind: "legacy_unresolved", login_capable: 0 } });
    for (const origin of [null, "https://foreign.test"]) expect((await call("/admin/ui/services", origin, { display_name: "Robot" })).status).toBe(403);
    const response = await call("/admin/ui/services", "https://admin.example.test", { display_name: "Robot" });
    expect(response.status).toBe(201);
    const { user: service } = await response.json() as { user: { id: string } };
    const grantResponse = await admin(fixture, `https://api.trustedtunnel.app/admin/users/${service.id}/credits/codex`, { method: "PUT", body: { monthly_allowance: 10 } });
    expect(grantResponse.status).toBe(200);
    const first = await createKey(fixture, service.id, [grant]); const second = await createKey(fixture, service.id, [grant]);
    const other = await createKey(fixture, person.user.id, [grant]);
    expect((await db.prepare("SELECT DISTINCT family_id FROM api_keys WHERE user_id = ?").bind(service.id).all()).results).toHaveLength(2);
    const request = (token: string) => new Request("https://api.trustedtunnel.app/v1/models", { headers: { Authorization: `Bearer ${token}` } });
    const authenticate = (token: string) => authenticateEndUser(request(token), fixture.env, fixture.ctx, { requiredSurfaceGrant: grant }, fixture.deps.now());
    expect((await authenticate(first.api_key)).user.id).toBe(service.id);
    await consumeSurfaceCredits(fixture.env, { user_id: service.id, surface_grant: grant, credit_charge: 3, plan_id: "test" }, fixture.deps.now());
    expect((await listSurfaceCreditStates(fixture.env, fixture.deps.now(), service.id))[0]?.consumed_credits).toBe(3);
    expect((await listSurfaceCreditStates(fixture.env, fixture.deps.now(), person.user.id))[0]?.consumed_credits).toBe(0);
    expect((await admin(fixture, `https://api.trustedtunnel.app/admin/keys/${first.key.id}`, { method: "DELETE" })).status).toBe(200);
    await commitUserStatus(fixture.env, actor, service.id, "disabled", fixture.deps.now());
    await expect(authenticate(second.api_key)).rejects.toMatchObject({ code: "user_inactive" });
    expect((await authenticate(other.api_key)).user.id).toBe(person.user.id);
    await commitUserStatus(fixture.env, actor, service.id, "active", fixture.deps.now());
    expect((await authenticate(second.api_key)).user.id).toBe(service.id);
    await expect(authenticate(first.api_key)).rejects.toMatchObject({ code: "invalid_api_key" });
    expect((await listSurfaceCreditStates(fixture.env, fixture.deps.now(), service.id))[0]?.consumed_credits).toBe(3);
    const detail = await admin(fixture, `https://api.trustedtunnel.app/admin/services/${service.id}`, { method: "GET" });
    const text = await detail.text(); expect(text).toContain('"account_kind":"service"'); expect(text).not.toContain("key_hash"); expect(text).not.toContain(first.api_key);
  });
});

for (const drift of ["demotion", "epoch", "mailbox", "disabled"] as const) it(`credit mutation rejects ${drift} at the SQL commit and retains the prior policy`, async () => {
  let inject = false;
  const db = createTestD1({ onBatch: () => {
    if (!inject) return;
    inject = false;
    const sql = drift === "demotion" ? "role = 'user'" : drift === "epoch" ? "console_session_epoch = console_session_epoch + 1" : drift === "mailbox" ? "email = 'changed@example.com', canonical_email = 'changed@example.com'" : "status = 'disabled'";
    db.sqlite.exec(`UPDATE users SET ${sql} WHERE id = 'actor'`);
  } });
  const env = environment(db.binding);
  try {
    db.sqlite.exec("INSERT INTO users (id,email,canonical_email,login_capable,account_kind,role,status,created_at,updated_at) VALUES ('actor','admin@example.com','admin@example.com',1,'human','admin','active','t','t')");
    const service = await commitServiceAccount(env, actor, "Robot", now);
    const consoleActor: LifecycleActor = { kind: "access", userId: "actor", email: "admin@example.com", subject: null, role: "admin", sessionEpoch: 0, requestId: "denied-policy" };
    const before = db.sqlite.prepare("SELECT * FROM user_surface_credit_modes").all();
    inject = true;
    const { commitPersonalCreditPolicy } = await import("../../src/auth/credits");
    await expect(commitPersonalCreditPolicy(env, consoleActor, { user_id: service.id, surface_grant: grant, mode: "limited", monthly_allowance: 10, previous_monthly_allowance: null }, now)).rejects.toMatchObject({ code: "admin_required" });
    expect(db.sqlite.prepare("SELECT * FROM user_surface_credit_modes").all()).toEqual(before);
    expect(db.sqlite.prepare("SELECT * FROM user_surface_credit_policies").all()).toEqual([]);
    expect(db.sqlite.prepare("SELECT * FROM operator_mutation_audit WHERE request_id = 'denied-policy'").all()).toEqual([]);
  } finally { db.close(); }
});

it("canonical credit replacement rolls back both tables when audit fails", async () => {
  const db = createTestD1(); const env = environment(db.binding);
  try {
    const service = await commitServiceAccount(env, actor, "Robot", now);
    const before = db.sqlite.prepare("SELECT * FROM user_surface_credit_modes").all();
    db.sqlite.exec("CREATE TRIGGER fail_credit_audit BEFORE INSERT ON operator_mutation_audit WHEN NEW.action = 'credit_policy.set' BEGIN SELECT RAISE(ABORT, 'injected-credit'); END;");
    const { commitPersonalCreditPolicy } = await import("../../src/auth/credits");
    await expect(commitPersonalCreditPolicy(env, actor, { user_id: service.id, surface_grant: grant, mode: "limited", monthly_allowance: 10, previous_monthly_allowance: null }, now)).rejects.toThrow("injected-credit");
    expect(db.sqlite.prepare("SELECT * FROM user_surface_credit_modes").all()).toEqual(before);
    expect(db.sqlite.prepare("SELECT * FROM user_surface_credit_policies").all()).toEqual([]);
  } finally { db.close(); }
});

it("does not report a rejected policy as success if the actor regains admin before the diagnostic read", async () => {
  let drift = false;
  let restore = false;
  const db = createTestD1({ onBatch: () => {
    if (!drift) return;
    drift = false; restore = true;
    db.sqlite.exec("UPDATE users SET role = 'user' WHERE id = 'actor'");
  }, onPrepare: sql => {
    if (restore && sql.startsWith("SELECT account_kind, canonical_email")) {
      restore = false;
      db.sqlite.exec("UPDATE users SET role = 'admin' WHERE id = 'actor'");
    }
  } });
  const env = environment(db.binding);
  try {
    db.sqlite.exec("INSERT INTO users (id,email,canonical_email,login_capable,account_kind,role,status,created_at,updated_at) VALUES ('actor','admin@example.com','admin@example.com',1,'human','admin','active','t','t')");
    const service = await commitServiceAccount(env, actor, "Robot", now);
    const consoleActor: LifecycleActor = { kind: "access", userId: "actor", email: "admin@example.com", subject: null, role: "admin", sessionEpoch: 0, requestId: "restored-admin" };
    drift = true;
    const { commitPersonalCreditPolicy } = await import("../../src/auth/credits");
    await expect(commitPersonalCreditPolicy(env, consoleActor, { user_id: service.id, surface_grant: grant, mode: "limited", monthly_allowance: 10, previous_monthly_allowance: null }, now)).rejects.toMatchObject({ code: "credit_policy_rejected" });
    expect(db.sqlite.prepare("SELECT * FROM user_surface_credit_policies").all()).toEqual([]);
    expect(db.sqlite.prepare("SELECT * FROM operator_mutation_audit WHERE request_id = 'restored-admin'").all()).toEqual([]);
  } finally { db.close(); }
});
