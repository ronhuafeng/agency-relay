import {expect,it} from "vitest";
import {oauthFixture,authorizedTokens,resourceRequest,ISSUER,RESOURCE,OTHER_RESOURCE} from "./oauth-fixture";

it("configures both connectors through native forms and moves only the selected OAuth resource",async()=>{
  const dispatches:Array<{url:string;credential:boolean;tools:string|null;authorization:boolean}>=[];
  const f=await oauthFixture(undefined,{editablePaths:true,upstream:async request=>{
    dispatches.push({url:request.url,credential:request.headers.get("X-Connector-Key")==="fixture-credential",
      tools:request.headers.get("X-Lark-MCP-Allowed-Tools"),authorization:request.headers.has("Authorization")});
    await request.body?.cancel();
    return new Response("{}",{headers:{"Content-Type":"application/json"}});
  }});
  const origin=new URL(RESOURCE).origin;
  const docs=`${origin}/project-docs`;
  const moved=`${origin}/team-docs`;
  const headers={Cookie:f.cookies.get("admin")!,Origin:ISSUER,Accept:"text/html","Content-Type":"application/x-www-form-urlencoded"};
  const post=(id:string,fields:Record<string,string>)=>f.runtime.dispatchFetch(`${ISSUER}/admin/ui/runtime-installations/${id}`,{
    method:"POST",headers,body:new URLSearchParams({...fields,confirm:"1"}).toString()
  });
  const send=async(id:string,fields:Record<string,string>)=>{
    const response=await post(id,fields);
    expect(response.status).toBe(200);
    expect((await response.text()).includes("fixture-credential")).toBe(false);
  };
  const request=(resource:string,token?:string)=>f.runtime.dispatchFetch(resource,{method:"POST",headers:{
    ...(token?{Authorization:`Bearer ${token}`} : {}),"X-Connector-Key":"client-header","X-Lark-MCP-Allowed-Tools":"create-doc"
  },body:"{}"});
  const expectStatus=async(response:Response,status:number)=>{expect(response.status).toBe(status);await response.body?.cancel();};
  try {
    const page=await f.runtime.dispatchFetch(`${ISSUER}/admin?view=runtime&installation=lark-doc`,{headers});
    expect(page.status).toBe(200);
    expect((await page.text()).includes('name="path"')).toBe(true);
    await send("google-stitch",{action:"configure",path:"/google-stitch"});
    const duplicate=await post("lark-doc",{action:"configure",path:"/google-stitch"});
    expect(duplicate.status).toBe(409);
    expect((await duplicate.text()).includes('data-error-code="runtime_path_taken"')).toBe(true);
    await send("lark-doc",{action:"configure",path:"/project-docs"});
    for(const id of ["google-stitch","lark-doc"]) {
      await send(id,{action:"supply",expectedRevision:"1",operationId:"bind",authority:"rebind",credentialHeader:"X-Connector-Key",material:"fixture-credential"});
      await send(id,{action:"enable",expectedRevision:"2",operationId:"enable"});
      await send(id,{action:"access",expectedRevision:"0",subject:"member",state:"granted",expiresAt:""});
    }
    const stitch=await authorizedTokens(f,RESOURCE);
    const lark=await authorizedTokens(f,docs);
    await expectStatus(await post("lark-doc",{action:"supply",expectedRevision:"3",operationId:"header-rotation",
      authority:"same",credentialHeader:"X-Other-Key",material:"fixture-credential"}),400);
    await expectStatus(await request(docs,lark.tokens.access_token),200);
    expect(dispatches).toEqual([{url:"https://mcp.feishu.cn/mcp",credential:true,tools:"fetch-doc",authorization:false}]);

    const move={action:"path",expectedRevision:"3",operationId:"move",path:"/team-docs"};
    await send("lark-doc",move);
    await expectStatus(await request(docs,lark.tokens.access_token),404);
    await expectStatus(await request(moved,lark.tokens.access_token),401);
    const reuse=await post("google-stitch",{...move,path:"/project-docs"});
    await expectStatus(reuse,409);
    await expectStatus(await request(RESOURCE,stitch.tokens.access_token),200);
    expect(dispatches[1]).toEqual({url:"https://stitch.googleapis.com/mcp",credential:true,tools:null,authorization:false});
    const next=await authorizedTokens(f,moved);
    await expectStatus(await request(moved,next.tokens.access_token),200);
  } finally {await f.dispose();}
},20000);

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

// An unknown selection is a missing object. Wrong: reporting a failed read with a retry
// link, or selecting another declared service in its place.
it("answers an unknown tool service selection as missing, without a retry or substitute",async()=>{
  const f=await oauthFixture();
  try {
    const page=await f.runtime.dispatchFetch(`${ISSUER}/admin?view=runtime&installation=retired-service`,{headers:{Cookie:f.cookies.get("admin")!,Accept:"text/html"}});
    const html=await page.text();
    expect(page.status).toBe(404);
    expect(html.includes("data-runtime-missing")).toBe(true);
    expect(html.includes('id="runtime-detail"')).toBe(false);
    expect(html.includes("data-console-revision")).toBe(false);
    const known=await f.runtime.dispatchFetch(`${ISSUER}/admin?view=runtime&installation=design`,{headers:{Cookie:f.cookies.get("admin")!,Accept:"text/html"}});
    expect(known.status).toBe(200);expect((await known.text()).includes('id="runtime-detail"')).toBe(true);
  } finally { await f.dispose(); }
});

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
    expect(html.includes('name="authority" value="same"')).toBe(true);expect(html.includes('name="authority" value="rebind"')).toBe(true);
    const rename={action:"rename",expectedRevision:String(initial.revision),operationId:"ui-rename",label:"Reviewed design"};
    for(const [member,origin] of [["member",ISSUER],["admin","https://attacker.example.test"]]) {
      const denied=await post(rename,member!,origin);expect(denied.status).toBe(403);await denied.body?.cancel();
    }
    expect(await row()).toEqual(initial);
    const changed=await post(rename);expect(changed.status).toBe(200);expect((await changed.text()).includes('data-dashboard-mutation="runtime_changed"')).toBe(true);
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

it("keeps a confirmed access write known when the installation page cannot be read",async()=>{
  const f=await oauthFixture();
  try {
    const failure=await f.expire("fail-installation-read","true");await failure.body?.cancel();
    const response=await f.runtime.dispatchFetch(`${ISSUER}/admin/ui/runtime-installations/design`,{
      method:"POST",headers:{Cookie:f.cookies.get("admin")!,Origin:ISSUER,Accept:"text/html","Content-Type":"application/x-www-form-urlencoded"},
      body:new URLSearchParams({action:"access",confirm:"1",expectedRevision:"0",subject:"other",state:"granted",expiresAt:""}).toString()
    });
    const html=await response.text();
    expect(response.status).toBe(503);
    expect(html.includes('data-dashboard-mutation="runtime_changed"')).toBe(true);
    expect(html.includes('data-console-outcome="unknown"')).toBe(false);
    const consumer=await f.runtime.dispatchFetch(`${ISSUER}/runtime/integrations`,{headers:{Cookie:f.cookies.get("other")!}});
    expect(consumer.status).toBe(200);
    expect((await consumer.json() as {installations:Array<{id:string}>}).installations.map(i=>i.id)).toEqual(["design"]);
    expect(await f.db.prepare("SELECT revision,state FROM runtime_installation_access WHERE installation_id='design' AND user_id='other'").first()).toEqual({revision:1,state:"granted"});
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
