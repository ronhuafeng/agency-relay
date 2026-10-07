import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { build } from "esbuild";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { expect, it } from "vitest";
import { createConsoleSession } from "../../src/auth/console-session";
import { createTestD1 } from "../support/sqlite-d1";
const now=new Date("2026-10-02T00:00:00.000Z");
function race(workerData:Record<string,unknown>):Promise<{status:number;oneTime:boolean;acknowledged:boolean}> {
  const worker=new Worker(new URL("./member-issue-race-worker.ts",import.meta.url),{execArgv:["--import","tsx"],workerData});
  return new Promise((resolve,reject)=>{let message: {status:number;oneTime:boolean;acknowledged:boolean}|undefined;worker.once("message",value=>{message=value;});worker.once("error",reject);worker.once("exit",code=>message?resolve(message):reject(Error(`worker ended ${code}`)));});
}
it.each([
  {operation:"create",replay:true}, {operation:"replace",replay:true},
  {operation:"create",replay:false}, {operation:"replace",replay:false}
] as const)("serializes native $operation submissions across real connections (replay=$replay)",async ({operation,replay})=>{
  mkdirSync("tmp",{recursive:true}); const directory=mkdtempSync(join(process.cwd(),"tmp/mini-issue-race-"));const file=join(directory,"test.sqlite");const held=join(directory,"held");const db=createTestD1({file});
  try{
    const entry=join(directory,"worker.mjs");
    await build({entryPoints:["src/router.ts"],outfile:entry,bundle:true,platform:"node",format:"esm",packages:"external",jsx:"automatic",define:{"process.env.NODE_ENV":'"production"'},logLevel:"silent"});
    db.sqlite.exec(`INSERT INTO users (id,email,canonical_email,login_capable,account_kind,role,status,created_at,updated_at) VALUES ('member','member@example.com','member@example.com',1,'human','user','active','t','t');
      UPDATE organization_surface_credit_defaults SET monthly_allowance=100;
      INSERT INTO codex_auths (id,kind,label,environment,status,created_at,updated_at) VALUES ('account','shared','Synthetic','production','active','t','t');
      INSERT INTO organization_surface_credential_defaults (surface_grant,codex_auth_id,created_at,updated_at) VALUES ('surface:codex:production','account','t','t');`);
    if(operation==="replace")db.sqlite.exec(`INSERT INTO api_keys (id,user_id,key_prefix,key_hash,status,scopes,family_id,expires_at,created_at) VALUES ('source','member','display','invalid-hash','active','["surface:codex:production"]','family:source','2026-12-01T00:00:00.000Z','t');
      INSERT INTO api_key_surface_credentials (api_key_id,surface_grant,codex_auth_id,created_at,updated_at) VALUES ('source','surface:codex:production','account','t','t');`);
    if(operation==="create"&&!replay)for(let index=0;index<4;index++)db.sqlite.prepare(`
      INSERT INTO api_keys (id,user_id,key_prefix,key_hash,status,scopes,family_id,expires_at,created_at)
      VALUES (?,'member',?,'invalid-hash','active','["surface:codex:production"]',?,NULL,'t')`).run(`existing-${index}`,`display-${index}`,`family:existing-${index}`);
    const token=await createConsoleSession({DB:db.binding,API_KEY_HASH_PEPPER:"synthetic-race-pepper",CONSOLE_EMAIL_DOMAIN:"example.com"} as Env,{id:"member",email:"member@example.com",sessionEpoch:0},now);
    const values={file,token,entry,path:operation==="create"?"/me/ui/keys":"/me/ui/keys/source/replace",body:{submission_id:`submit_${crypto.randomUUID()}`,name:"Work",surfaces:"codex"},holdFile:held};
    const first=race({...values,delay:800});const deadline=Date.now()+8000;
    while(!existsSync(held)&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,10));
    expect(existsSync(held)).toBe(true);const second=race({...values,body:replay?values.body:{...values.body,submission_id:`submit_${crypto.randomUUID()}`},delay:0});
    const outcomes=await Promise.all([first,second]);
    expect(outcomes.map(value=>value.status).sort()).toEqual(replay?[200,200]:[200,409]);
    expect(outcomes.filter(value=>value.oneTime)).toHaveLength(1);expect(outcomes.filter(value=>value.acknowledged)).toHaveLength(replay?1:0);
    expect(db.sqlite.prepare("SELECT COUNT(*) AS count FROM api_keys").get()).toEqual({count:operation==="create"?(replay?1:5):2});
    expect(db.sqlite.prepare("SELECT COUNT(*) AS count FROM api_key_surface_credentials").get()).toEqual({count:operation==="create"?1:2});
    expect(db.sqlite.prepare("SELECT COUNT(*) AS count FROM operator_mutation_audit WHERE action IN ('key.create','key.replace.create')").get()).toEqual({count:1});
  }finally{db.close();rmSync(directory,{recursive:true,force:true});}
});
