import {expect,it,vi} from "vitest";
import {oauthFixture,authorizedTokens,RESOURCE,OTHER_RESOURCE} from "./oauth-fixture";
import {admitRuntimeRequest} from "../../src/runtime/authorization";
import {createConsoleSession} from "../../src/auth/console-session";

// Owning seam: actual Worker HTTP admission -> exact secret owner -> external
// MCP. Accept a request-scoped JSON exchange; reject body/target/credential
// corruption. Equivalent transport implementations need not share helpers.
it("relays exact JSON bytes and metadata to the reviewed profile with isolated credentials",async()=>{
  const payload=new TextEncoder().encode(' {"jsonrpc":"2.0", "id":7, "method":"tools/list"}\n');
  const output=new Uint8Array([32,123,34,120,34,58,49,125,10]);
  const seen:{url:string;isolated:boolean;credential:boolean;bytes:boolean;method:string|null}[]=[];
  const f=await oauthFixture(undefined,{upstream:async request=>{
    seen.push({url:request.url,isolated:!["Authorization","Cookie","X-Api-Key","X-Mini-Route","X-OpenAI-Actor-Authorization"].some(name=>request.headers.has(name)),
      credential:request.headers.get("X-Goog-Api-Key")==="synthetic-stitch-key",bytes:Buffer.from(await request.arrayBuffer()).equals(payload),method:request.headers.get("Mcp-Method")});
    return new Response(output,{headers:{"Content-Type":"application/json","X-Goog-Api-Key":"synthetic-secret","WWW-Authenticate":"synthetic-challenge","Set-Cookie":"synthetic-cookie","Mcp-Protocol-Version":"2026-07-28"}});
  }});
  try{
    const a=await authorizedTokens(f);
    const response=await f.runtime.dispatchFetch(RESOURCE,{method:"POST",headers:{Authorization:`Bearer ${a.tokens.access_token}`,Cookie:"caller-cookie","X-Api-Key":"caller-key","X-Goog-Api-Key":"caller-key","X-Mini-Route":"caller-route","X-OpenAI-Actor-Authorization":"caller-actor","Mcp-Protocol-Version":"2026-07-28","Mcp-Method":"tools/list","Content-Type":"application/json",Accept:"application/json, text/event-stream"},body:payload});
    expect(response.status).toBe(200);
    expect(Buffer.from(await response.arrayBuffer()).equals(output)).toBe(true);
    expect(seen).toEqual([{url:"https://stitch.googleapis.com/mcp",isolated:true,credential:true,bytes:true,method:"tools/list"}]);
    expect(response.headers.get("Mcp-Protocol-Version")).toBe("2026-07-28");
    expect(["X-Goog-Api-Key","WWW-Authenticate","Set-Cookie"].some(name=>response.headers.has(name))).toBe(false);
  }finally{await f.dispose();}
},20000);

it("does not replace newer transport activity with a delayed older completion",async()=>{
  let source!:ReadableStreamDefaultController<Uint8Array>,calls=0;
  const f=await oauthFixture(undefined,{upstream:async request=>{
    await request.body?.cancel();
    if(++calls===2)return new Response(null,{status:202});
    return new Response(new ReadableStream<Uint8Array>({start(controller){source=controller;controller.enqueue(new Uint8Array([32]));}}),{headers:{"Content-Type":"text/event-stream"}});
  }});
  let response:Response|undefined;
  try{
    const a=await authorizedTokens(f),send=()=>f.runtime.dispatchFetch(RESOURCE,{method:"POST",headers:{Authorization:`Bearer ${a.tokens.access_token}`},body:"{}"}) as Promise<Response>;
    response=await send();
    expect((await send()).status).toBe(202);
    await vi.waitFor(async()=>expect((await inventory(f)).activity[0]?.upstream_status).toBe(202));
    const reading=response.arrayBuffer();source.close();await reading;
    await vi.waitFor(async()=>expect((await inventory(f)).leases).toBe(0));
    expect((await inventory(f)).activity[0]?.upstream_status).toBe(202);
  }finally{try{source?.close();}catch{/* already closed */}await response?.body?.cancel().catch(()=>undefined);await f.dispose();}
},20000);

it("caps one installation at sixteen leases across members and keeps another installation independent",async()=>{
  const responses:Response[]=[];
  const readings:Promise<PromiseSettledResult<ArrayBuffer>[]>[]=[];
  // Read as each response arrives, before later fixture requests can discard an
  // idle HTTP body. The upstream stays open, so its lease must stay occupied.
  const retain=(response:Response)=>{responses.push(response);readings.push(Promise.allSettled([response.arrayBuffer()]));};
  const sources:ReadableStreamDefaultController<Uint8Array>[]=[];
  let attempts=0;
  const f=await oauthFixture(undefined,{upstream:async request=>{attempts++;await request.body?.cancel();return new Response(new ReadableStream<Uint8Array>({start(controller){sources.push(controller);controller.enqueue(new Uint8Array([32]));}}),{headers:{"Content-Type":"text/event-stream"}});}});
  try{
    for(const member of ["second","third","fourth","fifth"]){
      await f.db.prepare("INSERT INTO users(id,email,canonical_email,account_kind,role,status,login_capable,created_at,updated_at) VALUES(?,?,?,'human','user','active',1,?,?)").bind(member,`${member}@example.test`,`${member}@example.test`,new Date().toISOString(),new Date().toISOString()).run();
      f.cookies.set(member,`__Host-mini-console=${await createConsoleSession(f.env,{id:member,email:`${member}@example.test`,sessionEpoch:0})}`);
      const granted=await f.runtime.dispatchFetch(`https://api.trustedtunnel.app/admin/runtime-installations/design/access/${member}`,{method:"PUT",headers:{Authorization:"Bearer synthetic-operator","Content-Type":"application/json"},body:JSON.stringify({state:"granted",expectedRevision:0,expiresAt:null})});
      expect(granted.status).toBe(200);
    }
    for(const member of ["member","second","third","fourth"]){
      const a=await authorizedTokens(f,RESOURCE,member);
      await Promise.all(Array.from({length:4},()=>f.runtime.dispatchFetch(RESOURCE,{method:"POST",headers:{Authorization:`Bearer ${a.tokens.access_token}`},body:"{}"}).then(retain)));
    }
    expect(responses.every(response=>response.status===200)).toBe(true);
    expect((await inventory(f)).leases).toBe(16);
    const extra=await authorizedTokens(f,RESOURCE,"fifth");
    expect((await f.runtime.dispatchFetch(RESOURCE,{method:"POST",headers:{Authorization:`Bearer ${extra.tokens.access_token}`},body:"{}"})).status).toBe(429);
    const other=await authorizedTokens(f,OTHER_RESOURCE);
    retain(await f.runtime.dispatchFetch(OTHER_RESOURCE,{method:"POST",headers:{Authorization:`Bearer ${other.tokens.access_token}`},body:"{}"}));
    expect(responses.at(-1)!.status).toBe(200);
    expect(attempts).toBe(17);
    expect((await inventory(f)).leases).toBe(17);
    for(const source of sources)source.close();
    expect((await Promise.all(readings)).flat().every(result=>result.status==="fulfilled")).toBe(true);
    await vi.waitFor(async()=>expect((await inventory(f)).leases).toBe(0));
  }finally{for(const source of sources)try{source.close();}catch{/* already closed */}await Promise.all(readings);await f.dispose();}
},20000);

it("rejects a known oversize request before dispatch and stops an unknown-length upload at eight MiB",async()=>{
  let attempts=0,received=0;
  const f=await oauthFixture(undefined,{upstream:async request=>{
    attempts++;
    const reader=request.body!.getReader();
    try{for(;;){const next=await reader.read();if(next.done)break;received+=next.value.byteLength;}}catch{/* upload was interrupted */}
    finally{await reader.cancel().catch(()=>undefined);}
    return new Response(null,{status:202});
  }});
  try{
    const a=await authorizedTokens(f),headers={Authorization:`Bearer ${a.tokens.access_token}`};
    const known=await f.runtime.dispatchFetch(RESOURCE,{method:"POST",headers,body:new Uint8Array(8*1024*1024+1)});
    expect(known.status).toBe(413);expect(attempts).toBe(0);
    let chunk=0;
    const body=new ReadableStream<Uint8Array>({pull(controller){if(chunk++<2)controller.enqueue(new Uint8Array(4*1024*1024));else if(chunk===3)controller.enqueue(new Uint8Array([1]));else controller.close();}},{highWaterMark:0});
    const unknown=await f.runtime.dispatchFetch(RESOURCE,{method:"POST",headers,body,duplex:"half"});
    expect(unknown.status).toBe(413);
    expect(attempts).toBe(1);expect(received<=8*1024*1024).toBe(true);
  }finally{await f.dispose();}
},20000);

it("does not substitute a re-bound credential for an already admitted request",async()=>{
  let attempts=0;
  const f=await oauthFixture(undefined,{upstream:async request=>{attempts++;await request.body?.cancel();return new Response(null,{status:202});}});
  let pending:Promise<Response>|undefined;
  try{
    const a=await authorizedTokens(f);
    expect((await f.expire("hold-read")).status).toBe(200);
    pending=f.runtime.dispatchFetch(RESOURCE,{method:"POST",headers:{Authorization:`Bearer ${a.tokens.access_token}`},body:"{}"});
    await vi.waitFor(async()=>expect((await (await f.expire("read-state")).json() as {entered:boolean}).entered).toBe(true));
    expect((await f.admin("design",{action:"supply",expectedRevision:3,operationId:"rebind",authority:"rebind",material:"synthetic-replacement-key"})).status).toBe(200);
    expect((await f.expire("release-read")).status).toBe(200);
    const response=await pending!;
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({error:"upstream_credential_unavailable"});
    expect(attempts).toBe(0);
  }finally{await f.expire("release-read");await pending;await f.dispose();}
},20000);

it("closes opaque SSE before terminal recording and retains only scoped transport facts",async()=>{
  const bytes=new TextEncoder().encode(': comment\r\nid: opaque-event\r\nevent: message\r\nretry: 123\r\ndata: {"jsonrpc":"2.0","id":1,"result":{}}\r\n\r\n');
  const f=await oauthFixture(undefined,{upstream:async request=>{await request.body?.cancel();return new Response(bytes,{headers:{"Content-Type":"text/event-stream","X-Sensitive-Token":"synthetic-token"}});}});
  try{
    const a=await authorizedTokens(f);
    const before=await f.db.prepare("SELECT (SELECT count(*) FROM request_audit) AS audit,(SELECT count(*) FROM usage_daily) AS usage,(SELECT count(*) FROM credit_admissions) AS credits").first();
    expect((await f.expire("hold-terminal")).status).toBe(200);
    const response=await f.runtime.dispatchFetch(RESOURCE,{method:"POST",headers:{Authorization:`Bearer ${a.tokens.access_token}`},body:"{}"});
    expect(Buffer.from(await response.arrayBuffer()).equals(bytes)).toBe(true);
    expect(response.headers.has("X-Sensitive-Token")).toBe(false);
    await vi.waitFor(async()=>expect((await inventory(f)).terminalEntered).toBe(true));
    expect((await inventory(f)).leases).toBe(1);
    expect((await f.expire("release-terminal")).status).toBe(200);
    await vi.waitFor(async()=>expect((await inventory(f)).leases).toBe(0));
    const activity=(await inventory(f)).activity;
    expect(activity.length).toBe(1);
    expect(activity[0]).toMatchObject({subject:"member",installation:"design",profile:"google.stitch",profile_revision:1,attempted:true,upstream_status:200,terminal:"completed",error:null,response_bytes_observed:bytes.length,client_authorization_id:expect.any(String)});
    expect(Object.keys(activity[0]!).sort()).toEqual(["attempted","authority_revision","client_authorization_id","duration_ms","error","finished_at","headers_ms","installation","profile","profile_revision","request_bytes_observed","response_bytes_observed","started_at","subject","terminal","upstream_status"].sort());
    expect(await f.db.prepare("SELECT (SELECT count(*) FROM request_audit) AS audit,(SELECT count(*) FROM usage_daily) AS usage,(SELECT count(*) FROM credit_admissions) AS credits").first()).toEqual(before);
  }finally{await f.expire("release-terminal");await f.dispose();}
},20000);

it("frames a completed short body with its exact length and leaves an open body streaming",async()=>{
  const payload=new TextEncoder().encode('{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2025-11-25"}}');
  const longer=new Uint8Array(65537);
  longer.set(payload);
  let mode:"short"|"empty"|"long"|"open"="short";
  let source:ReadableStreamDefaultController<Uint8Array>|undefined;
  const stream=(bytes:Uint8Array[],close:boolean,headers:HeadersInit)=>new Response(new ReadableStream<Uint8Array>({start(controller){
    for(const chunk of bytes)controller.enqueue(chunk);
    if(close)controller.close();else source=controller;
  }}),{headers});
  const f=await oauthFixture(undefined,{upstream:async request=>{
    await request.body?.cancel();
    if(mode==="short")return new Response(payload,{headers:{"Content-Type":"application/json"}});
    if(mode==="empty")return new Response(null,{status:202});
    if(mode==="long")return new Response(longer,{headers:{"Content-Type":"application/octet-stream"}});
    return stream([new Uint8Array([7])],false,{"Content-Type":"text/event-stream"});
  }});
  let open:Response|undefined;
  try{
    const a=await authorizedTokens(f);
    const send=()=>f.runtime.dispatchFetch(RESOURCE,{method:"POST",headers:{Authorization:`Bearer ${a.tokens.access_token}`,"Content-Type":"application/json"},body:"{}"});
    const framedLength=async()=>(await (await f.expire("relay-framing")).json() as {contentLength:string|null}).contentLength;
    const initialize=await send();
    expect(await framedLength()).toBe(String(payload.byteLength));
    const body=new Uint8Array(await initialize.arrayBuffer());
    expect(initialize.status).toBe(200);
    const length=initialize.headers.get("content-length");
    expect(length===null||length===String(payload.byteLength)).toBe(true);
    expect(length===String(payload.byteLength)||initialize.headers.get("transfer-encoding")==="chunked").toBe(true);
    expect(Buffer.from(body).equals(payload)).toBe(true);
    mode="empty";
    const initialized=await send();
    expect(await framedLength()).toBe("0");
    expect(initialized.status).toBe(202);
    expect(initialized.headers.get("content-length")==="0"||initialized.headers.get("transfer-encoding")==="chunked").toBe(true);
    expect(await initialized.text()).toBe("");
    mode="long";
    const oversized=await send();
    expect(await framedLength()).toBeNull();
    expect(oversized.headers.get("Content-Length")).toBeNull();
    expect(new Uint8Array(await oversized.arrayBuffer())).toEqual(longer);
    mode="open";
    const streaming=await send();
    open=streaming;
    expect(await framedLength()).toBeNull();
    expect(streaming.headers.get("Content-Length")).toBeNull();
    const reader=streaming.body!.getReader();
    expect(Array.from((await reader.read()).value??[])).toEqual([7]);
    source?.enqueue(new Uint8Array([8]));
    expect(Array.from((await reader.read()).value??[])).toEqual([8]);
    await reader.cancel();
  }finally{source?.close();await open?.body?.cancel().catch(()=>undefined);await f.dispose();}
},20000);

async function inventory(f:Awaited<ReturnType<typeof oauthFixture>>):Promise<{leases:number;terminalEntered:boolean;activity:Record<string,unknown>[]}>{
  return await (await f.expire("relay-inventory","member")).json() as {leases:number;terminalEntered:boolean;activity:Record<string,unknown>[]};
}

it("rejects an Upgrade on the exact POST before reading a body or acquiring authority",async()=>{
  const request=new Request(RESOURCE,{method:"POST",headers:{Upgrade:"websocket"},body:"{}"});
  const env={ADMIN_DASHBOARD_HOST:"console.example.test",RUNTIME_INSTALLATIONS:JSON.stringify([{id:"design",profile:"google.stitch",label:"Design",resource:RESOURCE}])} as Env;
  const result=await admitRuntimeRequest(request,env);
  expect(result instanceof Response&&result.status===400).toBe(true);
  expect(request.bodyUsed).toBe(false);
});

it("maps credential/redirect/session failures safely and preserves ordinary upstream errors and empty responses",async()=>{
  let attempts=0,status=302;
  const f=await oauthFixture(undefined,{upstream:async request=>{
    attempts++;await request.body?.cancel();
    return new Response(status===202?null:"synthetic upstream error",{status,headers:{"Content-Type":"application/json","WWW-Authenticate":"unsafe-upstream-challenge",Location:"https://unreviewed.example.test",...(status===200?{"Mcp-Session-Id":"unsupported-upstream-session"}:{})}});
  }});
  try{
    const a=await authorizedTokens(f);
    for(const [upstream,expected,code] of [[302,502,"upstream_redirect_rejected"],[401,502,"upstream_credential_unavailable"],[403,502,"upstream_credential_unavailable"],[200,502,"runtime_transport_unsupported"],[500,500,null],[202,202,null]] as const){
      status=upstream;
      const response=await f.runtime.dispatchFetch(RESOURCE,{method:"POST",headers:{Authorization:`Bearer ${a.tokens.access_token}`},body:"{}"});
      expect(response.status).toBe(expected);
      expect(response.headers.has("WWW-Authenticate")||response.headers.has("Location")||response.headers.has("Mcp-Session-Id")).toBe(false);
      if(code)expect(await response.json()).toEqual({error:code});
      else expect((await response.text())===(status===202?"":"synthetic upstream error")).toBe(true);
    }
    expect(attempts).toBe(6);
  }finally{await f.dispose();}
},20000);

it("ends a still-active stream at the absolute lease deadline without retry",async()=>{
  let source!:ReadableStreamDefaultController<Uint8Array>;
  let attempts=0;
  const f=await oauthFixture(undefined,{controlledTimers:true,upstream:async request=>{
    attempts++;await request.body?.cancel();
    return new Response(new ReadableStream<Uint8Array>({start(controller){source=controller;controller.enqueue(new Uint8Array([32]));}}),{headers:{"Content-Type":"text/event-stream"}});
  }});
  let reader:ReadableStreamDefaultReader<Uint8Array>|undefined;
  try{
    const a=await authorizedTokens(f);
    const response=await f.runtime.dispatchFetch(RESOURCE,{method:"POST",headers:{Authorization:`Bearer ${a.tokens.access_token}`},body:"{}"});
    const reading:ReadableStreamDefaultReader<Uint8Array>=response.body!.getReader();reader=reading;await reading.read();
    for(let n=0;n<10;n++){
      expect((await f.expire("tick","59000")).status).toBe(200);
      source.enqueue(new Uint8Array([32]));
      expect((await reading.read()).done).toBe(false);
    }
    // The native HTTP adapter may expose cancellation as EOF or a read error.
    // Both must end delivery; durable facts must identify the same lease error.
    const ended=reading.read().then(result=>result.done,()=>true);
    expect((await f.expire("tick","10000")).status).toBe(200);
    expect(await ended).toBe(true);
    await vi.waitFor(async()=>expect((await inventory(f)).leases).toBe(0));
    expect((await inventory(f)).activity[0]).toMatchObject({terminal:"error",error:"lease_expired",attempted:true});
    expect(attempts).toBe(1);
  }finally{await reader?.cancel().catch(()=>undefined);try{source?.close();}catch{/* source is already cancelled */}await f.dispose();}
},20000);

it("bounds upstream-header idle time and does not replay an uncertain POST",async()=>{
  let entered!:()=>void,release!:()=>void;
  const reached=new Promise<void>(resolve=>{entered=resolve;});
  const held=new Promise<void>(resolve=>{release=resolve;});
  let attempts=0;
  const f=await oauthFixture(undefined,{controlledTimers:true,upstream:async request=>{attempts++;await request.body?.cancel();entered();await held;return new Response(null,{status:202});}});
  let pending:Promise<Response>|undefined;
  let timeout:ReturnType<typeof setTimeout>|undefined;
  try{
    const a=await authorizedTokens(f);
    const dispatched:Promise<Response>=f.runtime.dispatchFetch(RESOURCE,{method:"POST",headers:{Authorization:`Bearer ${a.tokens.access_token}`},body:"{}"});
    pending=dispatched;
    await reached;
    expect((await f.expire("tick","60000")).status).toBe(200);
    const response=await Promise.race([dispatched,new Promise<never>((_,reject)=>{timeout=setTimeout(()=>reject(new Error("Runtime idle termination was not observed")),1000);})]);
    expect(response.status).toBe(504);
    expect(await response.json()).toEqual({error:"stream_idle_timeout"});
    expect(attempts).toBe(1);
  }finally{if(timeout!==undefined)clearTimeout(timeout);release();await pending;await f.dispose();}
},20000);

it("selects each fixed profile by exact path on a shared origin without sharing resource authority",async()=>{
  const seen:{url:string;stitch:boolean;catalog:boolean}[]=[];
  const f=await oauthFixture(undefined,{upstream:async request=>{
    await request.body?.cancel();
    seen.push({url:request.url,stitch:request.headers.has("X-Goog-Api-Key"),catalog:request.headers.get("X-Synthetic-Credential")==="synthetic-catalog-key"});
    return new Response(null,{status:202});
  }});
  try{
    const a=await authorizedTokens(f),b=await authorizedTokens(f,OTHER_RESOURCE);
    const send=(token:string,resource:string,headers:HeadersInit={})=>f.runtime.dispatchFetch(resource,{method:"POST",headers:{Authorization:`Bearer ${token}`,...headers},body:"{}"});
    const wrongCatalog=await send(a.tokens.access_token,OTHER_RESOURCE);
    expect(wrongCatalog.status).toBe(401);
    expect(wrongCatalog.headers.get("WWW-Authenticate")).toBe('Bearer resource_metadata="https://design.example.test/.well-known/oauth-protected-resource/catalog", error="invalid_token"');
    await wrongCatalog.body?.cancel();
    const wrongStitch=await send(b.tokens.access_token,RESOURCE);
    expect(wrongStitch.status).toBe(401);
    expect(wrongStitch.headers.get("WWW-Authenticate")).toBe('Bearer resource_metadata="https://design.example.test/.well-known/oauth-protected-resource/google-stitch", error="invalid_token"');
    await wrongStitch.body?.cancel();
    expect((await send(b.tokens.access_token,OTHER_RESOURCE,{"X-Synthetic-Credential":"caller-key"})).status).toBe(202);
    expect(seen).toEqual([{url:"https://catalog.example.test/rpc",stitch:false,catalog:true}]);
  }finally{await f.dispose();}
},20000);

it("rejects unsupported session/resumption, version, origin, path and query before any upstream dispatch",async()=>{
  let attempts=0;
  const versions:Array<string|null>=[];
  const f=await oauthFixture(undefined,{upstream:async request=>{attempts++;versions.push(request.headers.get("Mcp-Protocol-Version"));await request.body?.cancel();return new Response(null,{status:202});}});
  try{
    const a=await authorizedTokens(f);
    const send=(url=RESOURCE,headers:HeadersInit={},method="POST")=>f.runtime.dispatchFetch(url,{method,headers:{Authorization:`Bearer ${a.tokens.access_token}`,...headers},...(method==="POST"?{body:"{}"}:{})});
    for(const headers of [new Headers({"Mcp-Session-Id":"old-session"}),new Headers({"Last-Event-ID":"old-cursor"}),new Headers({"Mcp-Protocol-Version":"2025-03-26"})])expect((await send(RESOURCE,Object.fromEntries(headers))).status).toBe(400);
    expect(attempts).toBe(0);
    const legacy=await send(RESOURCE,{"Mcp-Protocol-Version":"2024-11-05"});
    const negotiated=await send(RESOURCE,{"Mcp-Protocol-Version":"2025-06-18"});
    expect(legacy.status).toBe(202);
    expect(negotiated.status).toBe(202);
    await legacy.body?.cancel();
    await negotiated.body?.cancel();
    expect(versions).toEqual(["2024-11-05","2025-06-18"]);
    expect((await send(RESOURCE,{Origin:"https://foreign.example.test"})).status).toBe(403);
    for(const url of [RESOURCE+"?key=synthetic",RESOURCE+"?safe=1",RESOURCE+"/child",RESOURCE+"/",RESOURCE+"/mcp",
      "https://design.example.test/mcp","https://design.example.test/stitch","https://design.example.test/%67oogle-stitch"]) {
      const response=await send(url);expect(response.status).toBe(404);await response.body?.cancel();
    }
    expect((await send(RESOURCE,{},"GET")).status).toBe(405);
    expect((await send(RESOURCE,{},"DELETE")).status).toBe(405);
    expect(attempts).toBe(2);
  }finally{await f.dispose();}
},20000);

it("admits at most four outstanding requests for one member/installation without dispatching the excess",async()=>{
  const responses:Response[]=[];
  let attempts=0;
  const f=await oauthFixture(undefined,{upstream:async()=>{
    attempts++;
    return new Response(new ReadableStream({start(controller){controller.enqueue(new Uint8Array([32]));}}),{headers:{"Content-Type":"text/event-stream"}});
  }});
  try{
    const a=await authorizedTokens(f);
    responses.push(...await Promise.all(Array.from({length:5},()=>f.runtime.dispatchFetch(RESOURCE,{method:"POST",headers:{Authorization:`Bearer ${a.tokens.access_token}`},body:"{}"}))));
    expect(responses.map(response=>response.status).sort()).toEqual([200,200,200,200,429]);
    expect(attempts).toBe(4);
  }finally{for(const response of responses)await response.body?.cancel();await f.dispose();}
},20000);
