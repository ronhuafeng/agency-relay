import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import { commitServiceAccount } from "../../src/auth/service-accounts";
import { commitServiceOwner, delegatedService, readServiceOwner } from "../../src/auth/service-delegation";
import { commitIssuedKey, renameMemberKey, replaceMemberKey, revokeAllMemberKeys, revokeMemberKey, type KeyActor } from "../../src/auth/api-keys";
import { commitUserStatus, type ConsolePrincipal } from "../../src/auth/principal";
import { consumeSurfaceCredits, listSurfaceCreditStates } from "../../src/auth/credits";
import { authenticateEndUser } from "../../src/auth/authenticate";
import { createTestD1 } from "../support/sqlite-d1";

const now = new Date("2026-10-02T12:00:00.000Z");
const at = now.toISOString();
const grant = "surface:codex:production";
const operator: KeyActor = {kind:"admin_secret",userId:null,email:null,role:null,subject:null,requestId:"setup"};
const human = (id = "owner", role: "user" | "admin" = "user"): ConsolePrincipal => ({id,email:`${id}@example.com`,role,status:"active",sessionEpoch:0});
const actor = (id = "owner", role: "user" | "admin" = "user", serviceId?: string): KeyActor => ({kind:"access",userId:id,email:`${id}@example.com`,role,subject:null,sessionEpoch:0,requestId:"operation",...(serviceId ? {delegatedServiceId:serviceId} : {})});
async function setup(db: ReturnType<typeof createTestD1>) {
  const env = {DB:db.binding,CONSOLE_EMAIL_DOMAIN:"example.com",API_KEY_HASH_PEPPER:"synthetic-delegation-pepper"} as Env;
  for (const id of ["owner","next","admin"]) db.sqlite.prepare(`INSERT INTO users (id,email,canonical_email,account_kind,role,status,login_capable,created_at,updated_at)
    VALUES (?,?,?,'human',?,'active',1,?,?)`).run(id,`${id}@example.com`,`${id}@example.com`,id === "admin" ? "admin" : "user",at,at);
  const service = await commitServiceAccount(env,operator,"Nightly build",now);
  db.sqlite.prepare("DELETE FROM user_surface_credit_modes WHERE user_id = ? AND surface_grant = ?").run(service.id,grant);
  db.sqlite.prepare("INSERT INTO user_surface_credit_policies VALUES (?,?,20,?,?)").run(service.id,grant,at,at);
  db.sqlite.exec("UPDATE organization_surface_credit_defaults SET monthly_allowance = 100");
  db.sqlite.prepare("INSERT INTO codex_auths (id,kind,label,environment,status,created_at,updated_at) VALUES ('account','shared','Synthetic','production','active',?,?)").run(at,at);
  await commitServiceOwner(env,operator,service.id,{owner_user_id:"owner",expected_revision:0},now);
  const issue = (who: KeyActor, ownerId = service.id) => commitIssuedKey(env,who,{user_id:ownerId,name:"Build",scopes:[grant],expires_at:"2026-12-01T00:00:00.000Z",selections:[{surface_grant:grant,credential_account_id:"account"}],action:"key.create"},now);
  const key = await issue(operator);
  db.sqlite.prepare("INSERT INTO user_surface_credit_usage VALUES (?,?,'2026-10-01',3,3,?)").run(service.id,grant,at);
  db.sqlite.prepare("INSERT INTO request_audit (id,route_profile_id,user_id,key_id,status,created_at,total_tokens) VALUES ('prior','codex.production.responses',?,?,'ok',?,7)").run(service.id,key.id,at);
  return {env,service,key,issue};
}

it("only assigns active human owners under current admin authority, with no nested or implicit ownership",async()=>{
  const db=createTestD1();try{
    const f=await setup(db);
    const second=await commitServiceAccount(f.env,operator,"Unassigned",now);
    expect(await readServiceOwner(f.env,second.id)).toMatchObject({owner_user_id:null,revision:0});
    await expect(delegatedService(f.env,human(),second.id)).rejects.toMatchObject({status:404});
    expect((await delegatedService(f.env,human("admin","admin"),second.id)).id).toBe(second.id);
    for(const ownerId of [second.id,"absent"]){
      await expect(commitServiceOwner(f.env,operator,f.service.id,{owner_user_id:ownerId,expected_revision:1},now)).rejects.toMatchObject({code:"service_owner_changed"});
    }
    db.sqlite.exec("UPDATE users SET status = 'disabled' WHERE id = 'next'");
    await expect(commitServiceOwner(f.env,operator,f.service.id,{owner_user_id:"next",expected_revision:1},now)).rejects.toMatchObject({code:"service_owner_changed"});
    await expect(commitServiceOwner(f.env,actor(),f.service.id,{owner_user_id:null,expected_revision:1},now)).rejects.toMatchObject({code:"service_owner_changed"});
    await expect(f.issue(actor("next","user",f.service.id))).rejects.toMatchObject({status:404});
    // An owner ID passed to a personal helper is not a delegation context.
    await expect(f.issue(actor())).rejects.toMatchObject({code:"console_identity_changed"});
    expect(await readServiceOwner(f.env,f.service.id)).toMatchObject({owner_user_id:"owner",revision:1});
    await f.issue(actor("admin","admin",f.service.id));
  }finally{db.close();}
});

it("transfers and removes delegation without altering service identity, policies, history, bindings or copied bearer authority",async()=>{
  const db=createTestD1();try{
    const f=await setup(db);
    const tables=["users","api_keys","api_key_surface_credentials","user_surface_credit_policies","user_surface_credit_modes","user_surface_credit_usage","request_audit"];
    const before=tables.map(table=>db.sqlite.prepare(`SELECT * FROM ${table}`).all());
    await commitServiceOwner(f.env,actor("admin","admin"),f.service.id,{owner_user_id:"next",expected_revision:1},now);
    expect(JSON.stringify(tables.map(table=>db.sqlite.prepare(`SELECT * FROM ${table}`).all())) === JSON.stringify(before)).toBe(true);
    await expect(delegatedService(f.env,human(),f.service.id)).rejects.toMatchObject({status:404});
    expect((await delegatedService(f.env,human("next"),f.service.id)).id).toBe(f.service.id);
    const request=new Request("https://api.trustedtunnel.app/v1/models",{headers:{Authorization:`Bearer ${f.key.token}`}});
    const authenticate=()=>authenticateEndUser(request,f.env,{waitUntil:()=>{}},{requiredSurfaceGrant:grant},now);
    expect((await authenticate()).user.id).toBe(f.service.id);
    await commitServiceOwner(f.env,operator,f.service.id,{owner_user_id:null,expected_revision:2},now);
    expect((await authenticate()).user.id).toBe(f.service.id);
    await expect(delegatedService(f.env,human("next"),f.service.id)).rejects.toMatchObject({status:404});
    await revokeMemberKey(f.env,actor("admin","admin",f.service.id),f.service.id,f.key.id,now);
    await expect(authenticate()).rejects.toMatchObject({code:"invalid_api_key"});
    const audits=db.sqlite.prepare("SELECT actor_user_id,target_id,meta FROM operator_mutation_audit WHERE action='service.owner.change' ORDER BY rowid").all();
    expect(audits.map(row=>JSON.parse(String(row.meta)).credentials_unchanged)).toEqual([true,true,true]);
    expect(audits[1]).toMatchObject({actor_user_id:"admin",target_id:f.service.id});
    expect(JSON.parse(String(audits[1]!.meta))).toMatchObject({previous_owner_user_id:"owner",owner_user_id:"next"});
  }finally{db.close();}
});

it("retains explicit owner assignment after admin demotion; human disable blocks access without disabling the service",async()=>{
  const db=createTestD1();try{
    const f=await setup(db);
    db.sqlite.exec("UPDATE users SET role='admin' WHERE id='owner'");
    const captured=actor("owner","admin",f.service.id);
    db.sqlite.exec("UPDATE users SET role='user' WHERE id='owner'");
    const issued=await f.issue(captured);
    expect(db.sqlite.prepare("SELECT actor_user_id,actor_role FROM operator_mutation_audit WHERE target_id = ?").get(issued.id)).toEqual({actor_user_id:"owner",actor_role:"user"});
    await commitUserStatus(f.env,operator,"owner","disabled",now);
    await expect(delegatedService(f.env,human(),f.service.id)).rejects.toMatchObject({status:404});
    await expect(revokeMemberKey(f.env,captured,f.service.id,issued.id,now)).rejects.toMatchObject({status:404});
    expect(db.sqlite.prepare("SELECT status FROM users WHERE id=?").get(f.service.id)).toEqual({status:"active"});
    expect(db.sqlite.prepare("SELECT status FROM api_keys WHERE id=?").get(issued.id)).toEqual({status:"active"});
  }finally{db.close();}
});

it("keeps service families and consumption independent, allows recovery revocation while disabled, and never revives revoked keys",async()=>{
  const db=createTestD1();try{
    const f=await setup(db);const delegated=actor("owner","user",f.service.id);
    for(let i=0;i<5;i++) await f.issue(actor(),"owner");
    const key=await f.issue(delegated);
    expect(db.sqlite.prepare("SELECT COUNT(DISTINCT family_id) AS count FROM api_keys WHERE user_id=?").get(f.service.id)).toEqual({count:2});
    await consumeSurfaceCredits(f.env,{user_id:f.service.id,surface_grant:grant,credit_charge:2,plan_id:"test"},now);
    expect((await listSurfaceCreditStates(f.env,now,"owner"))[0]?.consumed_credits).toBe(0);
    expect((await listSurfaceCreditStates(f.env,now,f.service.id))[0]?.consumed_credits).toBe(5);
    await commitUserStatus(f.env,operator,f.service.id,"disabled",now);
    expect((await delegatedService(f.env,human(),f.service.id)).status).toBe("disabled");
    await expect(f.issue(delegated)).rejects.toMatchObject({code:"user_inactive"});
    await expect(replaceMemberKey(f.env,delegated,f.service.id,key.id,undefined,now)).rejects.toMatchObject({code:"user_inactive"});
    await revokeMemberKey(f.env,delegated,f.service.id,key.id,now);
    expect(await revokeAllMemberKeys(f.env,delegated,f.service.id,now)).toEqual({revoked:1});
    await commitUserStatus(f.env,operator,f.service.id,"active",now);
    expect(db.sqlite.prepare("SELECT COUNT(*) AS count FROM api_keys WHERE user_id=? AND status='revoked'").get(f.service.id)).toEqual({count:2});
    expect(db.sqlite.prepare("SELECT COUNT(*) AS count FROM api_keys WHERE user_id='owner' AND status='active'").get()).toEqual({count:5});
  }finally{db.close();}
});

for(const operation of ["issue","replace","rename","revoke","revoke-all"] as const) {
  for(const drift of ["transfer","remove","human-disable","epoch","mailbox","service-disable"] as const) it(`committing ${operation} respects ${drift} from a separate connection`,async()=>{
    const directory=mkdtempSync(join(tmpdir(),"mini-service-owner-"));const file=join(directory,"db.sqlite");
    let armed=false;let competitor:ReturnType<typeof createTestD1>;let serviceId="";
    const db=createTestD1({file,onBatch:()=>{
      if(!armed)return;armed=false;
      if(drift==="transfer"||drift==="remove") competitor.sqlite.prepare("UPDATE service_account_owners SET owner_user_id=?,revision=revision+1 WHERE service_user_id=?").run(drift==="transfer"?"next":null,serviceId);
      else if(drift==="service-disable")competitor.sqlite.prepare("UPDATE users SET status='disabled' WHERE id=?").run(serviceId);
      else competitor.sqlite.exec(`UPDATE users SET ${drift==="human-disable"?"status='disabled'":drift==="epoch"?"console_session_epoch=console_session_epoch+1":"email='renamed@example.com',canonical_email='renamed@example.com'"} WHERE id='owner'`);
    }});
    competitor=createTestD1({file,migrations:"none"});
    try{
      const f=await setup(db);serviceId=f.service.id;const who=actor("owner","user",serviceId);
      const beforeKeys=db.sqlite.prepare("SELECT * FROM api_keys").all();const beforeBindings=db.sqlite.prepare("SELECT * FROM api_key_surface_credentials").all();
      armed=true;
      const outcome=await (operation==="issue"?f.issue(who):operation==="replace"?replaceMemberKey(f.env,who,serviceId,f.key.id,undefined,now):operation==="rename"?renameMemberKey(f.env,who,serviceId,f.key.id,"Renamed",now):operation==="revoke"?revokeMemberKey(f.env,who,serviceId,f.key.id,now):revokeAllMemberKeys(f.env,who,serviceId,now)).then(()=>true,()=>false);
      const allowed=drift==="service-disable" && ["rename","revoke","revoke-all"].includes(operation);
      expect(outcome).toBe(allowed);
      expect(db.sqlite.prepare("SELECT COUNT(*) AS count FROM operator_mutation_audit WHERE request_id='operation'").get()).toEqual({count:allowed?1:0});
      if(!allowed){expect(JSON.stringify(db.sqlite.prepare("SELECT * FROM api_keys").all()) === JSON.stringify(beforeKeys)).toBe(true);expect(JSON.stringify(db.sqlite.prepare("SELECT * FROM api_key_surface_credentials").all()) === JSON.stringify(beforeBindings)).toBe(true);}
    }finally{competitor.close();db.close();rmSync(directory,{recursive:true,force:true});}
  });
}

it("rejects stale assignment versions and rolls back ownership if the canonical audit fails",async()=>{
  const db=createTestD1();try{
    const f=await setup(db);
    await commitServiceOwner(f.env,operator,f.service.id,{owner_user_id:null,expected_revision:1},now);
    await commitServiceOwner(f.env,operator,f.service.id,{owner_user_id:"owner",expected_revision:2},now);
    await expect(commitServiceOwner(f.env,operator,f.service.id,{owner_user_id:"next",expected_revision:1},now)).rejects.toMatchObject({code:"service_owner_changed"});
    db.sqlite.exec("CREATE TRIGGER fail_owner_audit BEFORE INSERT ON operator_mutation_audit WHEN NEW.action='service.owner.change' BEGIN SELECT RAISE(ABORT,'injected-owner-audit'); END;");
    await expect(commitServiceOwner(f.env,operator,f.service.id,{owner_user_id:"next",expected_revision:3},now)).rejects.toThrow("injected-owner-audit");
    expect(await readServiceOwner(f.env,f.service.id)).toMatchObject({owner_user_id:"owner",revision:3});
  }finally{db.close();}
});

for (const drift of ["transfer", "new-owner-disable", "admin-demotion", "admin-disable", "admin-epoch"] as const) {
  it(`owner assignment checks ${drift} inside the committing transaction`, async () => {
    const directory = mkdtempSync(join(tmpdir(), "mini-service-assignment-")); const file = join(directory, "db.sqlite");
    let armed = false; let serviceId = ""; let competitor: ReturnType<typeof createTestD1>;
    const db = createTestD1({file, onBatch: () => {
      if (!armed) return; armed = false;
      if (drift === "transfer") competitor.sqlite.prepare("UPDATE service_account_owners SET owner_user_id = NULL, revision = revision + 1 WHERE service_user_id = ?").run(serviceId);
      else if (drift === "new-owner-disable") competitor.sqlite.exec("UPDATE users SET status = 'disabled' WHERE id = 'next'");
      else competitor.sqlite.exec(`UPDATE users SET ${drift === "admin-demotion" ? "role = 'user'" : drift === "admin-disable" ? "status = 'disabled'" : "console_session_epoch = console_session_epoch + 1"} WHERE id = 'admin'`);
    }});
    competitor = createTestD1({file, migrations: "none"});
    try {
      const f = await setup(db); serviceId = f.service.id; armed = true;
      await expect(commitServiceOwner(f.env, actor("admin", "admin"), serviceId, {owner_user_id: "next", expected_revision: 1}, now)).rejects.toMatchObject({code: "service_owner_changed"});
      expect(await readServiceOwner(f.env, serviceId)).toMatchObject({owner_user_id: drift === "transfer" ? null : "owner", revision: drift === "transfer" ? 2 : 1});
      expect(db.sqlite.prepare("SELECT COUNT(*) AS count FROM operator_mutation_audit WHERE request_id = 'operation'").get()).toEqual({count: 0});
      expect(db.sqlite.prepare("SELECT COUNT(*) AS count FROM api_keys WHERE user_id = ? AND status = 'active'").get(serviceId)).toEqual({count: 1});
    } finally { competitor.close(); db.close(); rmSync(directory, {recursive: true, force: true}); }
  });
}

it("rejects a guessed next revision rather than auditing an earlier owner after an intervening transfer", async () => {
  const directory=mkdtempSync(join(tmpdir(),"mini-owner-audit-"));const file=join(directory,"db.sqlite");
  let armed=false;let serviceId="";let competitor:ReturnType<typeof createTestD1>;
  const db=createTestD1({file,onBatch:()=>{
    if(!armed)return;armed=false;
    competitor.sqlite.prepare("UPDATE service_account_owners SET owner_user_id='next',revision=2 WHERE service_user_id=?").run(serviceId);
  }});
  competitor=createTestD1({file,migrations:"none"});
  try {
    const f=await setup(db);serviceId=f.service.id;armed=true;
    const committed=await commitServiceOwner(f.env,actor("admin","admin"),serviceId,{owner_user_id:null,expected_revision:2},now).then(()=>true,error=>{expect(error.code).toBe("service_owner_changed");return false;});
    const audit=db.sqlite.prepare("SELECT meta FROM operator_mutation_audit WHERE request_id='operation' AND action='service.owner.change'").get();
    // Safe attribution scalars establish the pre-fix counterexample without keys or hashes.
    expect({committed,previousOwner:audit?JSON.parse(String(audit.meta)).previous_owner_user_id:null}).toEqual({committed:false,previousOwner:null});
    armed=false;
    competitor.sqlite.prepare("UPDATE service_account_owners SET owner_user_id='next',revision=2 WHERE service_user_id=?").run(serviceId);
    await commitServiceOwner(f.env,actor("admin","admin"),serviceId,{owner_user_id:null,expected_revision:2},now);
    const fresh=db.sqlite.prepare("SELECT meta FROM operator_mutation_audit WHERE request_id='operation' AND action='service.owner.change'").get()!;
    expect(JSON.parse(String(fresh.meta))).toMatchObject({previous_owner_user_id:"next",previous_revision:2,revision:3});
  }finally{competitor.close();db.close();rmSync(directory,{recursive:true,force:true});}
});
