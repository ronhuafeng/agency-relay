import {expect,it} from "vitest";
import {oauthFixture,ISSUER,RESOURCE,OTHER_RESOURCE,authorizedTokens,pendingConsent,tokenRequest,resourceRequest} from "./oauth-fixture";
import {createHash} from "node:crypto";
import {mkdtemp,rm} from "node:fs/promises";
import {join} from "node:path";
import {tmpdir} from "node:os";

// Accept exact metadata and an independent public client registration. Reject
// alternate resources/credentials and immutable-redirect replacement. Storage
// layout may change; the protocol responses and isolation remain the oracle.
it("publishes exact resource metadata and registers independent bounded public clients",async()=>{
  const f=await oauthFixture();try {
    const metadata=await f.runtime.dispatchFetch(`${ISSUER}/.well-known/oauth-authorization-server`);
    expect(metadata.status).toBe(200);
    expect(await metadata.json()).toMatchObject({issuer:ISSUER,authorization_endpoint:`${ISSUER}/runtime/authorize`,token_endpoint:`${ISSUER}/runtime/token`,registration_endpoint:`${ISSUER}/runtime/register`,code_challenge_methods_supported:["S256"],token_endpoint_auth_methods_supported:["none"]});
    for(const uri of [RESOURCE,OTHER_RESOURCE]) {
      const result=await f.runtime.dispatchFetch(`${new URL(uri).origin}/.well-known/oauth-protected-resource/mcp`);
      expect(await result.json()).toMatchObject({resource:uri,authorization_servers:[ISSUER],scopes_supported:["runtime.use"]});
    }
    expect((await f.runtime.dispatchFetch("https://alternate.example.test/.well-known/oauth-authorization-server")).status).toBe(404);
    const register=(body:unknown)=>f.runtime.dispatchFetch(`${ISSUER}/runtime/register`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});
    const input={client_name:"Synthetic client",redirect_uris:["http://127.0.0.1:9/callback"],token_endpoint_auth_method:"none"};
    const first=await register(input),second=await register(input);
    expect([first.status,second.status]).toEqual([201,201]);
    const a=await first.json() as {client_id:string},b=await second.json() as {client_id:string};
    expect(typeof a.client_id==="string"&&a.client_id.length>20&&a.client_id!==b.client_id).toBe(true);
    expect((await register({...input,client_secret:"synthetic-secret"})).status).toBe(400);
    expect((await register({...input,jwks_uri:"https://untrusted.example.test/key"})).status).toBe(400);
    const extended=await register({...input,scope:"runtime.use",code_challenge_method:"S256",additional_metadata:"ignored"});
    expect(extended.status).toBe(201);
    expect((await extended.json() as Record<string,unknown>).additional_metadata).toBeUndefined();
  } finally {await f.dispose();}
},20000);

it("rotates refresh material and invalidates replayed families, not unrelated clients",async()=>{
  const f=await oauthFixture();try {
    const a=await authorizedTokens(f),b=await authorizedTokens(f);
    const input={grant_type:"refresh_token",client_id:a.clientId,refresh_token:a.tokens.refresh_token,resource:RESOURCE};
    const refreshed=await tokenRequest(f,input);expect(refreshed.status).toBe(200);
    const tokens=await refreshed.json() as {refresh_token:string;access_token:string};
    expect(typeof tokens.refresh_token==="string"&&tokens.refresh_token!==a.tokens.refresh_token).toBe(true);
    expect((await resourceRequest(f,a.tokens.access_token)).status).toBe(200);
    expect((await resourceRequest(f,tokens.access_token)).status).toBe(200);
    expect((await tokenRequest(f,input)).status).toBe(400);
    expect((await resourceRequest(f,a.tokens.access_token)).status).toBe(401);
    expect((await resourceRequest(f,tokens.access_token)).status).toBe(401);
    expect((await resourceRequest(f,b.tokens.access_token)).status).toBe(200);
  } finally {await f.dispose();}
},20000);

it("allows one concurrent code exchange and invalidates its family when the code is replayed",async()=>{
  const f=await oauthFixture();try {
    const pending=await pendingConsent(f),decision=await pending.decide();
    const code=new URL(decision.headers.get("Location")!).searchParams.get("code")!;
    const input={grant_type:"authorization_code",client_id:pending.clientId,code,redirect_uri:pending.query.get("redirect_uri")!,resource:RESOURCE,code_verifier:pending.verifier};
    const responses=await Promise.all([tokenRequest(f,input),tokenRequest(f,input)]);
    expect(responses.map(r=>r.status).sort()).toEqual([200,400]);
    const result=await responses.find(r=>r.status===200)!.json() as {access_token:string};
    expect((await resourceRequest(f,result.access_token)).status).toBe(401);
  } finally {await f.dispose();}
},20000);

it("denies current access loss and does not revive old consent after installation re-enable",async()=>{
  const f=await oauthFixture();try {
    const authorized=await authorizedTokens(f),pending=await pendingConsent(f);
    expect((await f.admin("design",{action:"disable",expectedRevision:3,operationId:"disable-proof"})).status).toBe(200);
    expect((await resourceRequest(f,authorized.tokens.access_token)).status).toBe(403);
    expect((await pending.decide()).status).toBe(403);
    expect((await f.admin("design",{action:"enable",expectedRevision:4,operationId:"enable-proof"})).status).toBe(200);
    expect((await resourceRequest(f,authorized.tokens.access_token)).status).toBe(403);
    expect((await pending.decide()).status).toBe(403);
    const fresh=await authorizedTokens(f);
    expect((await resourceRequest(f,fresh.tokens.access_token)).status).toBe(200);
  } finally {await f.dispose();}
},20000);

it("permits uncredentialed OAuth preflight, never credentialed wildcard or browser-write exemptions",async()=>{
  const f=await oauthFixture();try {
    for(const endpoint of ["/runtime/register","/runtime/token"]) {
      const result=await f.runtime.dispatchFetch(`${ISSUER}${endpoint}`,{method:"OPTIONS",headers:{Origin:"https://native-client.example.test","Access-Control-Request-Method":"POST","Access-Control-Request-Headers":"content-type"}});
      expect(result.status).toBe(204);
      expect(result.headers.get("Access-Control-Allow-Origin")).toBe("*");
      expect(result.headers.has("Access-Control-Allow-Credentials")).toBe(false);
    }
    const pending=await pendingConsent(f);
    const rejected=await f.runtime.dispatchFetch(pending.target.href,{method:"POST",headers:{Cookie:pending.cookie,"Content-Type":"application/x-www-form-urlencoded"},body:"decision=allow",redirect:"manual"});
    expect(rejected.status).toBe(403);
    expect((await pending.decide()).status).toBe(303);
    expect((await f.runtime.dispatchFetch(`${ISSUER}/runtime/unknown`)).status).toBe(404);
    const unauthenticated=await f.runtime.dispatchFetch(RESOURCE,{method:"POST",body:"{}"});
    expect(unauthenticated.status).toBe(401);
    expect(unauthenticated.headers.get("WWW-Authenticate")?.includes("resource_metadata=")).toBe(true);
  } finally {await f.dispose();}
},20000);

it("rejects wrong scope, redirect and PKCE, and preserves current permission checks across regrant",async()=>{
  const f=await oauthFixture();try {
    const current=await authorizedTokens(f),pending=await pendingConsent(f);
    for(const [field,value] of [["scope","other"],["scope",""],["redirect_uri","http://127.0.0.1:1234/other"],["code_challenge_method","plain"],["resource","https://unregistered.example.test/mcp"]]) {
      const query=new URLSearchParams(pending.query);query.set(field!,value!);
      expect((await f.runtime.dispatchFetch(`${ISSUER}/runtime/authorize?${query}`,{headers:{Cookie:f.cookies.get("member")!},redirect:"manual"})).status).toBe(400);
    }
    const access=(state:string,revision:number)=>f.runtime.dispatchFetch("https://api.trustedtunnel.app/admin/runtime-installations/design/access/member",{method:"PUT",headers:{Authorization:"Bearer synthetic-operator","Content-Type":"application/json"},body:JSON.stringify({state,expectedRevision:revision,expiresAt:null})});
    expect((await access("revoked",1)).status).toBe(200);
    expect((await resourceRequest(f,current.tokens.access_token)).status).toBe(403);
    expect((await access("granted",2)).status).toBe(200);
    expect((await resourceRequest(f,current.tokens.access_token)).status).toBe(403);
    expect((await pending.decide()).status).toBe(403);
    const fresh=await authorizedTokens(f);
    expect((await resourceRequest(f,fresh.tokens.access_token)).status).toBe(200);
    const unchecked=await pendingConsent(f),allowed=await unchecked.decide();
    const input={grant_type:"authorization_code",client_id:unchecked.clientId,resource:RESOURCE,code:new URL(allowed.headers.get("Location")!).searchParams.get("code")!,redirect_uri:unchecked.query.get("redirect_uri")!,code_verifier:unchecked.verifier};
    const broken=await tokenRequest(f,{...input,code_verifier:"b".repeat(43)});
    expect(broken.status).toBe(400);
    expect((await tokenRequest(f,input)).status).toBe(400);
    expect((await resourceRequest(f,fresh.tokens.access_token)).status).toBe(200);
  } finally {await f.dispose();}
},20000);

it("checks expiry without waiting for cleanup and retains replay tombstones while descendants are live",async()=>{
  const f=await oauthFixture();try {
    const current=await authorizedTokens(f);
    expect((await f.expire("access",current.tokens.access_token)).status).toBe(200);
    expect((await resourceRequest(f,current.tokens.access_token)).status).toBe(401);
    const rotated=await tokenRequest(f,{grant_type:"refresh_token",client_id:current.clientId,resource:RESOURCE,refresh_token:current.tokens.refresh_token});
    expect(rotated.status).toBe(200);
    const tokens=await rotated.json() as {access_token:string;refresh_token:string};
    expect((await resourceRequest(f,tokens.access_token)).status).toBe(200);
    await f.expire("code",current.body.code);
    await f.expire("refresh",current.tokens.refresh_token);
    await f.expire("clean");
    expect((await tokenRequest(f,current.body)).status).toBe(400);
    expect((await resourceRequest(f,tokens.access_token)).status).toBe(401);
    const fresh=await authorizedTokens(f);
    await f.expire("family",fresh.clientId);
    expect((await resourceRequest(f,fresh.tokens.access_token)).status).toBe(401);
    expect((await tokenRequest(f,{grant_type:"refresh_token",client_id:fresh.clientId,resource:RESOURCE,refresh_token:fresh.tokens.refresh_token})).status).toBe(400);
    const pending=await pendingConsent(f);await f.expire("pending",pending.target.pathname.split("/").at(-1)!);
    expect((await pending.decide()).status).toBe(400);
  } finally {await f.dispose();}
},20000);

it("counts malformed registration attempts against the durable UTC-hour limit",async()=>{
  const f=await oauthFixture();try {
    const invalid=()=>f.runtime.dispatchFetch(`${ISSUER}/runtime/register`,{method:"POST",headers:{"Content-Type":"application/json"},body:"{"});
    for(let n=0;n<100;n++)expect((await invalid()).status).toBe(400);
    expect((await invalid()).status).toBe(429);
  } finally {await f.dispose();}
},20000);

it("counts malformed token requests with an unambiguous registered client ID",async()=>{
  const f=await oauthFixture();try {
    const authorized=await authorizedTokens(f);
    const malformed=()=>tokenRequest(f,{client_id:authorized.clientId,grant_type:"refresh_token",resource:RESOURCE,unsupported_field:"ignored"});
    // The successful initial exchange already consumed one attempt in this minute.
    for(let n=0;n<29;n++)expect((await malformed()).status).toBe(400);
    expect((await malformed()).status).toBe(429);
  } finally {await f.dispose();}
},20000);

it("enforces actual granted scope, not merely the published scope advertisement",async()=>{
  const f=await oauthFixture();try {
    const authorized=await authorizedTokens(f);
    expect((await f.expire("scope",authorized.clientId)).status).toBe(200);
    const result=await resourceRequest(f,authorized.tokens.access_token);
    expect(result.status).toBe(403);
    expect(result.headers.get("WWW-Authenticate")?.includes('error="insufficient_scope"')).toBe(true);
    expect((await tokenRequest(f,{grant_type:"refresh_token",client_id:authorized.clientId,refresh_token:authorized.tokens.refresh_token,resource:RESOURCE})).status).toBe(400);
  } finally {await f.dispose();}
},20000);

it("preserves authority through same-account rotation, but rejects pre-login rebind and disabled subjects",async()=>{
  const f=await oauthFixture();try {
    const a=await authorizedTokens(f);
    expect((await f.admin("design",{action:"supply",expectedRevision:3,operationId:"same-proof",authority:"same",material:"synthetic-rotated"})).status).toBe(200);
    expect((await resourceRequest(f,a.tokens.access_token)).status).toBe(200);
    const anonymous=await pendingConsent(f,RESOURCE,undefined,null);
    const requiresLogin=await f.runtime.dispatchFetch(anonymous.target.href,{headers:{Cookie:anonymous.cookie},redirect:"manual"});
    expect(requiresLogin.status).toBe(303);
    expect(new URL(requiresLogin.headers.get("Location")!,ISSUER).searchParams.get("return")).toBe(anonymous.target.pathname);
    expect((await f.admin("design",{action:"supply",expectedRevision:4,operationId:"rebind-proof",authority:"rebind",material:"synthetic-other-authority"})).status).toBe(200);
    expect((await resourceRequest(f,a.tokens.access_token)).status).toBe(403);
    const stale=await f.runtime.dispatchFetch(anonymous.target.href,{headers:{Cookie:`${f.cookies.get("member")}; ${anonymous.cookie}`}});
    expect(stale.status).toBe(403);
    const fresh=await authorizedTokens(f);
    const status=(value:string)=>f.runtime.dispatchFetch("https://api.trustedtunnel.app/admin/users/member/status",{method:"POST",headers:{Authorization:"Bearer synthetic-operator","Content-Type":"application/json"},body:JSON.stringify({status:value})});
    expect((await status("disabled")).status).toBe(200);
    expect((await resourceRequest(f,fresh.tokens.access_token)).status).toBe(403);
    expect((await status("active")).status).toBe(200);
    expect((await resourceRequest(f,fresh.tokens.access_token)).status).toBe(403);
  } finally {await f.dispose();}
},20000);

it("never extends the absolute family deadline and fails closed when current D1 authority is unavailable",async()=>{
  const f=await oauthFixture();try {
    const authorized=await authorizedTokens(f);
    const inventory=await f.runtime.dispatchFetch(`${ISSUER}/runtime/clients`,{headers:{Cookie:f.cookies.get("member")!}});
    const data=await inventory.json() as {consents:{expires_at:string}[]};
    const deadline=Date.parse(data.consents[0]!.expires_at);
    await f.expire("time",String(deadline-60000));
    const result=await tokenRequest(f,{grant_type:"refresh_token",client_id:authorized.clientId,refresh_token:authorized.tokens.refresh_token,resource:RESOURCE});
    expect(result.status).toBe(200);
    const rotated=await result.json() as {access_token:string;refresh_token:string;expires_in:number};
    expect(rotated.expires_in).toBe(60);
    await f.db.prepare("DROP TABLE runtime_installation_access").run();
    expect((await resourceRequest(f,rotated.access_token)).status).toBe(503);
    await f.expire("time",String(deadline+1000));
    expect((await resourceRequest(f,rotated.access_token)).status).toBe(401);
    expect((await tokenRequest(f,{grant_type:"refresh_token",client_id:authorized.clientId,refresh_token:rotated.refresh_token,resource:RESOURCE})).status).toBe(400);
  } finally {await f.dispose();}
},20000);

it("retains token and replay authority across a real storage restart",async()=>{
  const directory=await mkdtemp(join(tmpdir(),"relay-oauth-state-"));
  let f:Awaited<ReturnType<typeof oauthFixture>>|undefined;
  try {
    f=await oauthFixture(directory);const grant=await authorizedTokens(f);
    await f.dispose();f=await oauthFixture(directory);
    expect((await resourceRequest(f,grant.tokens.access_token)).status).toBe(200);
    expect((await tokenRequest(f,grant.body)).status).toBe(400);
    expect((await resourceRequest(f,grant.tokens.access_token)).status).toBe(401);
  } finally {await f?.dispose();await rm(directory,{recursive:true,force:true});}
},20000);

it("keeps Deny, console role and alternate credential domains distinct from Runtime consent",async()=>{
  const f=await oauthFixture();try {
    const pending=await pendingConsent(f);
    const denied=await pending.decide("deny");expect(denied.status).toBe(303);
    const callback=new URL(denied.headers.get("Location")!);
    expect(callback.searchParams.get("error")).toBe("access_denied");
    expect(callback.searchParams.has("code")).toBe(false);
    expect((await pending.decide()).status).toBe(400);
    expect(await (await f.runtime.dispatchFetch(`${ISSUER}/runtime/clients`,{headers:{Cookie:f.cookies.get("member")!}})).json()).toEqual({consents:[]});
    const admin=await f.runtime.dispatchFetch(`${ISSUER}/runtime/authorize?${pending.query}`,{headers:{Cookie:f.cookies.get("admin")!},redirect:"manual"});
    expect(admin.status).toBe(403);
    for(const token of ["synthetic-operator","cfwd_synthetic_provider_key_not_oauth","synthetic-feishu-token-not-oauth","synthetic-upstream-token-not-oauth"])expect((await resourceRequest(f,token)).status).toBe(401);
    expect((await f.runtime.dispatchFetch(RESOURCE,{method:"POST",headers:{Cookie:f.cookies.get("member")!},body:"{}"})).status).toBe(401);
  } finally {await f.dispose();}
},20000);

it("lists only the member's client consents and revokes one without revoking another",async()=>{
  const f=await oauthFixture();try {
    const a=await authorizedTokens(f),b=await authorizedTokens(f,OTHER_RESOURCE);
    const list=(member:string)=>f.runtime.dispatchFetch(`${ISSUER}/runtime/clients`,{headers:{Cookie:f.cookies.get(member)!}});
    const inventory=await list("member");expect(inventory.status).toBe(200);
    const data=await inventory.json() as {consents:{id:string;client_id:string;resource:string}[]};
    expect(data.consents.map(c=>c.resource).sort()).toEqual([RESOURCE,OTHER_RESOURCE].sort());
    expect(await (await list("other")).json()).toEqual({consents:[]});
    const id=data.consents.find(c=>c.client_id===a.clientId)!.id;
    const revoke=(member:string,origin:string)=>f.runtime.dispatchFetch(`${ISSUER}/runtime/clients/${id}`,{method:"DELETE",headers:{Cookie:f.cookies.get(member)!,Origin:origin}});
    expect((await revoke("other",ISSUER)).status).toBe(404);
    expect((await revoke("member","https://foreign.example.test")).status).toBe(403);
    expect((await resourceRequest(f,a.tokens.access_token)).status).toBe(200);
    expect((await revoke("member",ISSUER)).status).toBe(200);
    expect((await resourceRequest(f,a.tokens.access_token)).status).toBe(401);
    expect((await resourceRequest(f,b.tokens.access_token,OTHER_RESOURCE)).status).toBe(200);
    expect((await resourceRequest(f,b.tokens.access_token)).status).toBe(401);
  } finally {await f.dispose();}
},20000);

// Accept only an explicit browser decision and usable scoped token. Reject a
// missing browser transaction; registry/storage layout is not the oracle.
it("requires explicit member consent before the library issues a resource-bound token",async()=>{
  const f=await oauthFixture();try {
    const registration=await f.runtime.dispatchFetch(`${ISSUER}/runtime/register`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({client_name:"Synthetic <client>",redirect_uris:["http://127.0.0.1:9/callback"],token_endpoint_auth_method:"none"})});
    const client=await registration.json() as {client_id:string};
    const verifier="v".repeat(43);
    const query=new URLSearchParams({response_type:"code",client_id:client.client_id,redirect_uri:"http://127.0.0.1:1234/callback",resource:RESOURCE,scope:"runtime.use",state:"synthetic-state",code_challenge:createHash("sha256").update(verifier).digest("base64url"),code_challenge_method:"S256"});
    const begun=await f.runtime.dispatchFetch(`${ISSUER}/runtime/authorize?${query}`,{headers:{Cookie:f.cookies.get("member")!},redirect:"manual"});
    expect(begun.status).toBe(303);
    const target=new URL(begun.headers.get("Location")!,ISSUER);
    expect(target.pathname.startsWith("/runtime/consent/")&& !target.search).toBe(true);
    const binding=begun.headers.get("Set-Cookie")!.split(";",1)[0]!;
    const cookie=`${f.cookies.get("member")}; ${binding}`;
    const shown=await f.runtime.dispatchFetch(target.href,{headers:{Cookie:cookie}});
    const html=await shown.text();
    expect(shown.status).toBe(200);
    expect(shown.headers.get("Content-Security-Policy")?.includes("frame-ancestors 'none'")).toBe(true);
    expect(shown.headers.get("Referrer-Policy")).toBe("no-referrer");
    expect(html.includes("Synthetic &lt;client&gt;")&&!html.includes("<client>")).toBe(true);
    expect(html.includes(RESOURCE)&&html.includes("runtime.use")&&html.includes("Allow")&&html.includes("Deny")).toBe(true);
    const decide=(cookies:string)=>f.runtime.dispatchFetch(target.href,{method:"POST",headers:{Cookie:cookies,Origin:ISSUER,"Content-Type":"application/x-www-form-urlencoded"},body:"decision=allow",redirect:"manual"});
    expect((await decide(f.cookies.get("member")!)).status).toBe(403);
    const allowed=await decide(cookie);
    expect(allowed.status).toBe(303);
    const callback=new URL(allowed.headers.get("Location")!);
    expect(callback.origin).toBe("http://127.0.0.1:1234");
    expect(callback.searchParams.get("state")).toBe("synthetic-state");
    const exchanged=await f.runtime.dispatchFetch(`${ISSUER}/runtime/token`,{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"},body:new URLSearchParams({grant_type:"authorization_code",client_id:client.client_id,code:callback.searchParams.get("code")!,redirect_uri:query.get("redirect_uri")!,resource:RESOURCE,code_verifier:verifier}).toString()});
    expect(exchanged.status).toBe(200);
    const tokens=await exchanged.json() as {access_token:string;refresh_token:string;scope:string};
    expect(typeof tokens.access_token==="string"&&typeof tokens.refresh_token==="string"&&tokens.scope==="runtime.use").toBe(true);
    const use=await f.runtime.dispatchFetch(RESOURCE,{method:"POST",headers:{Authorization:`Bearer ${tokens.access_token}`,"Content-Type":"application/json"},body:JSON.stringify({jsonrpc:"2.0",id:1,method:"tools/list"})});
    expect(use.status).toBe(200);
    expect((await use.json() as {result:{tools:{name:string}[]}}).result.tools.map(t=>t.name)).toEqual(["synthetic_probe"]);
  } finally {await f.dispose();}
},20000);
