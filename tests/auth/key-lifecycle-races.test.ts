import { expect, it } from "vitest";
import { renameMemberKey, replaceMemberKey, revokeKey, resolveKeyExpiry, type KeyActor } from "../../src/auth/api-keys";
import { getApiKeyById } from "../../src/db";
import { createTestD1 } from "../support/sqlite-d1";

const now = new Date("2026-10-02T00:00:00.000Z");
const actor: KeyActor = { kind: "admin_secret", userId: null, email: null, subject: null, role: null, requestId: "key-race" };
function seed(db: ReturnType<typeof createTestD1>) {
  db.sqlite.exec(`INSERT INTO users (id,status,created_at,updated_at) VALUES ('owner','active','t','t');
    UPDATE organization_surface_credit_defaults SET monthly_allowance = 100;
    INSERT INTO codex_auths (id,kind,label,environment,status,created_at,updated_at) VALUES ('account','shared','Synthetic','production','active','t','t');
    INSERT INTO api_keys (id,user_id,key_prefix,key_hash,status,scopes,name,family_id,expires_at,created_at)
      VALUES ('source','owner','synthetic','synthetic-hash','active','["surface:codex:production"]','Before','family:source','2026-12-01T00:00:00.000Z','2026-09-01T00:00:00.000Z');
    INSERT INTO api_key_surface_credentials (api_key_id,surface_grant,codex_auth_id,created_at,updated_at)
      VALUES ('source','surface:codex:production','account','t','t');`);
}

it("confirms a committed rename when concurrent key use advances last_used_at", async () => {
  let touch = false;
  const db = createTestD1({ onBind: sql => {
    if (touch && sql.startsWith("UPDATE api_keys SET name")) {
      touch = false;
      db.sqlite.prepare("UPDATE api_keys SET last_used_at = ? WHERE id = 'source'").run(now.toISOString());
    }
  } });
  const env = { DB: db.binding } as Env;
  try {
    seed(db); touch = true;
    const result = await renameMemberKey(env, actor, "owner", "source", "After", now).then(() => "confirmed", error => error.code as string);
    expect(result).toBe("confirmed");
    expect(db.sqlite.prepare("SELECT name,last_used_at,key_hash,family_id FROM api_keys WHERE id = 'source'").get()).toEqual({ name: "After", last_used_at: now.toISOString(), key_hash: "synthetic-hash", family_id: "family:source" });
    expect(db.sqlite.prepare("SELECT COUNT(*) AS count FROM operator_mutation_audit WHERE action = 'key.rename'").get()).toEqual({ count: 1 });
  } finally { db.close(); }
});

it("rejects a replacement whose source is revoked after the read and before commit", async () => {
  let revoke = false;
  const db = createTestD1({ onBind: sql => {
    if (revoke && sql.startsWith("INSERT INTO api_keys")) {
      revoke = false;
      db.sqlite.prepare("UPDATE api_keys SET status = 'revoked', revoked_at = ? WHERE id = 'source'").run(now.toISOString());
    }
  } });
  const env = { DB: db.binding, API_KEY_HASH_PEPPER: "synthetic-pepper" } as Env;
  try {
    seed(db); revoke = true;
    const result = await replaceMemberKey(env, actor, "owner", "source", null, now).then(() => "issued", error => error.code as string);
    expect(result).toBe("key_not_active");
    expect(db.sqlite.prepare("SELECT id,status FROM api_keys").all()).toEqual([{ id: "source", status: "revoked" }]);
    expect(db.sqlite.prepare("SELECT COUNT(*) AS count FROM operator_mutation_audit WHERE action = 'key.replace.create'").get()).toEqual({ count: 0 });
  } finally { db.close(); }
});

it("does not add a success-change audit or claim a new revoke for a stale already-revoked source", async () => {
  const db = createTestD1(); const env = { DB: db.binding } as Env;
  try {
    seed(db);
    const before = (await getApiKeyById(env, "source"))!;
    await revokeKey(env, actor, before, now);
    const again = await revokeKey(env, actor, before, now);
    expect(again.already_revoked).toBe(true);
    expect(db.sqlite.prepare("SELECT COUNT(*) AS count FROM operator_mutation_audit WHERE action = 'key.revoke'").get()).toEqual({ count: 1 });
  } finally { db.close(); }
});

it.each(["2026-10-02T02:00:00+03:00", "2026-10-02T02:00:00+0300", "October 1, 2026 00:00:00 GMT"])("counts accepted expiry %s with the authentication parser",async expiry=>{
  const db=createTestD1();const env={DB:db.binding,API_KEY_HASH_PEPPER:"synthetic-pepper"} as Env;
  try{seed(db);expect(resolveKeyExpiry(expiry,new Date("2026-09-01T00:00:00Z"))).toBe(expiry);db.sqlite.prepare("UPDATE api_keys SET expires_at=? WHERE id='source'").run(expiry);db.sqlite.exec(`
    INSERT INTO api_keys (id,user_id,key_prefix,key_hash,status,scopes,family_id,expires_at,created_at) VALUES ('current','owner','display','another-hash','active','["surface:codex:production"]','family:source','2026-12-01T00:00:00Z','t');
    INSERT INTO api_key_surface_credentials (api_key_id,surface_grant,codex_auth_id,created_at,updated_at) VALUES ('current','surface:codex:production','account','t','t');`);
    const result=await replaceMemberKey(env,actor,"owner","source",null,now);
    expect(result.old_key_remains_active).toBe(false);expect(result.previous.lifecycle.state).toBe("expired");
    expect(result.previous.expires_at).toBe(expiry);
    expect(db.sqlite.prepare("SELECT COUNT(*) AS count FROM api_keys").get()).toEqual({count:3});
  }finally{db.close();}
});

it.each([false,true])("fences a valid member issuance across an epoch transition (drift=%s)",async drift=>{
  let invalidate=false;const db=createTestD1({onBind:sql=>{if(invalidate&&sql.startsWith("INSERT INTO api_keys")){invalidate=false;db.sqlite.exec("UPDATE users SET console_session_epoch=console_session_epoch+1 WHERE id='owner'");}}});
  const env={DB:db.binding,API_KEY_HASH_PEPPER:"synthetic-pepper"} as Env;
  try{seed(db);db.sqlite.exec("UPDATE users SET email='owner@example.com',canonical_email='owner@example.com',login_capable=1,account_kind='human' WHERE id='owner'");invalidate=drift;
    const member={...actor,kind:"access" as const,userId:"owner",email:"owner@example.com",role:"user" as const,sessionEpoch:0};
    const outcome=await replaceMemberKey(env,member,"owner","source",null,now).then(()=>"issued",error=>error.code as string);
    expect(outcome).toBe(drift?"console_identity_changed":"issued");expect(db.sqlite.prepare("SELECT COUNT(*) AS count FROM api_keys").get()).toEqual({count:drift?1:2});
    expect(db.sqlite.prepare("SELECT COUNT(*) AS count FROM operator_mutation_audit").get()).toEqual({count:drift?0:1});
  }finally{db.close();}
});

for (const operation of ["rename", "revoke", "replace"] as const) {
  it(`rejects ${operation} when a managing administrator loses authority before commit`,async()=>{
    let drift=false;const db=createTestD1({onBind:sql=>{
      if(drift&&(operation==="replace"?sql.startsWith("INSERT INTO api_keys"):sql.startsWith("UPDATE api_keys SET"))){drift=false;db.sqlite.exec("UPDATE users SET role='user' WHERE id='manager'");}
    }});const env={DB:db.binding,API_KEY_HASH_PEPPER:"synthetic-pepper"} as Env;
    try{seed(db);db.sqlite.exec("INSERT INTO users (id,email,canonical_email,login_capable,account_kind,role,status,created_at,updated_at) VALUES ('manager','manager@example.com','manager@example.com',1,'human','admin','active','t','t')");
      const manager:KeyActor={...actor,kind:"access",userId:"manager",email:"manager@example.com",role:"admin",sessionEpoch:0};
      const before=(await getApiKeyById(env,"source"))!;drift=true;
      const outcome=await (operation==="rename"?renameMemberKey(env,manager,"owner","source","After",now):operation==="revoke"?revokeKey(env,manager,before,now):replaceMemberKey(env,manager,"owner","source",null,now)).then(()=>"changed",error=>error.code as string);
      expect(outcome).toBe("console_identity_changed");expect(db.sqlite.prepare("SELECT id,name,status FROM api_keys").all()).toEqual([{id:"source",name:"Before",status:"active"}]);
      expect(db.sqlite.prepare("SELECT COUNT(*) AS count FROM operator_mutation_audit").get()).toEqual({count:0});
    }finally{db.close();}
  });
}


it("rejects an active-key phantom after capacity observation without a false issuance audit",async()=>{
  let insert=false;const db=createTestD1({onBind:sql=>{if(insert&&sql.startsWith("INSERT INTO api_keys")){insert=false;db.sqlite.exec(`INSERT INTO api_keys (id,user_id,key_prefix,key_hash,status,scopes,family_id,expires_at,created_at) VALUES ('phantom','owner','display-phantom','invalid-phantom','active','["surface:codex:production"]','family:phantom',NULL,'t')`);}}});
  const env={DB:db.binding,API_KEY_HASH_PEPPER:"synthetic-pepper"} as Env;
  try{seed(db);insert=true;const outcome=await replaceMemberKey(env,actor,"owner","source",null,now).then(()=>"issued",error=>error.code as string);
    expect(outcome).toBe("key_inventory_changed");expect(db.sqlite.prepare("SELECT id FROM api_keys ORDER BY id").all()).toEqual([{id:"phantom"},{id:"source"}]);
    expect(db.sqlite.prepare("SELECT COUNT(*) AS count FROM operator_mutation_audit").get()).toEqual({count:0});
  }finally{db.close();}
});
it("does not reject capacity after unrelated name and last-use changes",async()=>{
  let touch=false;const db=createTestD1({onBind:sql=>{if(touch&&sql.startsWith("INSERT INTO api_keys")){touch=false;db.sqlite.exec("UPDATE api_keys SET name='Changed name',last_used_at='changed' WHERE id='source'");}}});
  const env={DB:db.binding,API_KEY_HASH_PEPPER:"synthetic-pepper"} as Env;
  try{seed(db);touch=true;const outcome=await replaceMemberKey(env,actor,"owner","source",null,now).then(()=>"issued",error=>error.code as string);
    expect(outcome).toBe("issued");expect(db.sqlite.prepare("SELECT COUNT(*) AS count FROM api_keys").get()).toEqual({count:2});
  }finally{db.close();}
});
