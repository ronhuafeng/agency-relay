import {createRequire} from "node:module";
import {readFileSync,readdirSync} from "node:fs";
import {build} from "esbuild";
import {unstable_splitSqlQuery} from "wrangler";
import {createConsoleSession} from "../../src/auth/console-session";
import {createHash} from "node:crypto";

const {Miniflare,convertV4MiniflareOptions}=createRequire(import.meta.resolve("wrangler/package.json"))("miniflare");
export const ISSUER="https://console.example.test";
export const RESOURCE="https://design.example.test/mcp";
export const OTHER_RESOURCE="https://other.example.test/mcp";

/** Actual Worker/D1 and production DO owner with test-only clock/expiry controls.
 * The external MCP service is synthetic; production owns every auth/path check. */
export async function oauthFixture(persist?:string,options:{upstream?:(request:Request)=>Promise<Response>;controlledTimers?:boolean;issuer?:string}={}) {
  const issuer=options.issuer??ISSUER;
  const compiled=await build({
    stdin:{resolveDir:process.cwd(),sourcefile:"runtime-oauth-fixture.ts",contents:`
      // Pin the external UTC clock so policy tests cannot cross a time window.
      // workerd's module-initialization clock is zero. Pin the Node clock so
      // scheduled alarms are not accidentally created in the real-world past.
      const NativeDate=Date;let fixtureTime=${Date.now()};
      globalThis.Date=class extends NativeDate {
        constructor(...args){super(...(args.length?args:[fixtureTime]));}
        static now(){return fixtureTime;}
      };
      const timers=new Map();let nextTimer=0;
      if(${options.controlledTimers===true}) {
        globalThis.setTimeout=(callback,delay=0)=>{const id=++nextTimer;timers.set(id,{at:fixtureTime+delay,callback});return id;};
        globalThis.clearTimeout=id=>timers.delete(id);
      }
      import {RuntimeOAuth} from './src/runtime/oauth';
      import {hmacSha256Hex} from './src/crypto';
      export class RuntimeOAuthFixture extends RuntimeOAuth {
        terminalHold;terminalRelease;terminalEntered=false;
        holdTerminal(){this.terminalHold=new Promise(resolve=>{this.terminalRelease=resolve;});return true;}
        releaseTerminal(){this.terminalRelease?.();this.terminalHold=undefined;return true;}
        async completeLease(id,facts){this.terminalEntered=true;if(this.terminalHold)await this.terminalHold;return super.completeLease(id,facts);}
        relayInventory(subject){return {
          leases:this.ctx.storage.sql.exec('SELECT count(*) AS count FROM relay_leases').one().count,
          activity:this.ctx.storage.sql.exec('SELECT facts FROM relay_activity WHERE subject=? ORDER BY installation',subject).toArray().map(row=>JSON.parse(row.facts)),
          terminalEntered:this.terminalEntered
        };}
        async runCleanup(){await this.alarm();return true;}
        async cleanupBacklog(client){
          const {id}=this.ctx.storage.sql.exec('SELECT id FROM consents WHERE client=?',client).one();
          this.ctx.storage.transactionSync(()=>{
            for(let n=0;n<513;n++) {
              this.ctx.storage.sql.exec('INSERT INTO codes VALUES (?,?,?,?,?,1)','fixture-code-'+n,id,'http://127.0.0.1:9/callback','fixture-challenge',0);
              this.ctx.storage.sql.exec('INSERT INTO refresh_tokens VALUES (?,?,0,1)','fixture-refresh-'+n,id);
              this.ctx.storage.sql.exec('INSERT INTO access_tokens VALUES (?,?,0)','fixture-access-'+n,id);
            }
          });
          return id;
        }
        async cleanupInventory(family){
          return this.ctx.storage.sql.exec(
            'SELECT (SELECT count(*) FROM consents WHERE id=?) AS families,'+
            '(SELECT count(*) FROM codes WHERE consent=?) AS codes,'+
            '(SELECT count(*) FROM refresh_tokens WHERE consent=?) AS refresh,'+
            '(SELECT count(*) FROM access_tokens WHERE consent=?) AS access',family,family,family,family).one();
        }
        async expire(kind,value){
          const hash=await hmacSha256Hex(this.env.API_KEY_HASH_PEPPER,'runtime-oauth\\0'+value);
          if(kind==='access')this.ctx.storage.sql.exec('UPDATE access_tokens SET expires=0 WHERE hash=?',hash);
          if(kind==='code')this.ctx.storage.sql.exec('UPDATE codes SET expires=0 WHERE hash=?',hash);
          if(kind==='refresh')this.ctx.storage.sql.exec('UPDATE refresh_tokens SET expires=0 WHERE hash=?',hash);
          if(kind==='pending')this.ctx.storage.sql.exec('UPDATE pending SET expires=0 WHERE id=?',value);
          if(kind==='family')this.ctx.storage.sql.exec('UPDATE consents SET deadline=0 WHERE client=?',value);
          if(kind==='scope')this.ctx.storage.sql.exec("UPDATE consents SET scope='' WHERE client=?",value);
          if(kind==='time')fixtureTime=Number(value);
          if(kind==='tick'){
            fixtureTime+=Number(value);
            for(const [id,timer] of [...timers].sort((a,b)=>a[1].at-b[1].at))if(timer.at<=fixtureTime&&timers.delete(id))timer.callback();
          }
          return true;
        }
      }
      import {RuntimeCredentials} from './src/runtime/credentials';
      export class RuntimeCredentialsFixture extends RuntimeCredentials {
        putFails=false;cleanFails=false;
        failWrite(value){this.putFails=value;return true;}
        failClean(value){this.cleanFails=value;return true;}
        async put(...args){if(this.putFails)throw new Error('Synthetic credential write unavailable');return super.put(...args);}
        async clean(...args){if(this.cleanFails)throw new Error('Synthetic credential cleanup unavailable');return super.clean(...args);}
        hold;release;entered=false;
        holdRead(){this.hold=new Promise(resolve=>{this.release=resolve;});this.entered=false;return true;}
        releaseRead(){this.release?.();this.hold=undefined;return true;}
        readState(){return {entered:this.entered};}
        async read(...args){this.entered=true;if(this.hold)await this.hold;return super.read(...args);}
      }
      import {handleRequest} from './src/router';
      import {RUNTIME_PROFILES} from './src/runtime/profiles';
      // Test-only reviewed profile. No arbitrary profile/URL input is exported
      // by the production Worker. Both profiles use the unchanged relay core.
      RUNTIME_PROFILES['synthetic.catalog']={revision:1,upstream:'https://catalog.example.test/rpc',credentialHeader:'X-Synthetic-Credential',transport:'request-scoped'};
      export default {async fetch(request,env,ctx){
        if(new URL(request.url).hostname==='fixture.internal') {
          const {kind,value}=await request.json();
          const secrets=env.RUNTIME_CREDENTIALS.getByName('design');
          if(kind==='fail-write')return Response.json({done:await secrets.failWrite(value==='true')});
          if(kind==='fail-clean')return Response.json({done:await secrets.failClean(value==='true')});
          if(kind==='hold-read')return Response.json({done:await secrets.holdRead()});
          if(kind==='release-read')return Response.json({done:await secrets.releaseRead()});
          if(kind==='read-state')return Response.json(await secrets.readState());
          const owner=env.RUNTIME_OAUTH.getByName('organization');
          if(kind==='hold-terminal')return Response.json({done:await owner.holdTerminal()});
          if(kind==='release-terminal')return Response.json({done:await owner.releaseTerminal()});
          if(kind==='relay-inventory')return Response.json(await owner.relayInventory(value));
          if(kind==='inventory')return Response.json(await owner.cleanupInventory(value));
          if(kind==='backlog')return Response.json({family:await owner.cleanupBacklog(value)});
          if(kind==='clean')await owner.runCleanup();else await owner.expire(kind,value);
          return Response.json({done:true});
        }
        return handleRequest(request,env,ctx,{fetch:(input,init)=>env.SYNTHETIC_UPSTREAM.fetch(new Request(input,init)),now:()=>new Date()});
      }};`},
    bundle:true,write:false,format:"esm",platform:"node",external:["cloudflare:workers"],
    banner:{js:'import {createRequire} from "node:module";const require=createRequire("/");'},
    define:{"process.env.NODE_ENV":'"production"'},logLevel:"silent"
  });
  const bindings={
    ADMIN_DASHBOARD_HOST:new URL(issuer).hostname,CONSOLE_EMAIL_DOMAIN:"example.test",
    ADMIN_SECRET:"synthetic-operator",API_KEY_HASH_PEPPER:"synthetic-pepper",TOKEN_ENCRYPTION_KEY_V1:"synthetic-root",
    RUNTIME_INSTALLATIONS:JSON.stringify([
      {id:"design",resource:RESOURCE,profile:"google.stitch",label:"Design"},
      {id:"other",resource:OTHER_RESOURCE,profile:"synthetic.catalog",label:"Other"}
    ])
  };
  const runtime=new Miniflare(convertV4MiniflareOptions({modules:true,script:compiled.outputFiles[0]!.text,
    compatibilityDate:"2026-06-24",compatibilityFlags:["nodejs_compat","enable_request_signal","request_signal_passthrough"],bindings,d1Databases:{DB:"runtime-test"},
    serviceBindings:{SYNTHETIC_UPSTREAM:options.upstream??syntheticMcp},
    durableObjects:{RUNTIME_OAUTH:{className:"RuntimeOAuthFixture",useSQLite:true},RUNTIME_CREDENTIALS:{className:"RuntimeCredentialsFixture",useSQLite:true}},
    ...(persist?{resourcePersistencePath:persist}:{})
  }));
  try {
    const db=await runtime.getD1Database("DB") as D1Database;
    const restored=!!await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='users'").first();
    if(!restored)for(const file of readdirSync(new URL("../../migrations/",import.meta.url)).filter(f=>/^\d{4}_.+\.sql$/.test(f)).sort()) {
      const sql=readFileSync(new URL(`../../migrations/${file}`,import.meta.url),"utf8");
      await db.batch(unstable_splitSqlQuery(sql).map(statement=>db.prepare(statement)));
    }
    if(!restored)for(const id of ["member","other","admin"])await db.prepare(`INSERT INTO users
      (id,email,canonical_email,account_kind,role,status,login_capable,created_at,updated_at)
      VALUES(?,?,?,'human',?,'active',1,?,?)`).bind(id,`${id}@example.test`,`${id}@example.test`,id==="admin"?"admin":"user",new Date().toISOString(),new Date().toISOString()).run();
    const env={...bindings,DB:db} as Env;
    const cookies=new Map<string,string>();
    for(const id of ["member","other","admin"]) cookies.set(id,`__Host-mini-console=${await createConsoleSession(env,{id,email:`${id}@example.test`,sessionEpoch:0})}`);
    const admin=async(id:string,body:unknown)=>runtime.dispatchFetch(`https://api.trustedtunnel.app/admin/runtime-installations/${id}`,{method:"POST",headers:{Authorization:"Bearer synthetic-operator","Content-Type":"application/json"},body:JSON.stringify(body)}) as Promise<Response>;
    if(!restored)for(const id of ["design","other"]) {
      for(const body of [{action:"configure"},{action:"supply",expectedRevision:1,operationId:"initial",authority:"rebind",material:id==="design"?"synthetic-stitch-key":"synthetic-catalog-key"},{action:"enable",expectedRevision:2,operationId:"enable"}]) {
        const response=await admin(id,body);const ok=response.ok;await response.body?.cancel();if(!ok)throw new Error("Synthetic Runtime setup failed");
      }
      const granted=await runtime.dispatchFetch(`https://api.trustedtunnel.app/admin/runtime-installations/${id}/access/member`,{method:"PUT",headers:{Authorization:"Bearer synthetic-operator","Content-Type":"application/json"},body:JSON.stringify({state:"granted",expectedRevision:0,expiresAt:null})});
      const ok=granted.ok;await granted.body?.cancel();if(!ok)throw new Error("Synthetic Runtime grant failed");
    }
    const expire=(kind:string,value="")=>runtime.dispatchFetch("https://fixture.internal/expire",{method:"POST",body:JSON.stringify({kind,value})}) as Promise<Response>;
    return {issuer,runtime,db,env,cookies,admin,expire,dispose:()=>runtime.dispose() as Promise<void>};
  } catch(error){await runtime.dispose();throw error;}
}

/** External task seam only. Authentication and projection remain production. */
async function syntheticMcp(request:Request):Promise<Response> {
  if(!["https://stitch.googleapis.com/mcp","https://catalog.example.test/rpc"].includes(request.url))throw new Error("Unexpected synthetic upstream");
  const body=await request.json() as {id?:number;method:string};
  if(body.method==="initialize")return Response.json({jsonrpc:"2.0",id:body.id,result:{protocolVersion:"2025-11-25",capabilities:{tools:{}},serverInfo:{name:"synthetic-runtime",version:"1"}}});
  if(body.method==="notifications/initialized")return new Response(null,{status:202});
  if(body.method==="tools/list")return Response.json({jsonrpc:"2.0",id:body.id,result:{tools:[{name:"synthetic_probe",description:"Synthetic admission proof",inputSchema:{type:"object",properties:{}}}]}});
  return Response.json({jsonrpc:"2.0",id:body.id,result:{content:[{type:"text",text:"Synthetic task completed"}]}});
}

export type OAuthFixture=Awaited<ReturnType<typeof oauthFixture>>;
export async function pendingConsent(f:OAuthFixture,resource=RESOURCE,clientId?:string,member:string|null="member") {
  if(!clientId) {
    const registered=await f.runtime.dispatchFetch(`${f.issuer}/runtime/register`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({client_name:"Synthetic client",redirect_uris:["http://127.0.0.1:9/callback"],token_endpoint_auth_method:"none"})});
    const data=await registered.json() as {client_id:string};clientId=data.client_id;
  }
  const verifier="v".repeat(43);
  const query=new URLSearchParams({response_type:"code",client_id:clientId,redirect_uri:"http://127.0.0.1:1234/callback",resource,scope:"runtime.use",state:"synthetic-state",code_challenge:createHash("sha256").update(verifier).digest("base64url"),code_challenge_method:"S256"});
  const begun=await f.runtime.dispatchFetch(`${f.issuer}/runtime/authorize?${query}`,{headers:member?{Cookie:f.cookies.get(member)!}:{},redirect:"manual"});
  if(begun.status!==303||!begun.headers.has("Set-Cookie"))throw new Error("Synthetic consent setup failed");
  const target=new URL(begun.headers.get("Location")!,f.issuer);
  const cookie=`${member?`${f.cookies.get(member)}; `:""}${begun.headers.get("Set-Cookie")!.split(";",1)[0]}`;
  const decide=(decision="allow",origin=f.issuer)=>f.runtime.dispatchFetch(target.href,{method:"POST",headers:{Cookie:cookie,Origin:origin,"Content-Type":"application/x-www-form-urlencoded"},body:new URLSearchParams({decision}).toString(),redirect:"manual"});
  return {clientId,query,cookie,target,verifier,decide};
}
export async function authorizedTokens(f:OAuthFixture,resource=RESOURCE,member="member") {
  const pending=await pendingConsent(f,resource,undefined,member);
  const response=await pending.decide();
  if(response.status!==303||!response.headers.has("Location"))throw new Error("Synthetic consent decision failed");
  const callback=new URL(response.headers.get("Location")!);
  const body={grant_type:"authorization_code",client_id:pending.clientId,code:callback.searchParams.get("code")!,redirect_uri:pending.query.get("redirect_uri")!,resource,code_verifier:pending.verifier};
  const token=await tokenRequest(f,body);
  if(token.status!==200)throw new Error("Synthetic exchange failed");
  const tokens=await token.json() as {access_token:string;refresh_token:string};
  return {...pending,body,tokens};
}
export function tokenRequest(f:OAuthFixture,body:Record<string,string>) {
  return f.runtime.dispatchFetch(`${f.issuer}/runtime/token`,{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"},body:new URLSearchParams(body).toString()}) as Promise<Response>;
}
export function resourceRequest(f:OAuthFixture,token:string,resource=RESOURCE) {
  return f.runtime.dispatchFetch(resource,{method:"POST",headers:{Authorization:`Bearer ${token}`,"Content-Type":"application/json"},body:JSON.stringify({jsonrpc:"2.0",id:1,method:"tools/list"})}) as Promise<Response>;
}
