import { expect, it } from "vitest";
import { createTestD1 } from "../support/sqlite-d1";
import { configureRuntimeInstallation, readRuntimeInstallation, readRuntimeAuthority, changeRuntimeInstallation, setRuntimeAccess, readRuntimeOperation } from "../../src/runtime/installations";
import {runtimeInstallations} from "../../src/runtime/profiles";
import { credentialFixture } from "./credential-fixture";
import {commitUserStatus,type LifecycleActor} from "../../src/auth/principal";

const now = new Date("2026-10-13T04:00:00Z");
const operator: LifecycleActor = {kind:"admin_secret",userId:null,email:null,role:null,subject:null,requestId:"runtime-fixture"};
const declarations = JSON.stringify([
  {id:"design",profile:"google.stitch",resource:"https://design.example.test/mcp",label:"Design"},
  {id:"other",profile:"google.stitch",resource:"https://other.example.test/mcp",label:"Other"}
]);
function setup(options:Parameters<typeof createTestD1>[0]={}) {
  const db = createTestD1(options);
  const env = {DB:db.binding,CONSOLE_EMAIL_DOMAIN:"example.test",RUNTIME_INSTALLATIONS:declarations} as Env;
  for (const id of ["member","other","admin"]) db.sqlite.prepare(`INSERT INTO users
    (id,email,canonical_email,account_kind,role,status,login_capable,created_at,updated_at)
    VALUES (?,?,?,'human',?,'active',1,?,?)`).run(id,`${id}@example.test`,`${id}@example.test`,id==="admin"?"admin":"user",now.toISOString(),now.toISOString());
  return {db,env};
}

it("accepts distinct declared resource paths on one origin, not ambiguous or encoded paths",()=>{
  const declared=[
    {id:"stitch",profile:"google.stitch",resource:"https://mcp.example.test/google-stitch",label:"Stitch"},
    {id:"other",profile:"google.stitch",resource:"https://mcp.example.test/other",label:"Other"}
  ];
  const env={ADMIN_DASHBOARD_HOST:"console.example.test",RUNTIME_INSTALLATIONS:JSON.stringify(declared)} as Env;
  expect(runtimeInstallations(env)).toEqual(declared);
  for(const path of ["/","/google-stitch/","/google-stitch/mcp","/.well-known","/%67oogle-stitch","/Google-stitch"]) {
    env.RUNTIME_INSTALLATIONS=JSON.stringify([{...declared[0],resource:`https://mcp.example.test${path}`}]);
    expect(()=>runtimeInstallations(env)).toThrowError(expect.objectContaining({code:"runtime_declaration_invalid"}));
  }
  env.RUNTIME_INSTALLATIONS=JSON.stringify([declared[0],{...declared[1],resource:declared[0]!.resource}]);
  expect(()=>runtimeInstallations(env)).toThrowError(expect.objectContaining({code:"runtime_declaration_invalid"}));
});

// Accept an explicit disabled installation; reject unknown topology and all
// implicit access. Equivalent storage layouts must keep these public results.
it("starts unconfigured and denies implicit access even to an administrator", async () => {
  const {db,env}=setup(); try {
    expect(await readRuntimeInstallation(env,operator,"design")).toMatchObject({id:"design",state:"unconfigured",revision:0,credential_ready:false});
    await expect(configureRuntimeInstallation(env,operator,"unknown",now)).rejects.toMatchObject({code:"runtime_installation_not_found"});
    await configureRuntimeInstallation(env,operator,"design",now);
    expect(await readRuntimeInstallation(env,operator,"design")).toMatchObject({state:"disabled",revision:1,authority_revision:1,credential_ready:false});
    for (const subject of ["member","admin","absent"]) expect(await readRuntimeAuthority(env,subject,"design",now)).toBeNull();
    await expect(configureRuntimeInstallation(env,operator,"design",now)).rejects.toMatchObject({code:"runtime_changed"});
    expect(db.sqlite.prepare("SELECT count(*) AS n FROM operator_mutation_audit WHERE action='runtime.configure'").get()).toEqual({n:1});
  } finally {db.close();}
});

// Accept explicitly granted eligible members only. A different installation,
// administrator role or another member is not equivalent authority.
it("requires a ready credential, explicit access and current eligible human",async()=>{
  const {db,env}=setup(); const fixture=await credentialFixture();
  env.RUNTIME_CREDENTIALS=fixture.namespace;
  try {
    await configureRuntimeInstallation(env,operator,"design",now);
    await expect(changeRuntimeInstallation(env,operator,"design",{action:"enable",expectedRevision:1,operationId:"enable-empty"},now)).rejects.toMatchObject({code:"runtime_changed"});
    await changeRuntimeInstallation(env,operator,"design",{action:"supply",expectedRevision:1,operationId:"supply-a",authority:"rebind",material:"synthetic-a"},now);
    await changeRuntimeInstallation(env,operator,"design",{action:"enable",expectedRevision:2,operationId:"enable-a"},now);
    expect(await readRuntimeAuthority(env,"member","design",now)).toBeNull();
    await setRuntimeAccess(env,operator,"design","member",{state:"granted",expectedRevision:0,expiresAt:null},now);
    const admitted=await readRuntimeAuthority(env,"member","design",now);
    expect(admitted).toMatchObject({subject:"member",resource:"https://design.example.test/mcp",access_revision:1,authority_revision:2,credential_revision:2});
    expect(await fixture.namespace.getByName("design").read("design",admitted!.credential_ref,admitted!.credential_revision)==="synthetic-a").toBe(true);
    for(const [subject,id] of [["other","design"],["admin","design"],["member","other"]]) expect(await readRuntimeAuthority(env,subject!,id!,now)).toBeNull();
    await setRuntimeAccess(env,operator,"design","member",{state:"revoked",expectedRevision:1,expiresAt:null},now);
    expect(await readRuntimeAuthority(env,"member","design",now)).toBeNull();
    await setRuntimeAccess(env,operator,"design","member",{state:"granted",expectedRevision:2,expiresAt:"2026-10-13T04:01:00.000Z"},now);
    expect(await readRuntimeAuthority(env,"member","design",now)).toMatchObject({access_revision:3});
    expect(await readRuntimeAuthority(env,"member","design",new Date("2026-10-13T04:01:00Z"))).toBeNull();
    db.sqlite.prepare("UPDATE users SET status='disabled' WHERE id='member'").run();
    expect(await readRuntimeAuthority(env,"member","design",now)).toBeNull();
    db.sqlite.prepare("UPDATE users SET status='active' WHERE id='member'").run();
    expect(await readRuntimeAuthority(env,"member","design",now)).toMatchObject({access_revision:4});
  } finally {await fixture.dispose();db.close();}
},20000);

it("does not let storage expand deployment topology or reuse a retired resource",async()=>{
  const {db,env}=setup();try {
    await configureRuntimeInstallation(env,operator,"design",now);
    db.sqlite.exec("UPDATE runtime_installations SET state='retired' WHERE id='design'");
    env.RUNTIME_INSTALLATIONS=JSON.stringify([{id:"new-design",profile:"google.stitch",resource:"https://design.example.test/mcp",label:"New"}]);
    await expect(configureRuntimeInstallation(env,operator,"new-design",now)).rejects.toMatchObject({code:"runtime_changed"});
    await expect(readRuntimeAuthority(env,"member","design",now)).rejects.toMatchObject({code:"runtime_installation_not_found"});
    for(const declaration of ["{}",JSON.stringify([{id:"x",profile:"unknown",resource:"https://x.test/mcp",label:"X"}]),JSON.stringify([{id:"x",profile:"google.stitch",resource:"https://x.test/mcp?extra=1",label:"X"}])]) {
      env.RUNTIME_INSTALLATIONS=declaration;expect(()=>runtimeInstallations(env)).toThrow();
    }
    env.RUNTIME_INSTALLATIONS=JSON.stringify([{id:"design",profile:"google.stitch",resource:"https://different.test/mcp",label:"Moved"}]);
    await expect(readRuntimeInstallation(env,operator,"design")).rejects.toMatchObject({code:"runtime_declaration_changed"});
  } finally {db.close();}
});

it("rejects ineligible member grants and a changed mailbox at commit",async()=>{
  let move=false;const {db,env}=setup({onBatch:()=>{if(move){move=false;db.sqlite.exec("UPDATE users SET canonical_email='different@example.test' WHERE id='member'");}}});
  try {
    await configureRuntimeInstallation(env,operator,"design",now);
    db.sqlite.exec("INSERT INTO users(id,email,role,status,login_capable,account_kind,display_name,created_at,updated_at) VALUES('service',NULL,'user','active',0,'service','Service','2026-10-13','2026-10-13')");
    await expect(setRuntimeAccess(env,operator,"design","service",{state:"granted",expectedRevision:0,expiresAt:null},now)).rejects.toMatchObject({code:"runtime_changed"});
    for(const fields of ["canonical_email='@example.test'","canonical_email='member@outside.test'","status='disabled'"]) {
      db.sqlite.exec("UPDATE users SET account_kind='human',canonical_email='member@example.test',login_capable=1,status='active' WHERE id='member'");
      db.sqlite.exec(`UPDATE users SET ${fields} WHERE id='member'`);
      await expect(setRuntimeAccess(env,operator,"design","member",{state:"granted",expectedRevision:0,expiresAt:null},now)).rejects.toMatchObject({code:"runtime_changed"});
    }
    db.sqlite.exec("UPDATE users SET status='active',canonical_email='member@example.test' WHERE id='member'");
    move=true;
    await expect(setRuntimeAccess(env,operator,"design","member",{state:"granted",expectedRevision:0,expiresAt:null},now)).rejects.toMatchObject({code:"runtime_changed"});
  } finally {db.close();}
});

it("invalidates all of one human's Runtime access in the committing disable, with rollback and isolation",async()=>{
  const {db,env}=setup();try {
    for(const id of ["design","other"]) {
      await configureRuntimeInstallation(env,operator,id,now);
      await setRuntimeAccess(env,operator,id,"member",{state:"granted",expectedRevision:0,expiresAt:null},now);
    }
    await setRuntimeAccess(env,operator,"other","other",{state:"granted",expectedRevision:0,expiresAt:null},now);
    db.sqlite.exec("CREATE TRIGGER deny_disable_audit BEFORE INSERT ON operator_mutation_audit WHEN NEW.action='user.disable' BEGIN SELECT RAISE(ABORT,'synthetic audit failure'); END");
    await expect(commitUserStatus(env,operator,"member","disabled",now)).rejects.toThrow();
    expect(db.sqlite.prepare("SELECT revision FROM runtime_installation_access WHERE user_id='member'").all()).toEqual([{revision:1},{revision:1}]);
    db.sqlite.exec("DROP TRIGGER deny_disable_audit");
    await commitUserStatus(env,operator,"member","disabled",now);
    await commitUserStatus(env,operator,"member","active",now);
    expect(db.sqlite.prepare("SELECT revision FROM runtime_installation_access WHERE user_id='member'").all()).toEqual([{revision:2},{revision:2}]);
    expect(db.sqlite.prepare("SELECT revision FROM runtime_installation_access WHERE user_id='other'").get()).toEqual({revision:1});
  } finally {db.close();}
});

it("preserves consent revisions for declared same-authority rotation, not rebind or disable",async()=>{
  const {db,env}=setup();const fixture=await credentialFixture();env.RUNTIME_CREDENTIALS=fixture.namespace;
  const change=async(input:Omit<Parameters<typeof changeRuntimeInstallation>[3],"expectedRevision">&Record<string,unknown>)=>{
    const current=await readRuntimeInstallation(env,operator,"design");
    return changeRuntimeInstallation(env,operator,"design",{...input,expectedRevision:current.revision} as Parameters<typeof changeRuntimeInstallation>[3],now);
  };
  try {
    await configureRuntimeInstallation(env,operator,"design",now);
    await change({action:"supply",operationId:"first",authority:"rebind",material:"synthetic-first"});
    await change({action:"enable",operationId:"enabled"});
    await setRuntimeAccess(env,operator,"design","member",{state:"granted",expectedRevision:0,expiresAt:null},now);
    const old=await readRuntimeAuthority(env,"member","design",now);
    await change({action:"supply",operationId:"rotate",authority:"same",material:"synthetic-rotated"});
    expect(await readRuntimeAuthority(env,"member","design",now)).toMatchObject({authority_revision:2,access_revision:1});
    expect(await fixture.namespace.getByName("design").read("design",old!.credential_ref,old!.credential_revision)).toBeNull();
    await change({action:"rename",operationId:"rename",label:"New label"});
    expect(await readRuntimeAuthority(env,"member","design",now)).toMatchObject({resource:"https://design.example.test/mcp",authority_revision:2});
    await change({action:"supply",operationId:"rebind",authority:"rebind",material:"synthetic-new-authority"});
    expect(await readRuntimeAuthority(env,"member","design",now)).toMatchObject({authority_revision:3});
    await change({action:"disable",operationId:"disabled"});
    expect(await readRuntimeAuthority(env,"member","design",now)).toBeNull();
    await change({action:"enable",operationId:"enabled-again"});
    expect(await readRuntimeAuthority(env,"member","design",now)).toMatchObject({authority_revision:4});
    await change({action:"retire",operationId:"retired"});
    expect(await readRuntimeInstallation(env,operator,"design")).toMatchObject({state:"retired",credential_ready:false,phase:"ready",authority_revision:5});
    await expect(change({action:"enable",operationId:"resurrect"})).rejects.toMatchObject({code:"runtime_changed"});
    await expect(configureRuntimeInstallation(env,operator,"design",now)).rejects.toMatchObject({code:"runtime_changed"});
    const metadata=JSON.stringify(await readRuntimeInstallation(env,operator,"design"));
    expect(metadata.includes("synthetic-")).toBe(false);
    expect(JSON.stringify(db.sqlite.prepare("SELECT * FROM operator_mutation_audit").all()).includes("synthetic-")).toBe(false);
    expect((await readRuntimeOperation(env,operator,"design","rotate")).map(row=>row.action)).toEqual(["runtime.credential.staged","runtime.credential.bound","runtime.cleanup.completed"]);
  } finally {await fixture.dispose();db.close();}
},20000);

// A real committing SQL guard must win over a previous successful actor read;
// the success audit is part of that same transaction, not a mock call count.
it.each(["role","epoch","mailbox"])("rejects an administrator %s change at commit without a false success audit",async(kind)=>{
  let armed=false;
  const {db,env}=setup({onBatch:()=>{
    if(!armed)return;armed=false;
    db.sqlite.exec(kind==="role"?"UPDATE users SET role='user' WHERE id='admin'":kind==="epoch"?"UPDATE users SET console_session_epoch=1 WHERE id='admin'":"UPDATE users SET canonical_email='changed@example.test' WHERE id='admin'");
  }});
  const actor:LifecycleActor={...operator,kind:"access",userId:"admin",email:"admin@example.test",role:"admin",sessionEpoch:0};
  try {
    await configureRuntimeInstallation(env,actor,"design",now);
    armed=true;
    await expect(changeRuntimeInstallation(env,actor,"design",{action:"rename",label:"Denied",expectedRevision:1,operationId:"stale-actor"},now)).rejects.toMatchObject({code:"runtime_changed"});
    expect(await readRuntimeInstallation(env,operator,"design")).toMatchObject({label:"Design",revision:1});
    expect(db.sqlite.prepare("SELECT count(*) AS n FROM operator_mutation_audit WHERE action='runtime.rename'").get()).toEqual({n:0});
  } finally {db.close();}
});

it("rolls back a metadata change when its audit fails and denies a grant racing human disable",async()=>{
  let disable=false;
  const {db,env}=setup({onBatch:()=>{if(disable){disable=false;db.sqlite.exec("UPDATE users SET status='disabled' WHERE id='member'");}}});
  try {
    await configureRuntimeInstallation(env,operator,"design",now);
    db.sqlite.exec("CREATE TRIGGER audit_failure BEFORE INSERT ON operator_mutation_audit WHEN NEW.action='runtime.rename' BEGIN SELECT RAISE(ABORT,'synthetic audit failure'); END");
    await expect(changeRuntimeInstallation(env,operator,"design",{action:"rename",label:"Lost",expectedRevision:1,operationId:"rollback"},now)).rejects.toThrow();
    expect(await readRuntimeInstallation(env,operator,"design")).toMatchObject({label:"Design",revision:1});
    disable=true;
    await expect(setRuntimeAccess(env,operator,"design","member",{state:"granted",expectedRevision:0,expiresAt:null},now)).rejects.toMatchObject({code:"runtime_changed"});
    expect(db.sqlite.prepare("SELECT count(*) AS n FROM runtime_installation_access").get()).toEqual({n:0});
    expect(db.sqlite.prepare("SELECT count(*) AS n FROM operator_mutation_audit WHERE action='runtime.access.granted'").get()).toEqual({n:0});
  } finally {db.close();}
});

it.each(["before-store","after-store"])("retirement wins over a rotation held %s",async(point)=>{
  const {db,env}=setup();const fixture=await credentialFixture();
  const barrier=()=>{let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done;});return {promise,resolve};};
  const held=barrier();const release=barrier();
  let ref="";let revision=0;
  env.RUNTIME_CREDENTIALS={getByName:(id:string)=>{
    const real=fixture.namespace.getByName(id);
    return {clean:real.clean,read:real.read,put:async(identity:string,key:string,rev:number,material:string)=>{
      ref=key;revision=rev;
      if(point==="after-store")await real.put(identity,key,rev,material);
      held.resolve();await release.promise;
      if(point==="before-store")await real.put(identity,key,rev,material);
    }};
  }} as Env["RUNTIME_CREDENTIALS"];
  let pending:Promise<unknown>|undefined;
  try {
    await configureRuntimeInstallation(env,operator,"design",now);
    pending=changeRuntimeInstallation(env,operator,"design",{action:"supply",expectedRevision:1,operationId:"held-supply",authority:"rebind",material:"synthetic-late"},now).then(()=>"unexpected success",error=>error.code);
    await Promise.race([
      held.promise,
      pending.then(() => { throw new Error("Supply ended before reaching the test barrier"); })
    ]);
    await changeRuntimeInstallation(env,operator,"design",{action:"retire",expectedRevision:2,operationId:"retire-wins"},now);
    release.resolve();
    expect(await pending).toBe(point==="before-store"?"runtime_credential_pending":"runtime_changed");
    expect(await readRuntimeInstallation(env,operator,"design")).toMatchObject({state:"retired",revision:3,phase:"ready",credential_ready:false});
    expect(await fixture.namespace.getByName("design").read("design",ref,revision)).toBeNull();
    expect(db.sqlite.prepare("SELECT count(*) AS n FROM operator_mutation_audit WHERE action='runtime.credential.bound'").get()).toEqual({n:0});
  } finally {release.resolve();await pending;await fixture.dispose();db.close();}
},20000);

it.each(["lost-store-result","cleanup-failure"])("recovers %s without repeating secret supply or reviving authority",async(fault)=>{
  const {db,env}=setup();const fixture=await credentialFixture();
  env.RUNTIME_CREDENTIALS=fixture.namespace;
  try {
  await configureRuntimeInstallation(env,operator,"design",now);
  await changeRuntimeInstallation(env,operator,"design",{action:"supply",expectedRevision:1,operationId:"baseline",authority:"rebind",material:"synthetic-baseline"},now);
  await changeRuntimeInstallation(env,operator,"design",{action:"enable",expectedRevision:2,operationId:"baseline-enable"},now);
  await setRuntimeAccess(env,operator,"design","member",{state:"granted",expectedRevision:0,expiresAt:null},now);
  let broken=true;let storedRef="";
  env.RUNTIME_CREDENTIALS={getByName:(id:string)=>{
    const real=fixture.namespace.getByName(id);
    return {read:real.read,put:async(identity:string,ref:string,revision:number,material:string)=>{
      storedRef=ref;await real.put(identity,ref,revision,material);
      if(broken&&fault==="lost-store-result")throw new Error("Synthetic lost response");
    },clean:async(identity:string,revision:number,keep:string|null)=>{
      if(broken&&fault==="cleanup-failure")throw new Error("Synthetic cleanup unavailable");
      return real.clean(identity,revision,keep);
    }};
  }} as Env["RUNTIME_CREDENTIALS"];
    expect(await readRuntimeAuthority(env,"member","design",now)).not.toBeNull();
    await expect(changeRuntimeInstallation(env,operator,"design",{action:"supply",expectedRevision:3,operationId:"pending",authority:"rebind",material:"synthetic-candidate"},now)).rejects.toMatchObject({code:fault==="cleanup-failure"?"runtime_cleanup_pending":"runtime_credential_pending"});
    expect(await readRuntimeInstallation(env,operator,"design")).toMatchObject({state:"enabled",revision:4,phase:fault==="cleanup-failure"?"cleaning":"writing",operation_id:"pending",credential_ready:false});
    expect(await readRuntimeAuthority(env,"member","design",now)).toBeNull();
    broken=false;
    await changeRuntimeInstallation(env,operator,"design",{action:"recover",expectedRevision:4,operationId:"pending"},now);
    expect(await readRuntimeInstallation(env,operator,"design")).toMatchObject({state:fault==="cleanup-failure"?"enabled":"disabled",phase:"ready",credential_ready:fault==="cleanup-failure"});
    expect((await fixture.namespace.getByName("design").read("design",storedRef,4))!==null).toBe(fault==="cleanup-failure");
  } finally {await fixture.dispose();db.close();}
},20000);
