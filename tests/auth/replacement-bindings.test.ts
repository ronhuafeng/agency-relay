import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { readMemberAccess } from "../../src/admin/member-access";
import { replaceMemberKey, type KeyActor } from "../../src/auth/api-keys";
import { createTestD1 } from "../support/sqlite-d1";

const now = new Date("2026-10-02T00:00:00.000Z");
const actor: KeyActor = {kind:"access",userId:"owner",email:"owner@example.com",role:"user",sessionEpoch:0,subject:null,requestId:"replacement-binding"};
type Surface = "codex" | "grok" | "xai";
function seed(db: ReturnType<typeof createTestD1>, surfaces: readonly Surface[]) {
  db.sqlite.exec(`INSERT INTO users (id,email,canonical_email,login_capable,account_kind,role,status,created_at,updated_at)
      VALUES ('owner','owner@example.com','owner@example.com',1,'human','user','active','t','t');
    UPDATE organization_surface_credit_defaults SET monthly_allowance=100;
    INSERT INTO codex_auths (id,kind,label,environment,status,expires_at,created_at,updated_at)
      VALUES ('codex-account','shared','Synthetic','production','active','2020-01-01T00:00:00Z','t','t');
    INSERT INTO subscription_accounts (id,capability_source,environment,label,status,expires_at,refresh_available,created_at,updated_at)
      VALUES ('grok-account','grok','production','Synthetic','active','2020-01-01T00:00:00Z',1,'t','t');`);
  db.sqlite.prepare(`INSERT INTO api_keys (id,user_id,key_prefix,key_hash,status,scopes,name,family_id,expires_at,created_at)
    VALUES ('source','owner','display-source','invalid-hash','active',?,'Work','family:source','2026-12-01T00:00:00Z','t')`)
    .run(JSON.stringify(surfaces.map(surface=>`surface:${surface}:production`)));
  for(const surface of surfaces)db.sqlite.prepare(`INSERT INTO api_key_surface_credentials
    (api_key_id,surface_grant,codex_auth_id,subscription_account_id,created_at,updated_at) VALUES ('source',?,?,?,'t','t')`)
    .run(`surface:${surface}:production`,surface==="codex"?"codex-account":null,surface==="codex"?null:"grok-account");
}
function assertNoIssuance(db: ReturnType<typeof createTestD1>) {
  expect(db.sqlite.prepare("SELECT COUNT(*) AS count FROM api_keys").get()).toEqual({count:1});
  expect(db.sqlite.prepare("SELECT COUNT(*) AS count FROM operator_mutation_audit WHERE action='key.replace.create'").get()).toEqual({count:0});
  expect(db.sqlite.prepare("SELECT COUNT(*) AS count FROM api_key_surface_credentials WHERE api_key_id != 'source'").get()).toEqual({count:0});
}

it.each([
  {surface:"codex",status:"active",allowed:true},
  {surface:"codex",status:"reauth_required",allowed:false},
  {surface:"codex",status:"pending_credential",allowed:false},
  {surface:"codex",status:"degraded",allowed:false},
  {surface:"codex",status:"retiring",allowed:false},
  {surface:"grok",status:"active",allowed:true},
  {surface:"grok",status:"degraded",allowed:true},
  {surface:"grok",status:"reauth_required",allowed:false},
  {surface:"grok",status:"pending_credential",allowed:false},
  {surface:"grok",status:"retiring",allowed:false},
  {surface:"xai",status:"active",allowed:true},
  {surface:"xai",status:"reauth_required",allowed:false}
] as const)("keeps $surface $status replacement projection and service aligned, regardless of token expiry",async ({surface,status,allowed})=>{
  const db=createTestD1();const env={DB:db.binding,API_KEY_HASH_PEPPER:"synthetic-pepper"} as Env;
  try{
    seed(db,[surface]);db.sqlite.prepare(`UPDATE ${surface==="codex"?"codex_auths":"subscription_accounts"} SET status=?`).run(status);
    const model=await readMemberAccess(env,"owner",now);
    expect(model.keys.known&&model.keys.value[0]?.replacement.allowed).toBe(allowed);
    const outcome=await replaceMemberKey(env,actor,"owner","source",null,now).then(()=>"issued",error=>error.code as string);
    expect(outcome).toBe(allowed?"issued":"replacement_bindings_unavailable");
    if(!allowed)assertNoIssuance(db);
  }finally{db.close();}
});

it.each(["all","one"] as const)("rejects a source missing %s of its requested bindings without key or audit",async kind=>{
  const db=createTestD1();const env={DB:db.binding,API_KEY_HASH_PEPPER:"synthetic-pepper"} as Env;
  try{
    seed(db,["codex","grok"]);db.sqlite.exec(`DELETE FROM api_key_surface_credentials ${kind==="one"?"WHERE surface_grant='surface:grok:production'":""}`);
    const outcome=await replaceMemberKey(env,actor,"owner","source",null,now).then(()=>"issued",error=>error.code as string);
    expect(outcome).toBe("replacement_bindings_unavailable");assertNoIssuance(db);
  }finally{db.close();}
});

it.each([
  ["Codex reauthorization", "UPDATE codex_auths SET status='reauth_required'"],
  ["Codex incompatible kind", "UPDATE codex_auths SET kind='personal'"],
  ["Codex incompatible environment", "UPDATE codex_auths SET environment='staging'"],
  ["Grok pending credential", "UPDATE subscription_accounts SET status='pending_credential'"],
  ["Grok incompatible source", "UPDATE subscription_accounts SET capability_source='other'"],
  ["Grok incompatible environment", "UPDATE subscription_accounts SET environment='staging'"],
  ["all bindings removed", "DELETE FROM api_key_surface_credentials"],
  ["one binding removed", "DELETE FROM api_key_surface_credentials WHERE surface_grant='surface:grok:production'"],
  ["binding reassigned to an unusable account", `INSERT INTO codex_auths (id,kind,label,environment,status,created_at,updated_at) VALUES ('unusable','shared','Synthetic','production','reauth_required','t','t'); UPDATE api_key_surface_credentials SET codex_auth_id='unusable' WHERE surface_grant='surface:codex:production'`]
])("rejects %s after precheck through a second SQLite connection",async (_name,change)=>{
  mkdirSync("tmp",{recursive:true});const directory=mkdtempSync(join(process.cwd(),"tmp/replacement-binding-"));
  const file=join(directory,"test.sqlite");let drift=false;let other:ReturnType<typeof createTestD1>|undefined;
  const db=createTestD1({file,onBind:sql=>{if(drift&&sql.startsWith("INSERT INTO api_keys")){drift=false;other!.sqlite.exec(change);}}});
  const env={DB:db.binding,API_KEY_HASH_PEPPER:"synthetic-pepper"} as Env;
  try{
    seed(db,["codex","grok"]);other=createTestD1({file,migrations:"none"});drift=true;
    const outcome=await replaceMemberKey(env,actor,"owner","source",null,now).then(()=>"issued",error=>error.code as string);
    expect(outcome).toBe("replacement_bindings_unavailable");expect(drift).toBe(false);assertNoIssuance(db);
    const model=await readMemberAccess(env,"owner",now);expect(model.keys.known&&model.keys.value[0]?.replacement.allowed).toBe(false);
  }finally{other?.close();db.close();rmSync(directory,{recursive:true,force:true});}
});
