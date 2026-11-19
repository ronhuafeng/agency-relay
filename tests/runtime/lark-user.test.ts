import {createHash} from "node:crypto";
import {expect,it} from "vitest";
import {authorizedTokens,ISSUER,oauthFixture,pendingConsent,RESOURCE,tokenRequest} from "./oauth-fixture";
import {larkToolPage} from "../../src/runtime/connectors/lark-doc/mcp";
import {larkTools} from "../../src/runtime/connectors/lark-doc/profile";

const resource=`${new URL(RESOURCE).origin}/feishu-docs`;
const callbackPath="/runtime/feishu-user/callback";
const memberPath="/runtime/feishu-user/lark-doc";
const scopes="offline_access search:docs:read wiki:wiki:readonly contact:user:search";
const tenantGrant="fixture-tenant";
const members=["member","other"] as const;
const calendar="calendar.v4.calendar.get";

it("returns every discoverable tool across bounded catalog pages",async()=>{
  const available=Array.from({length:5},(_,index)=>({name:`tool-${index}`,description:"x".repeat(80_000)}));
  const seen:string[]=[];
  let cursor:string|undefined="0";
  while(cursor!==undefined){
    const {response:reply,toolCount}=larkToolPage(1,available,Number(cursor));
    const result=(await reply.json() as {result:{tools:Array<{name:string}>;nextCursor?:string}}).result;
    expect(result.tools).toHaveLength(1);
    expect(toolCount).toBe(1);
    if(result.nextCursor!==undefined)expect(Number(result.nextCursor)).toBeGreaterThan(Number(cursor));
    seen.push(result.tools[0]!.name);
    cursor=result.nextCursor;
  }
  expect(seen).toEqual(available.map(tool=>tool.name));
});

it("enforces live tool switches, per-client review and UAT-first routing across refresh and disconnect",async()=>{
  const challenges=new Map<string,string>();
  const exchanges:string[]=[];
  const rotations:string[]=[];
  const apiActors:string[]=[];
  let calendarScope=false;
  let appCalendarScope=false;
  const calls:Array<{actor:string;method:string;tool?:string}>=[];
  let holdRotation=false;
  let markHeld!:()=>void;
  let release!:()=>void;
  const held=new Promise<void>(resolve=>{markHeld=resolve;});
  const untilReleased=new Promise<void>(resolve=>{release=resolve;});
  const credentials=(member:string,version:number)=>({code:0,access_token:`fixture-access-${member}-${version}`,
    refresh_token:`fixture-refresh-${member}-${version}`,expires_in:version===0?30:version===1?120:7200,refresh_token_expires_in:86400,
    scope:member==="member"?`${scopes} docx:document:readonly task:task:read im:chat:read${calendarScope?" calendar:calendar:read":""}`:scopes});
  const f=await oauthFixture(undefined,{editablePaths:true,upstream:async request=>{
    const path=new URL(request.url).pathname;
    if(path.endsWith("/tenant_access_token/internal"))return Response.json({code:0,tenant_access_token:tenantGrant,expire:7200});
    if(path==="/oauth/v3/token") {
      const form=await request.json() as Record<string,string>;
      expect(form.client_id==="cli_journey"&&form.client_secret==="fixture-app-secret").toBe(true);
      if(form.grant_type==="client_credentials")
        return Response.json({code:0,access_token:"fixture-openapi-tenant",expires_in:10,
          ...(appCalendarScope?{scope:"calendar:calendar:readonly"}:{})});
      if(form.grant_type==="authorization_code") {
        exchanges.push(form.code!);
        expect(createHash("sha256").update(form.code_verifier!).digest("base64url")===challenges.get(form.code!)).toBe(true);
        expect(form.redirect_uri).toBe(ISSUER+callbackPath);
        return Response.json(credentials(form.code!,0));
      }
      const match=/^fixture-refresh-(member|other)-(\d+)$/.exec(form.refresh_token??"");
      expect(Boolean(match)).toBe(true);
      const member=match![1]!;
      const version=Number(match![2]);
      rotations.push(member);
      if(holdRotation&&member==="other"){markHeld();await untilReleased;}
      return Response.json(credentials(member,version+1));
    }
    if(path.endsWith("/user_info")) {
      const member=request.headers.get("Authorization")?.replace(/^Bearer fixture-access-|-0$/g,"");
      return Response.json({code:0,data:{tenant_key:"fixture-tenant",enterprise_email:`${member==="wrong-account"?"other":member}@example.test`}});
    }
    if(path.startsWith("/open-apis/calendar/")) {
      expect(request.url).toBe("https://open.feishu.cn/open-apis/calendar/v4/calendars/calendar-example");
      expect(request.method).toBe("GET");
      expect(request.headers.has("X-Lark-MCP-Allowed-Tools")).toBe(false);
      const bearer=request.headers.get("Authorization")??"";
      apiActors.push(bearer==="Bearer fixture-openapi-tenant"?"app":/^Bearer fixture-access-member-\d+$/.test(bearer)?"member":"unexpected");
      return Response.json({code:0,data:{calendar:{summary:"Synthetic calendar"}}});
    }
    expect(request.url).toBe("https://mcp.feishu.cn/mcp");
    const app=request.headers.get("X-Lark-MCP-TAT")===tenantGrant;
    const personal=request.headers.get("X-Lark-MCP-UAT");
    const member=/^fixture-access-(member|other)-[1-9]\d*$/.exec(personal??"")?.[1];
    expect(Boolean(app)!==Boolean(member)).toBe(true);
    expect(request.headers.has("Authorization")).toBe(false);
    const selected=request.headers.get("X-Lark-MCP-Allowed-Tools")?.split(",")??[];
    const rpc=await request.json() as {id:number;method:string;params?:{name?:string;protocolVersion?:string;arguments?:{query?:string}}};
    if(rpc.method==="initialize") {
      expect(app).toBe(true);
      expect(rpc.params?.protocolVersion).toBe("2025-11-25");
      return Response.json({jsonrpc:"2.0",id:rpc.id,result:{protocolVersion:"2025-03-26",capabilities:{tools:{}},
        serverInfo:{name:"Synthetic Feishu",version:"1"}}});
    }
    calls.push({actor:app?"app":member!,method:rpc.method,...(rpc.params?.name?{tool:rpc.params.name}:{})});
    if(rpc.method==="tools/list") {
      const names=[...selected,"update-doc"];
      return Response.json({jsonrpc:"2.0",id:rpc.id,result:{tools:names.map(name=>({name,inputSchema:{type:"object"}}))}});
    }
    expect(selected).toEqual([rpc.params?.name]);
    if(rpc.params?.arguments?.query==="forbidden")return new Response(null,{status:403});
    return Response.json({jsonrpc:"2.0",id:rpc.id,result:{content:[]}});
  }});
  const session=(member:string)=>({Cookie:f.cookies.get(member)!});
  const write=(member:string,action:string,origin=ISSUER)=>f.runtime.dispatchFetch(`${ISSUER}${memberPath}/${action}`,{
    method:"POST",headers:{...session(member),Origin:origin},redirect:"manual"
  }) as Promise<Response>;
  const start=async(member:string,code=member,expectedScopes=scopes.split(" "))=>{
    const response=await write(member,"connect");
    expect(response.status).toBe(200);
    const html=await response.text();
    const href=html.match(/href="(https:\/\/accounts\.feishu\.cn\/[^"]+)"/)?.[1];
    expect(Boolean(href)).toBe(true);
    const query=new URL(href!.replaceAll("&amp;","&")).searchParams;
    expect(query.get("code_challenge_method")).toBe("S256");
    expect(query.get("scope")?.split(" ")).toEqual(expect.arrayContaining(expectedScopes));
    challenges.set(code,query.get("code_challenge")!);
    return ISSUER+callbackPath+"?"+new URLSearchParams({code,state:query.get("state")!});
  };
  const finish=async(url:string,member:string)=>{
    const response=await f.runtime.dispatchFetch(url,{headers:session(member),redirect:"manual"});
    await response.body?.cancel();
    expect(response.status).toBe(303);
    return response.headers.get("Location");
  };
  const rpc=(token:string,method:string,tool?:string,headers:Record<string,string>={},query="example")=>f.runtime.dispatchFetch(resource,{method:"POST",
    headers:{Authorization:`Bearer ${token}`,"Content-Type":"application/json","X-Lark-MCP-UAT":"forged","X-Lark-MCP-TAT":"forged",
      "X-Lark-MCP-Allowed-Tools":"update-doc",...headers},
    body:JSON.stringify({jsonrpc:"2.0",id:7,method,...(tool?{params:{name:tool,arguments:{query}}}:{})})
  }) as Promise<Response>;
  const status=async(response:Response)=>{await response.body?.cancel();return response.status;};
  const calendarCall=(token:string,calendarId:string)=>f.runtime.dispatchFetch(resource,{method:"POST",
    headers:{Authorization:`Bearer ${token}`,"Content-Type":"application/json"},
    body:JSON.stringify({jsonrpc:"2.0",id:7,method:"tools/call",params:{name:calendar,arguments:{path:{calendar_id:calendarId}}}})
  }) as Promise<Response>;
  const names=async(response:Response)=>{
    expect(response.status).toBe(200);
    return (await response.json() as {result:{tools:Array<{name:string}>}}).result.tools.map(tool=>tool.name);
  };
  try {
    for(const change of [{action:"configure"},{action:"supply",authority:"rebind",operationId:"bind-app",expectedRevision:1,
      appId:"cli_journey",appSecret:"fixture-app-secret"},{action:"enable",operationId:"enable",expectedRevision:2}]) {
      expect(await status(await f.admin("lark-doc",change))).toBe(200);
    }
    for(const member of members) {
      const response=await f.runtime.dispatchFetch(`https://api.trustedtunnel.app/admin/runtime-installations/lark-doc/access/${member}`,{method:"PUT",
        headers:{Authorization:"Bearer synthetic-operator","Content-Type":"application/json"},
        body:JSON.stringify({state:"granted",expectedRevision:0,expiresAt:null})});
      expect(await status(response)).toBe(200);
    }
    expect(await status(await write("member","connect","https://foreign.example.test"))).toBe(403);
    const premature=await pendingConsent(f,resource);
    expect(await status(await premature.decide())).toBe(403);
    const wrong=await start("member","wrong-account");
    expect(await finish(wrong,"member")).toBe(memberPath+"/failed");
    const own=await start("member");
    expect(await finish(own,"other")).toBe(memberPath+"/failed");
    expect(exchanges).toEqual(["wrong-account"]);
    expect(await finish(own,"member")).toContain("installation=lark-doc");
    expect(await finish(own,"member")).toBe(memberPath+"/failed");
    const page=await f.runtime.dispatchFetch(`${ISSUER}/admin?area=me&view=integrations&installation=lark-doc`,{headers:session("member")});
    expect((await page.text()).includes("断开飞书账号")).toBe(true);
    expect(await finish(await start("other"),"other")).toContain("installation=lark-doc");
    const grant=await authorizedTokens(f,resource,"member");
    const refreshed=await tokenRequest(f,{grant_type:"refresh_token",client_id:grant.clientId,resource,refresh_token:grant.tokens.refresh_token});
    expect(refreshed.status).toBe(200);
    const personal=(await refreshed.json() as {access_token:string}).access_token;
    const other=(await authorizedTokens(f,resource,"other")).tokens.access_token;
    expect(rotations).toEqual([]);
    expect(await Promise.all((["search-doc","search-user"] as const).map(async name=>status(await rpc(personal,"tools/call",name))))).toEqual([200,200]);
    expect(rotations).toEqual(["member"]);
    const initialized=await f.runtime.dispatchFetch(resource,{method:"POST",
      headers:{Authorization:`Bearer ${personal}`,"Content-Type":"application/json"},
      body:JSON.stringify({jsonrpc:"2.0",id:1,method:"initialize",params:{protocolVersion:"2025-11-25",capabilities:{},
        clientInfo:{name:"Synthetic client",version:"1"}}})});
    expect(initialized.status).toBe(200);
    const {result}=await initialized.json() as {result:{protocolVersion:string}};
    expect(result.protocolVersion).toBe("2025-03-26");
    expect(await names(await rpc(personal,"tools/list",undefined,{"Mcp-Protocol-Version":result.protocolVersion})))
      .toEqual(["search-doc","fetch-doc","search-user"]);
    expect(await status(await rpc(personal,"tools/call","fetch-doc"))).toBe(200);
    expect(await status(await rpc(other,"tools/call","fetch-doc"))).toBe(200);
    expect(await names(await rpc(other,"tools/list"))).toEqual(["search-doc","fetch-doc","search-user"]);
    expect(calls.filter(call=>call.tool).sort((a,b)=>a.actor.localeCompare(b.actor)||a.tool!.localeCompare(b.tool!))).toEqual([
      {actor:"app",method:"tools/call",tool:"fetch-doc"},{actor:"member",method:"tools/call",tool:"fetch-doc"},
      {actor:"member",method:"tools/call",tool:"search-doc"},{actor:"member",method:"tools/call",tool:"search-user"}
    ]);
    const attempts=calls.length;
    expect(await status(await rpc(personal,"tools/call","fetch-doc",{},"forbidden"))).toBe(502);
    expect(calls.slice(attempts)).toEqual([{actor:"member",method:"tools/call",tool:"fetch-doc"}]);
    const before=calls.length;
    expect(await status(await rpc(personal,"tools/call","search-doc",{"Mcp-Name":"fetch-doc"}))).toBe(400);
    expect(await status(await rpc(personal,"tools/call","update-doc"))).toBe(400);
    expect(calls).toHaveLength(before);
    await status(await f.expire("advance-lark-token-clock",String(120_000)));
    holdRotation=true;
    const delayed=rpc(other,"tools/call","search-doc");
    expect(await Promise.race([held.then(()=>"refreshing"),delayed.then(async response=>`completed with HTTP ${await status(response)}`)])).toBe("refreshing");
    try {
      expect(await status(await write("other","disconnect"))).toBe(303);
    } finally {release();}
    expect(await status(await delayed)).toBe(403);
    expect(await status(await rpc(other,"tools/call","search-doc"))).toBe(403);
    expect(calls).toHaveLength(before);
    expect(await names(await rpc(other,"tools/list"))).toEqual([]);
    expect(await status(await rpc(personal,"tools/call","search-doc"))).toBe(200);

    const stale=await pendingConsent(f,resource);
    const reviewed=await stale.review();
    const save=await f.runtime.dispatchFetch(`${ISSUER}/admin/ui/runtime-installations/lark-doc`,{method:"POST",
      headers:{...session("admin"),Origin:ISSUER,Accept:"text/html","Content-Type":"application/x-www-form-urlencoded"},
      body:new URLSearchParams({action:"tools",confirm:"1",expectedRevision:"3",operationId:"tools-1","tool.search-doc":"1","tool.add-comments":"1"})});
    expect(save.status).toBe(200);
    const html=await save.text();
    expect(html.includes("查看和添加评论")&&html.includes("docs:document.comment:create")).toBe(true);
    expect(await status(await stale.decide("allow",ISSUER,reviewed))).toBe(403);
    expect(await names(await rpc(personal,"tools/list"))).toEqual(["search-doc"]);
    expect(await status(await rpc(personal,"tools/call","fetch-doc"))).toBe(400);
    expect(await status(await rpc(personal,"tools/call","add-comments"))).toBe(400);
    const latest=await authorizedTokens(f,resource);
    const updated=latest.tokens.access_token;
    expect(await names(await rpc(updated,"tools/list"))).toEqual(["search-doc","add-comments"]);
    expect(await status(await rpc(updated,"tools/call","add-comments"))).toBe(200);
    expect(calls.at(-1)).toEqual({actor:"app",method:"tools/call",tool:"add-comments"});
    await status(await f.expire("legacy-feishu-consent",latest.clientId));
    expect(await status(await rpc(updated,"tools/list"))).toBe(403);
    expect(await status(await tokenRequest(f,{grant_type:"refresh_token",client_id:latest.clientId,resource,
      refresh_token:latest.tokens.refresh_token}))).toBe(400);

    const openApiSwitch=await f.runtime.dispatchFetch(`${ISSUER}/admin/ui/runtime-installations/lark-doc`,{
      method:"POST",headers:{...session("admin"),Origin:ISSUER,Accept:"text/html","Content-Type":"application/x-www-form-urlencoded"},
      body:new URLSearchParams({action:"tools",confirm:"1",expectedRevision:"4",operationId:"calendar",[`tool.${calendar}`]:"1",
        "tool.search-doc":"1","tool.add-comments":"1"})
    });
    expect(await status(openApiSwitch)).toBe(200);
    expect(await status(await calendarCall(personal,"calendar-example"))).toBe(400);
    calendarScope=true;
    const updatedScopes=["offline_access","search:docs:read","docs:document.comment:create","calendar:calendar:readonly"];
    expect(await finish(await start("member","member",updatedScopes),"member")).toContain("installation=lark-doc");
    expect(await finish(await start("other","other",updatedScopes),"other")).toContain("installation=lark-doc");
    const reviewedMember=(await authorizedTokens(f,resource)).tokens.access_token;
    const reviewedOther=(await authorizedTokens(f,resource,"other")).tokens.access_token;
    const list=await rpc(reviewedMember,"tools/list");
    const toolList=await list.json() as {result:{tools:Array<{name:string;inputSchema?:{properties?:Record<string,unknown>}}>}};
    expect(toolList.result.tools.map(tool=>tool.name).sort()).toEqual(["add-comments",calendar,"search-doc"]);
    expect(Boolean(toolList.result.tools.find(tool=>tool.name===calendar)?.inputSchema?.properties?.path)).toBe(true);
    expect((await names(await rpc(reviewedOther,"tools/list"))).includes(calendar)).toBe(false);
    expect(await status(await calendarCall(reviewedOther,"calendar-example"))).toBe(403);
    const content=await calendarCall(reviewedMember,"calendar-example");
    expect(content.status).toBe(200);
    expect((await content.text()).includes("Synthetic calendar")).toBe(true);
    expect(await status(await calendarCall(reviewedMember,"../another-api"))).toBe(400);
    appCalendarScope=true;
    await status(await f.expire("advance-lark-token-clock",String(11_000)));
    expect((await names(await rpc(reviewedOther,"tools/list"))).includes(calendar)).toBe(true);
    expect(await status(await calendarCall(reviewedOther,"calendar-example"))).toBe(200);
    expect(apiActors).toEqual(["member","app"]);

    const all=new URLSearchParams({action:"tools",confirm:"1",expectedRevision:"5",operationId:"all-tools"});
    for(const tool of larkTools)all.set(`tool.${tool.name}`,"1");
    expect(all.toString().length).toBeGreaterThan(16*1024);
    const savedAll=await f.runtime.dispatchFetch(`${ISSUER}/admin/ui/runtime-installations/lark-doc`,{
      method:"POST",headers:{...session("admin"),Origin:ISSUER,Accept:"text/html","Content-Type":"application/x-www-form-urlencoded"},body:all
    });
    expect(await status(savedAll)).toBe(200);
    const settings=await f.db.prepare("SELECT json_array_length(feishu_tools) AS count FROM runtime_installations WHERE id='lark-doc'").first();
    expect(settings?.count).toBe(larkTools.length);
  } finally {release();await f.dispose();}
},20000);
