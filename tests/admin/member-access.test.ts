import { expect, it } from "vitest";
import { readMemberAccess } from "../../src/admin/member-access";
import { createTestD1 } from "../support/sqlite-d1";

const now = new Date("2026-10-02T00:00:00.000Z");
function seed(db: ReturnType<typeof createTestD1>) {
  db.sqlite.exec(`INSERT INTO users (id,status,created_at,updated_at) VALUES ('owner','active','t','t'),('other','active','t','t');
    UPDATE organization_surface_credit_defaults SET monthly_allowance=100;
    INSERT INTO codex_auths (id,kind,label,environment,status,created_at,updated_at) VALUES ('old','shared','Synthetic','production','active','t','t'),('new','shared','Synthetic','production','active','t','t');
    INSERT INTO organization_surface_credential_defaults (surface_grant,codex_auth_id,created_at,updated_at) VALUES ('surface:codex:production','new','t','t');
    INSERT INTO api_keys (id,user_id,key_prefix,key_hash,status,scopes,name,family_id,expires_at,created_at) VALUES
      ('key','owner','display','hash','active','["surface:codex:production"]','Work','family:key','2026-12-01T00:00:00.000Z','t'),
      ('foreign','other','private-other','hash-other','active','["surface:codex:production"]','Other','family:foreign',NULL,'t');
    INSERT INTO api_key_surface_credentials (api_key_id,surface_grant,codex_auth_id,created_at,updated_at) VALUES ('key','surface:codex:production','old','t','t');`);
}
it("preserves the old binding when a new default is unavailable and never reads credentials", async () => {
  const sql: string[]=[]; const db=createTestD1({onPrepare: s=>sql.push(s)});
  try {seed(db);db.sqlite.exec("UPDATE codex_auths SET status='reauth_required' WHERE id='new'");
    const model=await readMemberAccess({DB:db.binding} as Env,"owner",now);
    expect(model.surfaces[0]).toMatchObject({id:"codex",default:"unavailable",reason:"metadata-ready",existing:{known:true,value:{live:1,metadataReady:1}}});
    expect(model.keys.known && model.keys.value[0]).toMatchObject({key:{id:"key",lifecycle:{state:"active"}},replacement:{allowed:true}});
    expect(JSON.stringify(model)).not.toContain("private-other");
    expect(sql.some(s=>/SELECT.*key_hash|access_token|refresh_token/.test(s))).toBe(false);
  } finally {db.close();}
});
it.each(["missing", "unavailable"].flatMap(condition => ["none", "expired", "revoked"].map(history=>({condition,history}))))("identifies the administrator prerequisite with $history history and a $condition default", async ({condition,history}) => {
  const db=createTestD1();
  try {
    seed(db);
    if(history === "none") db.sqlite.exec("DELETE FROM api_keys WHERE user_id='owner'");
    else if(history === "revoked") db.sqlite.exec("UPDATE api_keys SET status='revoked' WHERE user_id='owner'");
    else db.sqlite.exec("UPDATE api_keys SET expires_at='2026-10-01T00:00:00.000Z' WHERE user_id='owner'");
    if(condition === "missing") db.sqlite.exec("DELETE FROM organization_surface_credential_defaults WHERE surface_grant='surface:codex:production'");
    else db.sqlite.exec("UPDATE codex_auths SET status='reauth_required' WHERE id='new'");
    const model=await readMemberAccess({DB:db.binding} as Env,"owner",now);
    expect(model.surfaces[0]).toMatchObject({entitlement:"eligible",default:condition,reason:"default-unavailable",existing:{known:true,value:{live:0}}});
    expect(model.canCreate).toBe(false);
  } finally {db.close();}
});
it.each(["quota","defaults","account","observations"])("keeps known inventory under an optional %s read failure",async failure=>{
  let armed=false;const db=createTestD1({onPrepare:s=>{if(armed&&({quota:s.startsWith("WITH surfaces"),defaults:s.includes("FROM organization_surface_credential_defaults")&&!s.startsWith("WITH"),account:s.startsWith("SELECT status, kind, environment"),observations:s.includes("FROM request_audit")}[failure]))throw Error("synthetic read unavailable");}});
  try {seed(db);armed=true;const model=await readMemberAccess({DB:db.binding} as Env,"owner",now);
    expect(model.keys.known).toBe(true);if(!model.keys.known)throw Error("inventory unknown");expect(model.keys.value.map(k=>k.key.id)).toEqual(["key"]);
    if(failure==="quota")expect(model.surfaces.every(s=>s.entitlement==="unknown")).toBe(true);
    if(failure==="defaults")expect(model.keys.value[0]?.replacement.allowed).toBe(true);
    if(failure==="account")expect(model.keys.value[0]?.bindings[0]?.state).toBe("unknown");
    if(failure==="observations")expect(model.keys.value[0]?.tasks.known).toBe(false);
  }finally{db.close();}
});
it("marks inventory failure unknown instead of empty while preserving quota",async()=>{
  let armed=false;const db=createTestD1({onPrepare:s=>{if(armed&&s.includes("u.status AS owner_status"))throw Error("synthetic inventory unavailable");}});
  try{seed(db);armed=true;const model=await readMemberAccess({DB:db.binding} as Env,"owner",now);expect(model.keys).toEqual({known:false});expect(model.surfaces[0]?.quota.known).toBe(true);expect(model.canCreate).toBe(false);}finally{db.close();}
});
it("projects expired raw-active keys and deduplicates account metadata across replacements",async()=>{
  const reads:string[]=[];const db=createTestD1({onBind:(s,v)=>{if(s.startsWith("SELECT status, kind, environment"))reads.push(String(v[0]));}});
  try{seed(db);db.sqlite.exec(`UPDATE api_keys SET expires_at='2026-10-01T00:00:00.000Z' WHERE id='key';
    INSERT INTO api_keys (id,user_id,key_prefix,key_hash,status,scopes,family_id,expires_at,created_at) VALUES ('replacement','owner','display-new','hash-new','active','["surface:codex:production"]','family:key','2026-12-01T00:00:00.000Z','u');
    INSERT INTO api_key_surface_credentials (api_key_id,surface_grant,codex_auth_id,created_at,updated_at) VALUES ('replacement','surface:codex:production','old','t','t');`);
    const model=await readMemberAccess({DB:db.binding} as Env,"owner",now);expect(reads.sort()).toEqual(["new","old"]);expect(model.liveFamilies).toBe(1);expect(model.keys.known&&model.keys.value[0]).toMatchObject({key:{status:"active",lifecycle:{state:"expired"}},family:{liveSecrets:1},replacement:{allowed:true}});expect(model.surfaces[0]?.existing).toMatchObject({value:{total:2,live:1,metadataReady:1}});
  }finally{db.close();}
});

it.each(["unconfigured","disabled","zero","exhausted","unlimited"])("keeps %s policy distinct from issuance and current-key facts",async mode=>{
  const db=createTestD1();try{seed(db);
    if(mode==="unconfigured")db.sqlite.exec("DELETE FROM organization_surface_credit_defaults WHERE surface_grant='surface:codex:production'");
    if(mode==="disabled"||mode==="unlimited")db.sqlite.prepare("INSERT INTO user_surface_credit_modes (user_id,surface_grant,mode,created_at,updated_at) VALUES ('owner','surface:codex:production',?,'t','t')").run(mode);
    if(mode==="zero")db.sqlite.exec("UPDATE organization_surface_credit_defaults SET monthly_allowance=0 WHERE surface_grant='surface:codex:production'");
    if(mode==="exhausted")db.sqlite.exec("INSERT INTO user_surface_credit_usage (user_id,surface_grant,period_start,consumed_credits,admitted_attempts,last_seen_at) VALUES ('owner','surface:codex:production','2026-10-01',100,1,'t')");
    const model=await readMemberAccess({DB:db.binding} as Env,"owner",now);const fact=model.surfaces[0]!;
    expect(fact.entitlement).toBe(mode==="unlimited"||mode==="exhausted"?"eligible":mode);
    expect(fact.existing).toMatchObject({known:true,value:{live:1}});
    expect(model.keys.known&&model.keys.value[0]?.replacement.allowed).toBe(mode==="unlimited"||mode==="exhausted");
    if(mode==="exhausted")expect(fact.reason).toBe("exhausted");
  }finally{db.close();}
});
