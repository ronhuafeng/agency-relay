import type { DatabaseSync } from "node:sqlite";
import { describe, expect, it, onTestFinished } from "vitest";
import { setApiKeyCredentialBinding, type OperatorMutationContext } from "../../src/admin/operator-mutations";
import { createTestD1 } from "../support/sqlite-d1";

const NOW = new Date("2026-10-06T00:00:00.000Z");
const GRANTS = ["surface:codex:production", "surface:grok:production", "surface:xai:production"];
const change = { api_key_id: "key-bound", surface_grant: "surface:xai:production", credential_account_id: "grok-new" } as const;

function fixture(beforeCommit?: (sqlite: DatabaseSync) => void) {
  let injected = false;
  const db = createTestD1({ onBatch: () => {
    if (injected) return;
    injected = true;
    beforeCommit?.(db.sqlite);
  } });
  onTestFinished(() => db.close());
  const at = NOW.toISOString();
  db.sqlite.prepare(`INSERT INTO users
    (id,email,canonical_email,login_capable,account_kind,role,status,created_at,updated_at)
    VALUES ('admin','admin@example.test','admin@example.test',1,'human','admin','active',?,?),
      ('owner','owner@example.test','owner@example.test',1,'human','user','active',?,?)`).run(at, at, at, at);
  db.sqlite.prepare(`INSERT INTO api_keys
    (id,user_id,key_prefix,key_hash,name,status,scopes,expires_at,created_at)
    VALUES ('key-bound','owner','display_bound','synthetic-hash','Work','active',?,NULL,?)`).run(JSON.stringify(GRANTS), at);
  db.sqlite.prepare(`INSERT INTO codex_auths (id,kind,label,environment,status,created_at,updated_at)
    VALUES ('codex-current','shared','Current Codex','production','active',?,?)`).run(at, at);
  for (const id of ["grok-current", "grok-new"]) db.sqlite.prepare(`INSERT INTO subscription_accounts
    (id,capability_source,environment,label,status,refresh_available,created_at,updated_at)
    VALUES (?,'grok','production',?,'active',1,?,?)`).run(id, id, at, at);
  for (const surface of GRANTS) db.sqlite.prepare(`INSERT INTO api_key_surface_credentials
    (api_key_id,surface_grant,codex_auth_id,subscription_account_id,created_at,updated_at)
    VALUES ('key-bound',?,?,?,?,?)`).run(surface,
      surface === GRANTS[0] ? "codex-current" : null,
      surface === GRANTS[0] ? null : "grok-current", at, at);
  const ctx: OperatorMutationContext = {
    env: { DB: db.binding, CONSOLE_EMAIL_DOMAIN: "example.test" } as Env,
    actor: { kind: "console", userId: "admin", email: "admin@example.test", subject: "synthetic-admin", role: "admin", sessionEpoch: 0 },
    deps: { fetch: async () => { throw new Error("Binding writes must not call a provider"); }, now: () => NOW },
    now: NOW,
    requestId: "binding-write"
  };
  const bindings = () => db.sqlite.prepare(`SELECT surface_grant,codex_auth_id,subscription_account_id,created_at,updated_at
    FROM api_key_surface_credentials WHERE api_key_id='key-bound' ORDER BY surface_grant`).all();
  const audits = () => db.sqlite.prepare(`SELECT action,target_type,target_id,actor_user_id,actor_role,result,meta
    FROM operator_mutation_audit WHERE request_id='binding-write' ORDER BY rowid`).all();
  return { db, ctx, bindings, audits };
}

describe("credential binding SQL commit", () => {
  it("changes one explicit shared-team binding and audits only that committed change", async () => {
    const f = fixture();
    const keyBefore = f.db.sqlite.prepare("SELECT user_id,status,scopes,name,expires_at FROM api_keys WHERE id='key-bound'").get();
    const result = await setApiKeyCredentialBinding(f.ctx, change);
    expect(result).toMatchObject({ api_key_id: "key-bound", surface_grant: GRANTS[2], subscription_account_id: "grok-new", codex_auth_id: null });
    expect(f.bindings().map(row => [row.surface_grant, row.codex_auth_id ?? row.subscription_account_id])).toEqual([
      [GRANTS[0], "codex-current"], [GRANTS[1], "grok-current"], [GRANTS[2], "grok-new"]
    ]);
    expect(f.db.sqlite.prepare("SELECT user_id,status,scopes,name,expires_at FROM api_keys WHERE id='key-bound'").get()).toEqual(keyBefore);
    expect(f.audits()).toEqual([{
      action: "key.credential_binding.set", target_type: "api_key_surface_credential", target_id: `key-bound:${GRANTS[2]}`,
      actor_user_id: "admin", actor_role: "admin", result: "ok",
      meta: JSON.stringify({ api_key_id: "key-bound", surface_grant: GRANTS[2], credential_account_id: "grok-new" })
    }]);
  });

  it.each([
    ["demotion", "role='user'"], ["disabled", "status='disabled'"],
    ["epoch", "console_session_epoch=console_session_epoch+1"],
    ["mailbox", "email='changed@example.test',canonical_email='changed@example.test'"],
    ["login disabled", "login_capable=0"]
  ])("rejects current admin %s at commit without changing the binding or reporting success", async (_label, drift) => {
    const f = fixture(sqlite => sqlite.exec(`UPDATE users SET ${drift} WHERE id='admin'`));
    const before = f.bindings();
    await expect(setApiKeyCredentialBinding(f.ctx, change)).rejects.toMatchObject({ status: 403, code: "admin_required" });
    expect(f.bindings()).toEqual(before);
    expect(f.audits()).toEqual([]);
  });

  it.each([
    ["key revoked", "UPDATE api_keys SET status='revoked' WHERE id='key-bound'"],
    ["surface removed", `UPDATE api_keys SET scopes='["${GRANTS[0]}","${GRANTS[1]}"]' WHERE id='key-bound'`],
    ["account retirement", "UPDATE subscription_accounts SET status='retiring' WHERE id='grok-new'"],
    ["account environment", "UPDATE subscription_accounts SET environment='staging' WHERE id='grok-new'"]
  ])("rejects %s between the initial read and SQL commit", async (_label, drift) => {
    const f = fixture(sqlite => sqlite.exec(drift));
    const before = f.bindings();
    await expect(setApiKeyCredentialBinding(f.ctx, change)).rejects.toMatchObject({ status: 409, code: "credential_binding_changed" });
    expect(f.bindings()).toEqual(before);
    expect(f.audits()).toEqual([]);
  });

  it("rolls back the binding when its success audit cannot be written", async () => {
    const f = fixture();
    const before = f.bindings();
    f.db.sqlite.exec(`CREATE TRIGGER fail_binding_audit BEFORE INSERT ON operator_mutation_audit
      WHEN NEW.action='key.credential_binding.set' BEGIN SELECT RAISE(ABORT,'synthetic audit failure'); END;`);
    await expect(setApiKeyCredentialBinding(f.ctx, change)).rejects.toThrow("synthetic audit failure");
    expect(f.bindings()).toEqual(before);
    expect(f.audits()).toEqual([]);
  });

  it("preserves explicit operator management of a paused owner's raw active key", async () => {
    const f = fixture();
    f.ctx.actor = { kind: "admin_secret", email: null, subject: null };
    f.db.sqlite.exec("UPDATE users SET status='disabled' WHERE id='owner'");
    f.db.sqlite.exec("UPDATE api_keys SET expires_at='2020-01-01T00:00:00Z' WHERE id='key-bound'");
    await expect(setApiKeyCredentialBinding(f.ctx, change)).resolves.toMatchObject({ subscription_account_id: "grok-new" });
    expect(f.audits()).toHaveLength(1);
    expect(f.audits()[0]).toMatchObject({ actor_user_id: null, actor_role: null });
    expect(f.db.sqlite.prepare("SELECT status,expires_at FROM api_keys WHERE id='key-bound'").get()).toEqual({ status: "active", expires_at: "2020-01-01T00:00:00Z" });
  });
});
