import { expect, it } from "vitest";
import { commitServiceAccount } from "../../src/auth/service-accounts";
import { commitIssuedKey, renameMemberKey, revokeKey, type KeyActor } from "../../src/auth/api-keys";
import { getApiKeyById } from "../../src/db";
import { createTestD1 } from "../support/sqlite-d1";

const now = new Date("2026-10-02T12:00:00.000Z");
const at = now.toISOString();
const operator: KeyActor = { kind: "admin_secret", userId: null, email: null, role: null, subject: null, requestId: "service-key-setup" };
const manager: KeyActor = { kind: "access", userId: "manager", email: "manager@example.com", role: "admin", subject: null, sessionEpoch: 0, requestId: "service-key-change" };
const changes = {
  none: "role = 'admin'",
  demotion: "role = 'user'",
  disabled: "status = 'disabled'",
  mailbox: "email = 'changed@example.com', canonical_email = 'changed@example.com'",
  epoch: "console_session_epoch = console_session_epoch + 1",
  kind: "account_kind = 'legacy_unresolved'"
};

for (const action of ["issue", "rename", "revoke"] as const) {
  for (const [drift, change] of Object.entries(changes)) it(`service key ${action} uses committing human authority after ${drift}`, async () => {
    let armed = false;
    const db = createTestD1({ onBatch() { if (armed) { armed = false; db.sqlite.exec(`UPDATE users SET ${change} WHERE id = 'manager'`); } } });
    const env = { DB: db.binding, CONSOLE_EMAIL_DOMAIN: "example.com", API_KEY_HASH_PEPPER: "synthetic-service-key-pepper" } as Env;
    try {
      db.sqlite.prepare("INSERT INTO users (id,email,canonical_email,role,status,login_capable,account_kind,created_at,updated_at) VALUES ('manager','manager@example.com','manager@example.com','admin','active',1,'human',?,?)").run(at, at);
      const service = await commitServiceAccount(env, operator, "Build automation", now);
      db.sqlite.prepare("DELETE FROM user_surface_credit_modes WHERE user_id = ? AND surface_grant = 'surface:codex:production'").run(service.id);
      db.sqlite.prepare("INSERT INTO user_surface_credit_policies VALUES (?,'surface:codex:production',12,?,?)").run(service.id, at, at);
      db.sqlite.prepare("INSERT INTO codex_auths (id,kind,label,environment,status,created_at,updated_at) VALUES ('synthetic-account','shared','Synthetic','production','active',?,?)").run(at, at);
      db.sqlite.prepare("INSERT INTO api_keys (id,user_id,key_prefix,key_hash,status,scopes,name,family_id,expires_at,created_at) VALUES ('existing',?,'display-only','not-a-working-hash','active','[\"surface:codex:production\"]','Before','family:existing','2026-12-01T00:00:00.000Z',?)").run(service.id, at);
      const existing = (await getApiKeyById(env, "existing"))!;
      armed = true;
      const outcome = await (action === "issue"
        ? commitIssuedKey(env, manager, { user_id: service.id, name: "New key", scopes: ["surface:codex:production"], expires_at: "2026-12-01T00:00:00.000Z", selections: [{ surface_grant: "surface:codex:production", credential_account_id: "synthetic-account" }], action: "key.create" }, now)
        : action === "rename" ? renameMemberKey(env, manager, service.id, existing.id, "After", now)
          : revokeKey(env, manager, existing, now)).then(() => "changed", error => error.code as string);
      expect(outcome).toBe(drift === "none" ? "changed" : "console_identity_changed");
      expect(db.sqlite.prepare("SELECT COUNT(*) AS count FROM api_keys").get()).toEqual({ count: drift === "none" && action === "issue" ? 2 : 1 });
      expect(db.sqlite.prepare("SELECT name,status FROM api_keys WHERE id = 'existing'").get()).toEqual({ name: drift === "none" && action === "rename" ? "After" : "Before", status: drift === "none" && action === "revoke" ? "revoked" : "active" });
      expect(db.sqlite.prepare("SELECT COUNT(*) AS count FROM operator_mutation_audit WHERE request_id = 'service-key-change'").get()).toEqual({ count: drift === "none" ? 1 : 0 });
    } finally { db.close(); }
  });
}
