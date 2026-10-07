import { JSDOM } from "jsdom";
import { expect, it } from "vitest";
import { createConsoleSession } from "../../src/auth/console-session";
import { resolveConsolePrincipal } from "../../src/auth/principal";
import { commitServiceAccount } from "../../src/auth/service-accounts";
import { commitServiceOwner } from "../../src/auth/service-delegation";
import { handleRequest } from "../../src/router";
import { authenticateEndUser } from "../../src/auth/authenticate";
import { readAssignedServiceImpact } from "../../src/admin/service-owner-impact";
import { makeFixture } from "../router/fixture";
import { createTestD1 } from "../support/sqlite-d1";

const origin="https://admin.example.test";
const operator={kind:"admin_secret" as const,userId:null,email:null,role:null,subject:null,requestId:"setup"};
async function fixture(options: Parameters<typeof createTestD1>[0] = {}) {
  const db=createTestD1(options);const f=makeFixture({env:{DB:db.binding}});const now=f.deps.now();
  const owner=await resolveConsolePrincipal(f.env,"owner@example.com",now);
  const other=await resolveConsolePrincipal(f.env,"other@example.com",now);
  const admin=await resolveConsolePrincipal(f.env,"admin@example.com",now);
  db.sqlite.prepare("UPDATE users SET role='admin' WHERE id=?").run(admin.id);
  const tokens:Record<string,string>={};for(const person of [owner,other,admin])tokens[person.id]=await createConsoleSession(f.env,person,now);
  const service=await commitServiceAccount(f.env,operator,"Nightly automation",now);
  const foreign=await commitServiceAccount(f.env,operator,"Unrelated project",now);
  await commitServiceOwner(f.env,operator,service.id,{owner_user_id:owner.id,expected_revision:0},now);
  db.sqlite.prepare("DELETE FROM user_surface_credit_modes WHERE user_id=? AND surface_grant='surface:codex:production'").run(service.id);
  db.sqlite.prepare("INSERT INTO user_surface_credit_policies VALUES (?,'surface:codex:production',12,'t','t')").run(service.id);
  db.sqlite.exec(`UPDATE organization_surface_credit_defaults SET monthly_allowance=100;
    INSERT INTO codex_auths (id,kind,label,environment,status,created_at,updated_at) VALUES ('private-upstream-id','shared','Private upstream label','production','active','t','t');
    INSERT INTO organization_surface_credential_defaults (surface_grant,codex_auth_id,created_at,updated_at) VALUES ('surface:codex:production','private-upstream-id','t','t');`);
  await f.tokenAuthority.saveToken({auth_id:"private-upstream-id",access_token:"synthetic-provider-placeholder",expires_at:new Date(now.getTime()+86400000).toISOString(),status:"active"});
  const call=(path:string,options:{person?:string;method?:string;body?:Record<string,unknown>;html?:boolean;origin?:string|null}={})=>{
    const method=options.method??"GET";const headers=new Headers({Cookie:`__Host-mini-console=${tokens[options.person??owner.id]}`,Accept:options.html?"text/html":"application/json"});
    if(method!=="GET"&&options.origin!==null)headers.set("Origin",options.origin??origin);
    if(options.body)headers.set("Content-Type",options.html?"application/x-www-form-urlencoded":"application/json");
    return handleRequest(new Request(origin+path,{method,headers,...(options.body?{body:options.html?new URLSearchParams(options.body as Record<string,string>):JSON.stringify(options.body)}:{})}),f.env,f.ctx,f.deps);
  };
  const prefix=`/me/service-accounts/${service.id}`;
  const create=async(name="Build")=>{
    const response=await call(prefix+"/keys",{method:"POST",body:{name,surfaces:["codex"]}});
    expect(response.status).toBe(201);return await response.json() as {key:{id:string};api_key:string};
  };
  return {db,f,now,owner,other,admin,service,foreign,call,prefix,create};
}

it("keeps personal and delegated metadata, keys, quota, usage and setup in explicit exact contexts",async()=>{
  const f=await fixture();try{
    const personal=await f.call("/me/keys",{method:"POST",body:{name:"Personal-only name",surfaces:["codex"],user_id:f.service.id}});expect(personal.status).toBe(201);
    expect(f.db.sqlite.prepare("SELECT user_id FROM api_keys WHERE name='Personal-only name'").get()).toEqual({user_id:f.owner.id});
    const serviceKey=await f.create();
    const me=await f.call("/me");expect(await me.json()).toMatchObject({user:{id:f.owner.id}});
    const list=await f.call("/me/service-accounts");expect(await list.json()).toEqual({services:[{id:f.service.id,display_name:"Nightly automation",status:"active"}]});
    const personalKeys=await f.call("/me/keys");const own=await personalKeys.json() as {keys:{id:string}[]};expect(own.keys).toHaveLength(1);expect(own.keys[0]!.id===serviceKey.key.id).toBe(false);
    const serviceKeys=await f.call(f.prefix+"/keys");expect(await serviceKeys.json()).toMatchObject({keys:[{id:serviceKey.key.id}]});
    const quota=await f.call(f.prefix+"/credits?user_id="+f.owner.id);const credits=await quota.json() as {credits:{monthly_allowance:number}[]};expect(credits.credits[0]!.monthly_allowance).toBe(12);
    for(const view of ["home","keys","quota","usage","setup"]){
      const response=await f.call(f.prefix+`?view=${view}${["keys","setup"].includes(view)?`&key=${serviceKey.key.id}`:""}`,{html:true});expect(response.status).toBe(200);expect(response.headers.get("Cache-Control")).toContain("no-store");
      const text=await response.text();const doc=new JSDOM(text).window.document;
      expect(doc.querySelector('[data-service-id]')?.getAttribute('data-service-id')).toBe(f.service.id);
      expect(doc.querySelector('[data-console-actor-id]')?.getAttribute('data-console-actor-id')).toBe(f.owner.id);
      expect(text.includes("Nightly automation")).toBe(true);
      for(const privateValue of ["Personal-only name","Unrelated project",f.other.email,"private-upstream-id","Private upstream label","key_hash",serviceKey.api_key])expect(text.includes(privateValue)).toBe(false);
      if(view==="keys"){
        expect(doc.querySelector('form[data-member-key-create]')?.getAttribute('action')).toBe(f.prefix+"/ui/keys");
        expect(doc.querySelector('form[data-member-key-create] input[name=key_return]')?.getAttribute('value')).toBe(f.prefix+"?view=keys");
        expect(doc.querySelector('form[action$="/revoke"]')?.getAttribute('data-confirmation')).toContain(f.service.id);
      }
      if(view==="setup"){
        const setup=doc.querySelector('[data-member-view="setup"]')!;
        expect(setup.querySelectorAll('[popover]')).toHaveLength(1);
        expect(setup.querySelector('[popover]')?.getAttribute('aria-label')).toBe('配置说明');
        expect([...setup.querySelectorAll('[popover] a')].map(link=>link.getAttribute('href'))).toEqual([f.prefix+'?view=keys',f.prefix+'?view=quota']);
        expect(setup.querySelector('.member-setup-evidence,[data-setup-key]')).toBeNull();
        expect(doc.querySelector('main')?.getAttribute('data-console-read-url')).toBe(f.prefix+'?view=setup');
      }
    }
    const usage=await f.call(f.prefix+"/usage?user_id="+f.owner.id);expect(await usage.json()).toMatchObject({scope:"service",service_id:f.service.id});
    const home=await f.call("/admin?area=me&view=home",{html:true});expect((await home.text()).includes(f.prefix+"?view=home")).toBe(true);
  }finally{f.db.close();}
});

it("keeps delegated local configuration independent of key and quota reads while enforcing current ownership",async()=>{
  const f=await fixture();try{
    f.db.sqlite.exec(`DROP TABLE request_audit;
      DROP TABLE api_key_surface_credentials;
      DROP TABLE organization_surface_credential_defaults;
      DROP TABLE api_keys;
      DROP TABLE user_surface_credit_usage;
      DROP TABLE user_surface_credit_modes;
      DROP TABLE user_surface_credit_policies;
      DROP TABLE organization_surface_credit_defaults;
      DROP TABLE codex_auths;
      DROP TABLE subscription_accounts;`);
    const response=await f.call(f.prefix+'?view=setup&key=absent-key',{html:true});
    expect(response.status).toBe(200);
    const doc=new JSDOM(await response.text()).window.document;
    expect(doc.querySelector('[data-service-id]')?.getAttribute('data-service-id')).toBe(f.service.id);
    expect(doc.querySelector('form[data-local-config-sync] input[name="existing_key"]')).not.toBeNull();
    expect(doc.querySelector('[data-member-view="setup"] [role="alert"]')).toBeNull();
    expect((await f.call(f.prefix+'?view=setup',{person:f.other.id,html:true})).status).toBe(404);
    await commitServiceOwner(f.f.env,operator,f.service.id,{owner_user_id:f.other.id,expected_revision:1},f.now);
    expect((await f.call(f.prefix+'?view=setup',{html:true})).status).toBe(404);
    expect((await f.call(f.prefix+'?view=setup',{person:f.other.id,html:true})).status).toBe(200);
  }finally{f.db.close();}
});

it("non-enumerates missing, foreign and human targets and never lets owners mutate admin state",async()=>{
  const f=await fixture();try{
    const codes=[];
    for(const target of [f.foreign.id,f.owner.id,"absent"]){const result=await f.call(`/me/service-accounts/${target}/keys`);expect(result.status).toBe(404);codes.push((await result.json() as {error:{code:string}}).error.code);}
    expect(new Set(codes).size).toBe(1);
    expect((await f.call(f.prefix+"/keys",{person:f.other.id})).status).toBe(404);
    expect((await f.call(f.prefix+"/keys",{person:f.admin.id})).status).toBe(200);
    for(const path of [`/admin/ui/services/${f.service.id}/owner`,`/admin/ui/services/${f.service.id}/name`,`/admin/ui/users/${f.service.id}/status`,`/admin/ui/users/${f.service.id}/credits/codex`]){
      expect((await f.call(path,{method:"POST",body:{confirm:"1",owner_user_id:f.owner.id,expected_revision:1,display_name:"Wrong",status:"active",monthly_allowance:999}})).status).toBe(403);
    }
    for(const field of ["credential_bindings","credential_account_id","user_id","service_id","owner_user_id"]){expect((await f.call(f.prefix+"/keys",{method:"POST",body:{name:"Bad",surfaces:["codex"],[field]:f.other.id}})).status).toBe(400);}
    const personal=await f.call("/me/keys",{method:"POST",body:{name:"Personal",surfaces:["codex"]}});const own=await personal.json() as {key:{id:string}};
    expect((await f.call(f.prefix+`/keys/${own.key.id}`,{method:"DELETE"})).status).toBe(404);
    const key=await f.create();expect((await f.call(`/me/keys/${key.key.id}`,{method:"DELETE"})).status).toBe(404);
  }finally{f.db.close();}
});

it("native issue, rename, replacement and deduplicated results retain the service target without exposing the secret twice",async()=>{
  const f=await fixture();try{
    const body={name:"Native build",surfaces:"codex",submission_id:`submit_${crypto.randomUUID()}`};
    const first=await f.call(f.prefix+"/ui/keys",{method:"POST",body,html:true});expect(first.status).toBe(200);const doc=new JSDOM(await first.text()).window.document;
    expect(doc.querySelector('[data-one-time-key] h1')?.textContent).toContain("Nightly automation");
    const key=f.db.sqlite.prepare("SELECT id FROM api_keys WHERE user_id=?").get(f.service.id) as {id:string};
    expect(doc.querySelector('[data-one-time-key]')?.getAttribute('data-member-return')).toBe(f.prefix+`?view=keys&key=${key.id}`);
    const replay=await f.call(f.prefix+"/ui/keys",{method:"POST",body,html:true});expect(replay.status).toBe(200);const text=await replay.text();expect(text.includes("data-one-time-key")).toBe(false);expect(text.includes("此前已经完成")).toBe(true);expect(new JSDOM(text).window.document.querySelector("h1")?.textContent).toBe("Nightly automation · 操作已完成");
    const collision=await f.call("/me/ui/keys",{method:"POST",body,html:true});expect(collision.status).toBe(409);
    const rename=await f.call(f.prefix+`/ui/keys/${key.id}/rename`,{method:"POST",body:{name:"Renamed build"},html:true});expect(rename.status).toBe(200);expect((await rename.text()).includes("Renamed build")).toBe(true);
    const replace=await f.call(f.prefix+`/ui/keys/${key.id}/replace`,{method:"POST",body:{submission_id:`submit_${crypto.randomUUID()}`},html:true});expect(replace.status).toBe(200);expect((await replace.text()).includes("仍可认证")).toBe(true);
    expect(f.db.sqlite.prepare("SELECT COUNT(DISTINCT family_id) AS families,COUNT(*) AS keys FROM api_keys WHERE user_id=?").get(f.service.id)).toEqual({families:1,keys:2});
    await commitServiceOwner(f.f.env,operator,f.service.id,{owner_user_id:f.other.id,expected_revision:1},f.now);
    expect((await f.call(f.prefix+"/ui/keys",{method:"POST",body,html:true})).status).toBe(404);
    expect(f.db.sqlite.prepare("SELECT COUNT(*) AS count FROM api_keys").get()).toEqual({count:2});
  }finally{f.db.close();}
});

it("requires exact browser origin and allows disabled-service inspection and deliberate revocation",async()=>{
  const f=await fixture();try{
    const key=await f.create();
    for(const origin of [null,"https://foreign.test"])expect((await f.call(f.prefix+`/ui/keys/${key.key.id}/revoke`,{method:"POST",origin,body:{},html:true})).status).toBe(403);
    f.db.sqlite.prepare("UPDATE users SET status='disabled' WHERE id=?").run(f.service.id);
    const page=await f.call(f.prefix+`?view=keys&key=${key.key.id}`,{html:true});expect(page.status).toBe(200);const doc=new JSDOM(await page.text()).window.document;
    expect(doc.querySelector('form[data-member-key-create] button')?.hasAttribute('disabled')).toBe(true);
    expect(doc.querySelector('form[action$="/replace"]')).toBeNull();expect(doc.querySelector('form[action$="/revoke"]')).not.toBeNull();
    const rejected=await f.call(f.prefix+"/ui/keys",{method:"POST",body:{name:"No",surfaces:"codex",submission_id:`submit_${crypto.randomUUID()}`},html:true});expect(rejected.status).toBe(403);const text=await rejected.text();expect(text.includes("不能发行或更换")).toBe(true);expect(rejected.headers.get("set-cookie")).toBeNull();
    const revoke=await f.call(f.prefix+"/ui/keys/revoke-all",{method:"POST",body:{},html:true});expect(revoke.status).toBe(200);expect((await revoke.text()).includes("已撤销 1 个密钥")).toBe(true);
    f.db.sqlite.prepare("UPDATE users SET status='active' WHERE id=?").run(f.service.id);
    expect(f.db.sqlite.prepare("SELECT status FROM api_keys WHERE id=?").get(key.key.id)).toEqual({status:"revoked"});
  }finally{f.db.close();}
});

it("admin transfer explicitly warns about unchanged bearers, shows safe affected keys and supports separate revocation",async()=>{
  const f=await fixture();try{
    await f.create();const page=await f.call(`/admin?view=access&person=${f.service.id}`,{person:f.admin.id,html:true});expect(page.status).toBe(200);
    const doc=new JSDOM(await page.text()).window.document;const form=doc.querySelector(`form[action$="/${f.service.id}/owner"]`)!;
    expect(form.getAttribute("data-confirmation")).toContain("仍可进行 API 调用");expect(form.querySelector('input[name=expected_revision]')?.getAttribute('value')).toBe("1");
    expect(doc.querySelector('a[href="'+f.prefix+'?view=keys"]')).not.toBeNull();expect(doc.querySelector(`#service-owner-keys-${f.service.id}`)?.textContent).toContain("Build");
    const transfer=await f.call(`/admin/ui/services/${f.service.id}/owner`,{person:f.admin.id,method:"POST",body:{owner_user_id:f.other.id,expected_revision:"1",confirm:"1",person_return:`/admin?view=access&person=${f.service.id}`},html:true});expect(transfer.status).toBe(200);
    const result=await transfer.text();expect(result.includes("密钥没有更改")).toBe(true);expect(result.includes('data-mutation-flash="service_owner_changed"')).toBe(true);
    expect((await f.call(f.prefix+"/keys")).status).toBe(404);expect((await f.call(f.prefix+"/keys",{person:f.other.id})).status).toBe(200);
    const stale=await f.call(`/admin/ui/services/${f.service.id}/owner`,{person:f.admin.id,method:"POST",body:{owner_user_id:f.owner.id,expected_revision:"1",confirm:"1"},html:true});expect(stale.status).toBe(409);
    expect(f.db.sqlite.prepare("SELECT owner_user_id FROM service_account_owners WHERE service_user_id=?").get(f.service.id)).toEqual({owner_user_id:f.other.id});
  }finally{f.db.close();}
});


it("keeps delegated 7/30-day trend navigation, exports and invalid-range recovery bound to the service", async () => {
  const f=await fixture();try {
    const insert=f.db.sqlite.prepare(`INSERT INTO usage_daily (user_id,day,route_profile_id,response_model,requests,ok_requests,error_requests,total_tokens,token_measurements,provider_cost_usd_ticks,cost_measurements,first_seen_at,last_seen_at) VALUES (?,?, 'codex.responses',?,?,?,0,0,0,0,0,'t','t')`);
    insert.run(f.service.id,"2026-06-24","service-current-model",7,7);
    insert.run(f.service.id,"2026-05-30","service-older-model",11,11);
    insert.run(f.owner.id,"2026-06-24","human-private-model",100,100);
    insert.run(f.foreign.id,"2026-06-24","foreign-service-model",200,200);
    for(const [range,requests,days] of [["7d",7,7],["30d",18,30]] as const) {
      const response=await f.call(f.prefix+`?view=usage&range=${range}&user_id=${f.owner.id}`,{html:true});
      expect(response.status).toBe(200);const text=await response.text();const doc=new JSDOM(text).window.document;
      expect(doc.querySelector('main')?.getAttribute('data-dashboard-url')).toBe(f.prefix+`?view=usage&range=${range}`);
      expect(doc.querySelector('h1')?.textContent).toBe("Nightly automation · 用量");
      expect(doc.querySelector('[data-trend-plan="codex.responses"] .usage-metrics')?.textContent).toContain(`Requests${requests}`);
      expect(doc.querySelectorAll('[data-daily-plan="codex.responses"]')).toHaveLength(days);
      const hrefs=[...doc.querySelectorAll('nav[aria-label="UTC 时间范围"] a')].map(a=>a.getAttribute('href'));
      expect(hrefs).toEqual([f.prefix+'?view=usage&range=7d',f.prefix+'?view=usage&range=30d']);
      const exportHref=doc.querySelector('a[download]')?.getAttribute('href')!;expect(exportHref.startsWith(f.prefix+'/usage?from=')).toBe(true);
      const exported=await f.call(exportHref+`&user_id=${f.owner.id}`);expect(exported.status).toBe(200);
      expect(await exported.json()).toMatchObject({scope:"service",service_id:f.service.id,usage:{totals:{requests}}});
      for(const hidden of ["human-private-model","foreign-service-model"])expect(text.includes(hidden)).toBe(false);
    }
    const invalid=await f.call(f.prefix+'?view=usage&range=bad',{html:true});expect(invalid.status).toBe(400);
    const doc=new JSDOM(await invalid.text()).window.document;
    expect(doc.querySelector('[data-service-id]')?.getAttribute('data-service-id')).toBe(f.service.id);
      expect(doc.querySelector('[data-console-actor-id]')?.getAttribute('data-console-actor-id')).toBe(f.owner.id);
    expect([...doc.querySelectorAll('a')].some(a=>a.getAttribute('href')===f.prefix+'?view=usage')).toBe(true);
    expect((await f.call(f.prefix+'/usage?from=2026-02-30&to=2026-06-24')).status).toBe(400);
  } finally {f.db.close();}
});

it("rejects an omitted owner field instead of removing a disabled human's assignment", async () => {
  const f = await fixture(); try {
    f.db.sqlite.prepare("UPDATE users SET status='disabled' WHERE id=?").run(f.owner.id);
    const audits = f.db.sqlite.prepare("SELECT COUNT(*) AS count FROM operator_mutation_audit WHERE action='service.owner.change'").get();
    const response = await f.call(`/admin/ui/services/${f.service.id}/owner`, {person:f.admin.id, method:"POST", html:true,
      body:{expected_revision:"1", confirm:"1"}});
    expect(response.status).toBe(400);
    const doc=new JSDOM(await response.text()).window.document;
    expect(doc.querySelector('form[data-dashboard-draft="service-name"] input[name="display_name"]')?.getAttribute('value')).toBe('Nightly automation');
    expect(f.db.sqlite.prepare("SELECT owner_user_id,revision FROM service_account_owners WHERE service_user_id=?").get(f.service.id)).toEqual({owner_user_id:f.owner.id,revision:1});
    expect(f.db.sqlite.prepare("SELECT COUNT(*) AS count FROM operator_mutation_audit WHERE action='service.owner.change'").get()).toEqual(audits);
  } finally {f.db.close();}
});

it("human offboarding shows assigned service key impact and warns that copied service bearers survive", async () => {
  const f = await fixture(); try {
    const key = await f.create();
    const response = await f.call(`/admin?view=access&person=${f.owner.id}`, {person:f.admin.id,html:true});
    expect(response.status).toBe(200); const doc = new JSDOM(await response.text()).window.document;
    const form = doc.querySelector(`form[action='/admin/ui/users/${f.owner.id}/status']`)!;
    expect(form.getAttribute('data-confirmation')).toContain('服务账号密钥仍可能用于 API 调用');
    const impact = doc.querySelector('[data-assigned-service-impact]');
    expect(impact?.textContent).toContain('Nightly automation'); expect(impact?.textContent).toContain('Build');
    expect(impact?.querySelector(`a[href='${f.prefix}?view=keys&key=${key.key.id}']`)).not.toBeNull();
    for (const privateValue of [key.api_key, 'private-upstream-id', 'Private upstream label']) expect(impact?.textContent?.includes(privateValue)).toBe(false);
  } finally {f.db.close();}
});

it("requires an explicit valid owner value and preserves operator JSON null removal", async () => {
  const f=await fixture();try {
    const url=`https://api.trustedtunnel.app/admin/services/${f.service.id}/owner`;
    const call=(body:Record<string,unknown>)=>handleRequest(new Request(url,{method:"POST",headers:{Authorization:`Bearer ${f.f.env.ADMIN_SECRET}`,"Content-Type":"application/json"},body:JSON.stringify(body)}),f.f.env,f.f.ctx,f.f.deps);
    for(const value of [undefined, "", "  ", 0, [], {}]){
      const body={confirm:true,expected_revision:1,...(value===undefined?{}:{owner_user_id:value})};
      expect((await call(body)).status).toBe(400);
      expect(f.db.sqlite.prepare("SELECT owner_user_id,revision FROM service_account_owners WHERE service_user_id=?").get(f.service.id)).toEqual({owner_user_id:f.owner.id,revision:1});
    }
    expect((await call({confirm:true,expected_revision:1,owner_user_id:null})).status).toBe(200);
    expect((await call({confirm:true,expected_revision:2,owner_user_id:f.other.id})).status).toBe(200);
    expect(f.db.sqlite.prepare("SELECT owner_user_id,revision FROM service_account_owners WHERE service_user_id=?").get(f.service.id)).toEqual({owner_user_id:f.other.id,revision:3});
    expect(f.db.sqlite.prepare("SELECT COUNT(*) AS count FROM operator_mutation_audit WHERE action='service.owner.change'").get()).toEqual({count:3});
  }finally{f.db.close();}
});

it("human disable preserves the exact service and copied bearer until a separate deliberate revoke", async () => {
  const f=await fixture();try {
    const key=await f.create();
    const request=new Request('https://api.trustedtunnel.app/v1/models',{headers:{Authorization:`Bearer ${key.api_key}`}});
    const authenticate=()=>authenticateEndUser(request,f.f.env,f.f.ctx,{requiredSurfaceGrant:'surface:codex:production'},f.now);
    expect((await authenticate()).user.id===f.service.id).toBe(true);
    const rows=()=>JSON.stringify([
      f.db.sqlite.prepare("SELECT * FROM users WHERE id=?").get(f.service.id),
      f.db.sqlite.prepare("SELECT * FROM api_keys WHERE user_id=?").all(f.service.id),
      f.db.sqlite.prepare("SELECT * FROM api_key_surface_credentials WHERE api_key_id=?").all(key.key.id),
      f.db.sqlite.prepare("SELECT * FROM user_surface_credit_policies WHERE user_id=?").all(f.service.id),
      f.db.sqlite.prepare("SELECT * FROM service_account_owners WHERE service_user_id=?").get(f.service.id)
    ]);
    const before=rows();
    const disabled=await f.call(`/admin/ui/users/${f.owner.id}/status`,{person:f.admin.id,method:'POST',body:{confirm:true,status:'disabled'}});
    expect(disabled.status).toBe(200);expect(rows()===before).toBe(true);
    expect((await authenticate()).user.id===f.service.id).toBe(true);
    expect((await f.call(f.prefix+'/keys')).status).toBe(403);
    expect((await f.call(f.prefix+`/keys/${key.key.id}`,{person:f.admin.id,method:'DELETE'})).status).toBe(200);
    await expect(authenticate()).rejects.toMatchObject({code:'invalid_api_key'});
  }finally{f.db.close();}
});

for(const failure of ['services','keys'] as const) it(`human detail preserves ${failure} impact-read uncertainty without hiding lifecycle controls`, async()=>{
  let fail=false;
  const f=await fixture({onPrepare(sql){if(fail&&(failure==='services'?sql.includes('WHERE assignment.owner_user_id'):sql.startsWith('SELECT id, name, key_prefix, status, expires_at FROM api_keys')))throw new Error('synthetic impact read unavailable');}});
  try {
    await f.create();fail=true;
    const response=await f.call(`/admin?view=access&person=${f.owner.id}`,{person:f.admin.id,html:true});expect(response.status).toBe(200);
    const doc=new JSDOM(await response.text()).window.document;
    const impact=doc.querySelector('[data-assigned-service-impact]')!;
    expect(impact.querySelector('[data-service-impact-state="unknown"]')).not.toBeNull();
    expect(impact.textContent?.includes('暂时未读到')).toBe(true);
    expect(doc.querySelector(`[data-action='user-status']`)).not.toBeNull();
    if(failure==='keys')expect(impact.querySelector(`a[href='${f.prefix}?view=keys']`)).not.toBeNull();
  }finally{f.db.close();}
});

it("bounds the administrator impact projection and distinguishes truncation from a complete empty inventory", async()=>{
  const f=await fixture();try {
    for(let i=0;i<21;i++){
      const service=await commitServiceAccount(f.f.env,operator,`Service ${i.toString().padStart(2,'0')}`,f.now);
      await commitServiceOwner(f.f.env,operator,service.id,{owner_user_id:f.owner.id,expected_revision:0},f.now);
    }
    for(let i=0;i<11;i++)f.db.sqlite.prepare(`INSERT INTO api_keys (id,user_id,key_prefix,key_hash,status,scopes,name,family_id,created_at) VALUES (?,?,?,'display-only-not-a-hash','active','["surface:codex:production"]',?,?,?)`).run(`display-${i}`,f.service.id,`display_${i}`,`Build ${i}`,`family-${i}`,f.now.toISOString());
    const impact=await readAssignedServiceImpact(f.f.env,f.owner.id);
    expect(impact.known).toBe(true);if(!impact.known)throw new Error('Expected known impact');
    expect(impact.services).toHaveLength(20);expect(impact.moreServices).toBe(true);
    const service=impact.services.find(row=>row.id===f.service.id)!;expect(service.keys).toHaveLength(10);expect(service.moreKeys).toBe(true);
    expect(impact.services.some(row=>row.id===f.foreign.id)).toBe(false);
    expect(Object.keys(service.keys![0]!).sort()).toEqual(['expires_at','id','key_prefix','name','status']);
    const empty=await readAssignedServiceImpact(f.f.env,f.other.id);expect(empty).toEqual({known:true,services:[],moreServices:false});
  }finally{f.db.close();}
});
