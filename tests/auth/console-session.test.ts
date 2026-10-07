import { expect, it } from "vitest";
import { createConsoleSession } from "../../src/auth/console-session";
import { verifyConsoleAccess } from "../../src/auth/authenticate";
import { commitHumanUser, commitUserEmail, commitUserRole, commitUserStatus, resolveConsolePrincipal, type LifecycleActor } from "../../src/auth/principal";
import { createTestD1 } from "../support/sqlite-d1";

const now = new Date("2026-10-02T12:00:00.000Z");
const actor: LifecycleActor = { kind: "admin_secret", email: null, subject: null, userId: null, role: null, requestId: "session-boundary" };
const request = (token: string) => new Request("https://admin.example.test/me", { headers: { Cookie: `__Host-mini-console=${token}` } });

it("invalidates existing browser sessions on mailbox migration without relinking the user", async () => {
  const db = createTestD1();
  const env = { DB: db.binding, API_KEY_HASH_PEPPER: "synthetic-session-pepper", CONSOLE_EMAIL_DOMAIN: "example.com" } as Env;
  try {
    const principal = await resolveConsolePrincipal(env, "before@example.com", now);
    const token = await createConsoleSession(env, principal, now);
    await commitUserEmail(env, actor, principal.id, "after@example.com", now);
    expect(await verifyConsoleAccess(request(token), env, now)).toBeNull();
    expect((await resolveConsolePrincipal(env, "after@example.com", now)).id).toBe(principal.id);
  } finally { db.close(); }
});

it("rejects a login resolved before a concurrent mailbox migration at the session insertion boundary", async () => {
  const db = createTestD1();
  const env = { DB: db.binding, API_KEY_HASH_PEPPER: "synthetic-session-pepper", CONSOLE_EMAIL_DOMAIN: "example.com" } as Env;
  try {
    const pendingLogin = await resolveConsolePrincipal(env, "before@example.com", now);
    await commitUserEmail(env, actor, pendingLogin.id, "after@example.com", now);
    await expect(createConsoleSession(env, pendingLogin, now)).rejects.toMatchObject({ code: "console_identity_changed" });
  } finally { db.close(); }
});

it("never revives a pending login across disable and re-enable", async () => {
  const db = createTestD1();
  const env = { DB: db.binding, API_KEY_HASH_PEPPER: "synthetic-session-pepper", CONSOLE_EMAIL_DOMAIN: "example.com" } as Env;
  try {
    const pendingLogin = await resolveConsolePrincipal(env, "before@example.com", now);
    await commitUserStatus(env, actor, pendingLogin.id, "disabled", now);
    await commitUserStatus(env, actor, pendingLogin.id, "active", now);
    await expect(createConsoleSession(env, pendingLogin, now)).rejects.toMatchObject({ code: "console_identity_changed" });
  } finally { db.close(); }
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

for (const transition of ["email", "email-aba", "disable-enable"] as const) {
  it(`rejects an already-started session insertion after ${transition}`, async () => {
    const entered = deferred(); const release = deferred();
    const db = createTestD1({ beforeRun: async sql => {
      if (sql.startsWith("INSERT INTO console_sessions")) { entered.resolve(); await release.promise; }
    } });
    const env = { DB: db.binding, API_KEY_HASH_PEPPER: "synthetic-session-pepper", CONSOLE_EMAIL_DOMAIN: "example.com" } as Env;
    try {
      const principal = await resolveConsolePrincipal(env, "before@example.com", now);
      const pending = createConsoleSession(env, principal, now).then(() => "issued", error => error.code as string);
      await entered.promise;
      if (transition === "disable-enable") {
        await commitUserStatus(env, actor, principal.id, "disabled", now);
        await commitUserStatus(env, actor, principal.id, "active", now);
      } else {
        await commitUserEmail(env, actor, principal.id, "after@example.com", now);
        if (transition === "email-aba") await commitUserEmail(env, actor, principal.id, "before@example.com", now);
      }
      release.resolve();
      expect(await pending).toBe("console_identity_changed");
      expect(db.sqlite.prepare("SELECT COUNT(*) AS count FROM console_sessions").get()).toEqual({ count: 0 });
    } finally { release.resolve(); db.close(); }
  });
}

it("keeps invalidated cookies invalid after re-enable and accepts only a newly resolved login", async () => {
  const db = createTestD1();
  const env = { DB: db.binding, API_KEY_HASH_PEPPER: "synthetic-session-pepper", CONSOLE_EMAIL_DOMAIN: "example.com" } as Env;
  try {
    const principal = await resolveConsolePrincipal(env, "before@example.com", now);
    const token = await createConsoleSession(env, principal, now);
    await commitUserStatus(env, actor, principal.id, "disabled", now);
    expect(await verifyConsoleAccess(request(token), env, now)).toBeNull();
    await commitUserStatus(env, actor, principal.id, "active", now);
    expect(await verifyConsoleAccess(request(token), env, now)).toBeNull();
    const current = await resolveConsolePrincipal(env, "before@example.com", now);
    const fresh = await createConsoleSession(env, current, now);
    expect((await verifyConsoleAccess(request(fresh), env, now))?.id).toBe(principal.id);
    expect(await verifyConsoleAccess(request(fresh), env, new Date(now.getTime() + 8 * 60 * 60 * 1000))).toBeNull();
  } finally { db.close(); }
});

for (const transition of ["email", "disable"] as const) {
  it(`rolls back ${transition} and epoch invalidation when success audit aborts`, async () => {
    const db = createTestD1();
    const env = { DB: db.binding, API_KEY_HASH_PEPPER: "synthetic-session-pepper", CONSOLE_EMAIL_DOMAIN: "example.com" } as Env;
    try {
      const principal = await resolveConsolePrincipal(env, "before@example.com", now);
      const token = await createConsoleSession(env, principal, now);
      db.sqlite.exec("CREATE TRIGGER reject_lifecycle_audit BEFORE INSERT ON operator_mutation_audit WHEN NEW.action IN ('user.email', 'user.disable') BEGIN SELECT RAISE(ABORT, 'synthetic audit abort'); END;");
      const change = transition === "email" ? commitUserEmail(env, actor, principal.id, "after@example.com", now) : commitUserStatus(env, actor, principal.id, "disabled", now);
      await expect(change).rejects.toThrow("synthetic audit abort");
      expect(await verifyConsoleAccess(request(token), env, now)).toEqual(principal);
      expect(db.sqlite.prepare("SELECT canonical_email, status, console_session_epoch FROM users WHERE id = ?").get(principal.id)).toEqual({ canonical_email: "before@example.com", status: "active", console_session_epoch: 0 });
      expect(db.sqlite.prepare("SELECT COUNT(*) AS count FROM operator_mutation_audit WHERE action IN ('user.email', 'user.disable')").get()).toEqual({ count: 0 });
    } finally { db.close(); }
  });
}

it("rejects a concurrent stale rename without recording a false previous email", async () => {
  const db = createTestD1(); const entered = deferred(); const release = deferred();
  const env = { DB: db.binding, API_KEY_HASH_PEPPER: "synthetic-session-pepper", CONSOLE_EMAIL_DOMAIN: "example.com" } as Env;
  try {
    const principal = await resolveConsolePrincipal(env, "before@example.com", now);
    // Pause exactly after the first command captured its target snapshot, outside
    // the transaction, while the competing command uses the real SQL connection.
    let held = false;
    const delayed = { ...env, DB: new Proxy(db.binding, { get(target, prop) {
      if (prop !== "prepare") { const value = Reflect.get(target, prop); return typeof value === "function" ? value.bind(target) : value; }
      return (sql: string) => {
        const statement = target.prepare(sql);
        if (held || !sql.includes("FROM users WHERE id = ?")) return statement;
        return new Proxy(statement, { get(stmt, method) {
          if (method === "bind") return (...values: unknown[]) => { stmt.bind(...values); return new Proxy(stmt, { get(bound, name) {
            if (name === "first") return async () => { const row = await bound.first(); held = true; entered.resolve(); await release.promise; return row; };
            const value = Reflect.get(bound, name); return typeof value === "function" ? value.bind(bound) : value;
          } }); };
          const value = Reflect.get(stmt, method); return typeof value === "function" ? value.bind(stmt) : value;
        } });
      };
    } }) } as Env;
    const pending = commitUserEmail(delayed, actor, principal.id, "stale@example.com", now).then(() => "committed", error => error.code as string);
    await entered.promise;
    await commitUserEmail(env, actor, principal.id, "winner@example.com", now);
    release.resolve();
    expect(await pending).toBe("lifecycle_rejected");
    const audits = db.sqlite.prepare("SELECT meta FROM operator_mutation_audit WHERE action = 'user.email'").all() as { meta: string }[];
    expect(audits.map(row => JSON.parse(row.meta))).toEqual([{ previous_email: "before@example.com", email: "winner@example.com" }]);
    expect((await resolveConsolePrincipal(env, "winner@example.com", now)).sessionEpoch).toBe(1);
  } finally { release.resolve(); db.close(); }
});

for (const action of ["role", "status"] as const) {
  it(`does not count an off-domain or non-login legacy admin for last-admin ${action}`, async () => {
    const db = createTestD1();
    const env = { DB: db.binding, API_KEY_HASH_PEPPER: "synthetic-session-pepper", CONSOLE_EMAIL_DOMAIN: "example.com" } as Env;
    try {
      const admin = await resolveConsolePrincipal(env, "admin@example.com", now);
      db.sqlite.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(admin.id);
      db.sqlite.exec("INSERT INTO users (id,email,canonical_email,role,status,login_capable,account_kind,created_at,updated_at) VALUES ('outside','outside@other.test','outside@other.test','admin','active',1,'human','t','t'), ('legacy',NULL,NULL,'admin','active',0,'legacy_unresolved','t','t')");
      const change = action === "role" ? commitUserRole(env, actor, admin.id, "user", now) : commitUserStatus(env, actor, admin.id, "disabled", now);
      await expect(change).rejects.toMatchObject({ code: "last_active_admin" });
      expect(db.sqlite.prepare("SELECT role,status,console_session_epoch FROM users WHERE id = ?").get(admin.id)).toEqual({ role: "admin", status: "active", console_session_epoch: 0 });
    } finally { db.close(); }
  });
}

it("rejects old actor authority after email migration or disable-enable at lifecycle commit", async () => {
  const db = createTestD1();
  const env = { DB: db.binding, API_KEY_HASH_PEPPER: "synthetic-session-pepper", CONSOLE_EMAIL_DOMAIN: "example.com" } as Env;
  try {
    const admin = await resolveConsolePrincipal(env, "admin@example.com", now);
    const other = await resolveConsolePrincipal(env, "other@example.com", now);
    const target = await resolveConsolePrincipal(env, "target@example.com", now);
    db.sqlite.prepare("UPDATE users SET role = 'admin' WHERE id IN (?, ?)").run(admin.id, other.id);
    const staleActor: LifecycleActor = { kind: "access", email: admin.email, subject: null, userId: admin.id, role: "admin", sessionEpoch: admin.sessionEpoch, requestId: "stale-actor" };
    await commitUserStatus(env, actor, admin.id, "disabled", now);
    await commitUserStatus(env, actor, admin.id, "active", now);
    await expect(commitUserEmail(env, staleActor, target.id, "new@example.com", now)).rejects.toMatchObject({ code: "admin_required" });
    await expect(commitHumanUser(env, staleActor, "created@example.com", now)).rejects.toMatchObject({ code: "admin_required" });
    expect(db.sqlite.prepare("SELECT COUNT(*) AS count FROM operator_mutation_audit WHERE request_id = 'stale-actor'").get()).toEqual({ count: 0 });
  } finally { db.close(); }
});

it("domain or collision rejection preserves the old session and produces no success audit", async () => {
  const db = createTestD1();
  const env = { DB: db.binding, API_KEY_HASH_PEPPER: "synthetic-session-pepper", CONSOLE_EMAIL_DOMAIN: "example.com" } as Env;
  try {
    const principal = await resolveConsolePrincipal(env, "before@example.com", now);
    await resolveConsolePrincipal(env, "occupied@example.com", now);
    const token = await createConsoleSession(env, principal, now);
    await expect(commitUserEmail(env, actor, principal.id, "outside@other.test", now)).rejects.toMatchObject({ code: "invalid_email_domain" });
    await expect(commitUserEmail(env, actor, principal.id, "occupied@example.com", now)).rejects.toMatchObject({ code: "email_conflict" });
    expect(await verifyConsoleAccess(request(token), env, now)).toEqual(principal);
    expect(db.sqlite.prepare("SELECT COUNT(*) AS count FROM operator_mutation_audit WHERE action = 'user.email'").get()).toEqual({ count: 0 });
  } finally { db.close(); }
});

it("classifies an unresolved legacy collision even when the target already has that canonical mailbox", async () => {
  const db = createTestD1();
  const env = { DB: db.binding, CONSOLE_EMAIL_DOMAIN: "example.com" } as Env;
  try {
    db.sqlite.exec("INSERT INTO users (id,email,canonical_email,role,status,login_capable,created_at,updated_at) VALUES ('legacy-a','same@example.com','same@example.com','user','active',0,'t','t'), ('legacy-b','SAME@example.com','same@example.com','user','active',0,'t','t')");
    await expect(commitUserEmail(env, actor, "legacy-a", "same@example.com", now)).rejects.toMatchObject({ code: "email_conflict" });
    expect(db.sqlite.prepare("SELECT id,login_capable,console_session_epoch FROM users ORDER BY id").all()).toEqual([
      { id: "legacy-a", login_capable: 0, console_session_epoch: 0 }, { id: "legacy-b", login_capable: 0, console_session_epoch: 0 }
    ]);
    expect(db.sqlite.prepare("SELECT COUNT(*) AS count FROM operator_mutation_audit").get()).toEqual({ count: 0 });
  } finally { db.close(); }
});

it.each(["bad\u0001@example.com", "bad\u00a0@example.com", "Äda@example.com"])("does not count a malformed or noncanonical mailbox as administrator authority: %j", async badEmail => {
  const db = createTestD1();
  const env = { DB: db.binding, API_KEY_HASH_PEPPER: "synthetic-session-pepper", CONSOLE_EMAIL_DOMAIN: "example.com" } as Env;
  try {
    db.sqlite.prepare("INSERT INTO users (id,email,canonical_email,status,login_capable,account_kind,created_at,updated_at) VALUES ('invalid',?,?,'active',1,'human','t','t'),('real','real@example.com','real@example.com','active',1,'human','t','t')").run(badEmail, badEmail);
    db.sqlite.exec("UPDATE users SET role = 'admin'");
    await expect(commitUserRole(env, actor, "real", "user", now)).rejects.toMatchObject({ code: "last_active_admin" });
    await expect(commitUserStatus(env, actor, "real", "disabled", now)).rejects.toMatchObject({ code: "last_active_admin" });
    expect(db.sqlite.prepare("SELECT status, role, console_session_epoch FROM users WHERE id = 'real'").get()).toEqual({ status: "active", role: "admin", console_session_epoch: 0 });
    const { isOrganizationLoginUser } = await import("../../src/auth/principal");
    expect(isOrganizationLoginUser(env, { canonical_email: badEmail, login_capable: 1 })).toBe(false);
    expect(db.sqlite.prepare("SELECT COUNT(*) AS count FROM operator_mutation_audit").get()).toEqual({ count: 0 });
  } finally { db.close(); }
});
