import {expect,it} from "vitest";
import {oauthFixture,authorizedTokens,resourceRequest,ISSUER,RESOURCE,OTHER_RESOURCE} from "./oauth-fixture";

it("shows permitted installations only to their member, not to another member or personal admin",async()=>{
  const fixture=await oauthFixture();
  try {
    const read=async(subject:string)=>{
      const response=await fixture.runtime.dispatchFetch(`${ISSUER}/runtime/integrations`,{
        headers:{Cookie:fixture.cookies.get(subject)!}
      });
      return {status:response.status,body:await response.json() as {
        installations:Array<{id:string;resource:string;state:string;credential_ready:boolean}>;
        consents:unknown[];activity:unknown[];
      }};
    };
    const own=await read("member");
    expect(own.status).toBe(200);
    expect(own.body.installations.map(row=>({id:row.id,resource:row.resource,state:row.state,credential_ready:row.credential_ready}))).toEqual([
      {id:"design",resource:RESOURCE,state:"enabled",credential_ready:true},
      {id:"other",resource:OTHER_RESOURCE,state:"enabled",credential_ready:true}
    ]);
    expect(own.body.consents).toEqual([]);
    expect(own.body.activity).toEqual([]);
    expect(JSON.stringify(own.body).includes("synthetic-stitch-key")).toBe(false);
    expect(JSON.stringify(own.body).includes("credential_ref")).toBe(false);
    for(const subject of ["other","admin"]) {
      const foreign=await read(subject);
      expect(foreign.status).toBe(200);
      expect(foreign.body).toEqual({installations:[],consents:[],activity:[]});
    }
  } finally {await fixture.dispose();}
},20000);

it("hides transport after access removal but still lets its owner revoke the recorded client",async()=>{
  const f=await oauthFixture();
  try {
    const auth=await authorizedTokens(f);
    const resource=await resourceRequest(f,auth.tokens.access_token);expect(resource.status).toBe(200);await resource.text();
    const read=async()=>{
      const r=await f.runtime.dispatchFetch(`${ISSUER}/runtime/integrations`,{headers:{Cookie:f.cookies.get("member")!}});
      return await r.json() as {installations:Array<{id:string}>;consents:Array<{id:string;installation:string}>;activity:Array<{installation:string}>};
    };
    const recorded=(await read()).consents.find(c=>c.installation==="design")!;
    const revoke=await f.runtime.dispatchFetch("https://api.trustedtunnel.app/admin/runtime-installations/design/access/member",{method:"PUT",headers:{Authorization:"Bearer synthetic-operator","Content-Type":"application/json"},body:JSON.stringify({state:"revoked",expectedRevision:1,expiresAt:null})});
    expect(revoke.status).toBe(200);await revoke.body?.cancel();
    const after=await read();expect(after.installations.map(i=>i.id)).toEqual(["other"]);expect(after.activity.some(a=>a.installation==="design")).toBe(false);
    expect(after.consents.some(c=>c.id===recorded.id)).toBe(true);
    const list=await f.runtime.dispatchFetch(`${ISSUER}/admin?area=me&view=integrations`,{headers:{Cookie:f.cookies.get("member")!,Accept:"text/html"}});
    expect((await list.text()).includes("已无组织权限，后续调用被拒绝")).toBe(true);
    const result=await f.runtime.dispatchFetch(`${ISSUER}/me/ui/runtime-clients/${recorded.id}/revoke`,{method:"POST",headers:{Cookie:f.cookies.get("member")!,Origin:ISSUER,"Content-Type":"application/x-www-form-urlencoded"},body:new URLSearchParams({confirm:"1",installation:"design"}).toString()});
    expect(result.status).toBe(200);await result.body?.cancel();
    expect((await read()).consents.some(c=>c.id===recorded.id)).toBe(false);
  } finally {await f.dispose();}
},20000);

it("uses the guarded lifecycle for native admin forms and distinguishes rotation from rebind",async()=>{
  const f=await oauthFixture();
  try {
    const authorized=await authorizedTokens(f);
    const post=(body:Record<string,string>,member="admin",origin=ISSUER)=>f.runtime.dispatchFetch(`${ISSUER}/admin/ui/runtime-installations/design`,{
      method:"POST",headers:{Cookie:f.cookies.get(member)!,Origin:origin,Accept:"text/html","Content-Type":"application/x-www-form-urlencoded"},body:new URLSearchParams({...body,confirm:"1"}).toString()
    });
    const row=()=>f.db.prepare("SELECT label,state,revision,authority_revision FROM runtime_installations WHERE id='design'").first<{label:string;state:string;revision:number;authority_revision:number}>();
    const initial=(await row())!;
    const page=await f.runtime.dispatchFetch(`${ISSUER}/admin?view=runtime&installation=design`,{headers:{Cookie:f.cookies.get("admin")!,Accept:"text/html"}});
    const html=await page.text();expect(page.status).toBe(200);
    expect(html.includes('type="password"')).toBe(true);expect(html.includes('value="synthetic-stitch-key"')).toBe(false);
    expect(html.includes("更换同一账号的凭据")).toBe(true);expect(html.includes("绑定新的上游账号")).toBe(true);
    const rename={action:"rename",expectedRevision:String(initial.revision),operationId:"ui-rename",label:"Reviewed design"};
    for(const [member,origin] of [["member",ISSUER],["admin","https://attacker.example.test"]]) {
      const denied=await post(rename,member!,origin);expect(denied.status).toBe(403);await denied.body?.cancel();
    }
    expect(await row()).toEqual(initial);
    const changed=await post(rename);expect(changed.status).toBe(200);expect((await changed.text()).includes("工具服务操作已完成")).toBe(true);
    expect((await row())!.label).toBe("Reviewed design");
    const stale=await post(rename);expect(stale.status).toBe(403);expect((await stale.text()).includes('data-console-outcome="unknown"')).toBe(true);
    // JSON and native forms admit the same maximum decoded header value, even
    // when form percent encoding triples its size. Only a scalar can be logged.
    const material="%".repeat(4096);
    const rotate=await post({action:"supply",expectedRevision:String((await row())!.revision),operationId:"ui-rotate",authority:"same",material});
    expect(rotate.status).toBe(200);expect((await rotate.text()).includes(material)).toBe(false);
    expect((await row())!.authority_revision).toBe(initial.authority_revision);
    const retained=await resourceRequest(f,authorized.tokens.access_token);expect(retained.status).toBe(200);await retained.body?.cancel();
    const rebind=await post({action:"supply",expectedRevision:String((await row())!.revision),operationId:"ui-rebind",authority:"rebind",material:"different-synthetic-authority"});
    expect(rebind.status).toBe(200);await rebind.body?.cancel();
    expect((await row())!.authority_revision).toBe(initial.authority_revision+1);
    const old=await resourceRequest(f,authorized.tokens.access_token);expect(old.status).toBe(403);expect(await old.json()).toEqual({error:"access_denied"});
    const granted=await post({action:"access",expectedRevision:"0",subject:"other",state:"granted",expiresAt:""});expect(granted.status).toBe(200);await granted.body?.cancel();
    const permitted=await f.runtime.dispatchFetch(`${ISSUER}/runtime/integrations`,{headers:{Cookie:f.cookies.get("other")!}});
    expect((await permitted.json() as {installations:Array<{id:string}>}).installations.map(i=>i.id)).toEqual(["design"]);
    const revoked=await post({action:"access",expectedRevision:"1",subject:"other",state:"revoked",expiresAt:""});expect(revoked.status).toBe(200);await revoked.body?.cancel();
    const hidden=await f.runtime.dispatchFetch(`${ISSUER}/runtime/integrations`,{headers:{Cookie:f.cookies.get("other")!}});
    expect((await hidden.json() as {installations:unknown[]}).installations).toEqual([]);
  } finally {await f.dispose();}
},20000);

it("revokes only the member's own client with a native form and keeps other authority usable",async()=>{
  const f=await oauthFixture();
  try {
    const design=await authorizedTokens(f);
    const other=await authorizedTokens(f,OTHER_RESOURCE);
    const read=async(member="member")=>{
      const r=await f.runtime.dispatchFetch(`${ISSUER}/runtime/integrations`,{headers:{Cookie:f.cookies.get(member)!}});
      return await r.json() as {consents:Array<{id:string;installation:string}>;activity:unknown[]};
    };
    const id=(await read()).consents.find(c=>c.installation==="design")!.id;
    const revoke=(member:string,origin=ISSUER)=>f.runtime.dispatchFetch(`${ISSUER}/me/ui/runtime-clients/${id}/revoke`,{
      method:"POST",headers:{Cookie:f.cookies.get(member)!,Origin:origin,Accept:"text/html","Content-Type":"application/x-www-form-urlencoded"},
      body:new URLSearchParams({installation:"design",confirm:"1"}).toString()
    });
    for(const [member,origin] of [["other",ISSUER],["member","https://attacker.example.test"]]) {
      const denied=await revoke(member!,origin);expect(denied.status).toBeGreaterThanOrEqual(400);await denied.body?.cancel();
    }
    const before=await resourceRequest(f,design.tokens.access_token);expect(before.status).toBe(200);await before.body?.cancel();
    const result=await revoke("member");const html=await result.text();
    expect(result.status).toBe(200);expect(html.includes('data-dashboard-mutation="runtime_revoked"')).toBe(true);
    expect((await read()).consents.map(c=>c.installation)).toEqual(["other"]);
    const denied=await resourceRequest(f,design.tokens.access_token);expect(denied.status).toBe(401);await denied.body?.cancel();
    const unaffected=await resourceRequest(f,other.tokens.access_token,OTHER_RESOURCE);expect(unaffected.status).toBe(200);await unaffected.body?.cancel();
    expect((await read("other")).activity).toEqual([]);
  } finally {await f.dispose();}
},20000);

it("offers URL-only setup and distinct authorization facts in the actual personal page",async()=>{
  const fixture=await oauthFixture();
  try {
    const response=await fixture.runtime.dispatchFetch(`${ISSUER}/admin?area=me&view=integrations&installation=design`,{
      headers:{Cookie:fixture.cookies.get("member")!,Accept:"text/html"}
    });
    const html=await response.text();
    expect(response.status).toBe(200);
    expect(html.includes('[mcp_servers.design]')).toBe(true);
    expect(html.includes(`url = &quot;${RESOURCE}&quot;`)).toBe(true);
    expect(html.includes("codex mcp login design")).toBe(true);
    expect(html.includes("本地 OAuth token")).toBe(true);
    expect(html.includes("尚无客户端授权")).toBe(true);
    expect(html.includes("尚无传输记录")).toBe(true);
    expect(html.includes("synthetic-stitch-key")).toBe(false);
    expect(html.includes("synthetic-catalog-key")).toBe(false);
  } finally {await fixture.dispose();}
},20000);
