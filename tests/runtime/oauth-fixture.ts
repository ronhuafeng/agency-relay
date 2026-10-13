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
export async function oauthFixture(persist?:string) {
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
      import {RuntimeOAuth} from './src/runtime/oauth';
      import {hmacSha256Hex} from './src/crypto';
      export class RuntimeOAuthFixture extends RuntimeOAuth {
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
        }
        async cleanupInventory(client){
          return this.ctx.storage.sql.exec(
            'SELECT (SELECT count(*) FROM consents WHERE client=?) AS families,'+
            '(SELECT count(*) FROM codes WHERE consent IN (SELECT id FROM consents WHERE client=?)) AS codes,'+
            '(SELECT count(*) FROM refresh_tokens WHERE consent IN (SELECT id FROM consents WHERE client=?)) AS refresh,'+
            '(SELECT count(*) FROM access_tokens WHERE consent IN (SELECT id FROM consents WHERE client=?)) AS access',client,client,client,client).one();
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
          return true;
        }
      }
      export {RuntimeCredentials} from './src/runtime/credentials';
      import worker from './src/index';
      import {admitRuntimeRequest} from './src/runtime/authorization';
      export default {async fetch(request,env,ctx){
        if(new URL(request.url).hostname==='fixture.internal') {
          const {kind,value}=await request.json();
          const owner=env.RUNTIME_OAUTH.getByName('organization');
          if(kind==='inventory')return Response.json(await owner.cleanupInventory(value));
          if(kind==='backlog')await owner.cleanupBacklog(value);
          else if(kind==='clean')await owner.runCleanup();else await owner.expire(kind,value);
          return Response.json({done:true});
        }
        const admitted=await admitRuntimeRequest(request,env);
        if(admitted instanceof Response)return admitted;
        if(admitted) {
          const body=await request.json();
          if(body.method==='initialize')return Response.json({jsonrpc:'2.0',id:body.id,result:{protocolVersion:'2025-11-25',capabilities:{tools:{}},serverInfo:{name:'synthetic-runtime',version:'1'}}});
          if(body.method==='notifications/initialized')return new Response(null,{status:202});
          if(body.method==='tools/list')return Response.json({jsonrpc:'2.0',id:body.id,result:{tools:[{name:'synthetic_probe',description:'Synthetic admission proof',inputSchema:{type:'object',properties:{}}}]}});
          return Response.json({jsonrpc:'2.0',id:body.id,result:{content:[{type:'text',text:'Synthetic task completed'}]}});
        }
        return worker.fetch(request,env,ctx);
      }};`},
    bundle:true,write:false,format:"esm",platform:"node",external:["cloudflare:workers"],
    banner:{js:'import {createRequire} from "node:module";const require=createRequire("/");'},
    define:{"process.env.NODE_ENV":'"production"'},logLevel:"silent"
  });
  const bindings={
    ADMIN_DASHBOARD_HOST:"console.example.test",CONSOLE_EMAIL_DOMAIN:"example.test",
    ADMIN_SECRET:"synthetic-operator",API_KEY_HASH_PEPPER:"synthetic-pepper",TOKEN_ENCRYPTION_KEY_V1:"synthetic-root",
    RUNTIME_INSTALLATIONS:JSON.stringify([
      {id:"design",resource:RESOURCE,profile:"google.stitch",label:"Design"},
      {id:"other",resource:OTHER_RESOURCE,profile:"google.stitch",label:"Other"}
    ])
  };
  const runtime=new Miniflare(convertV4MiniflareOptions({modules:true,script:compiled.outputFiles[0]!.text,
    compatibilityDate:"2026-06-24",compatibilityFlags:["nodejs_compat"],bindings,d1Databases:{DB:"runtime-test"},
    durableObjects:{RUNTIME_OAUTH:{className:"RuntimeOAuthFixture",useSQLite:true},RUNTIME_CREDENTIALS:{className:"RuntimeCredentials",useSQLite:true}},
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
      for(const body of [{action:"configure"},{action:"supply",expectedRevision:1,operationId:"initial",authority:"rebind",material:"synthetic-stitch-key"},{action:"enable",expectedRevision:2,operationId:"enable"}]) {
        const response=await admin(id,body);if(!response.ok)throw new Error("Synthetic Runtime setup failed");
      }
      const granted=await runtime.dispatchFetch(`https://api.trustedtunnel.app/admin/runtime-installations/${id}/access/member`,{method:"PUT",headers:{Authorization:"Bearer synthetic-operator","Content-Type":"application/json"},body:JSON.stringify({state:"granted",expectedRevision:0,expiresAt:null})});
      if(!granted.ok)throw new Error("Synthetic Runtime grant failed");
    }
    const expire=(kind:string,value="")=>runtime.dispatchFetch("https://fixture.internal/expire",{method:"POST",body:JSON.stringify({kind,value})}) as Promise<Response>;
    return {runtime,db,cookies,admin,expire,dispose:()=>runtime.dispose() as Promise<void>};
  } catch(error){await runtime.dispose();throw error;}
}

export type OAuthFixture=Awaited<ReturnType<typeof oauthFixture>>;
export async function pendingConsent(f:OAuthFixture,resource=RESOURCE,clientId?:string,member:string|null="member") {
  if(!clientId) {
    const registered=await f.runtime.dispatchFetch(`${ISSUER}/runtime/register`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({client_name:"Synthetic client",redirect_uris:["http://127.0.0.1:9/callback"],token_endpoint_auth_method:"none"})});
    const data=await registered.json() as {client_id:string};clientId=data.client_id;
  }
  const verifier="v".repeat(43);
  const query=new URLSearchParams({response_type:"code",client_id:clientId,redirect_uri:"http://127.0.0.1:1234/callback",resource,scope:"runtime.use",state:"synthetic-state",code_challenge:createHash("sha256").update(verifier).digest("base64url"),code_challenge_method:"S256"});
  const begun=await f.runtime.dispatchFetch(`${ISSUER}/runtime/authorize?${query}`,{headers:member?{Cookie:f.cookies.get(member)!}:{},redirect:"manual"});
  if(begun.status!==303||!begun.headers.has("Set-Cookie"))throw new Error("Synthetic consent setup failed");
  const target=new URL(begun.headers.get("Location")!,ISSUER);
  const cookie=`${member?`${f.cookies.get(member)}; `:""}${begun.headers.get("Set-Cookie")!.split(";",1)[0]}`;
  const decide=(decision="allow",origin=ISSUER)=>f.runtime.dispatchFetch(target.href,{method:"POST",headers:{Cookie:cookie,Origin:origin,"Content-Type":"application/x-www-form-urlencoded"},body:new URLSearchParams({decision}).toString(),redirect:"manual"});
  return {clientId,query,cookie,target,verifier,decide};
}
export async function authorizedTokens(f:OAuthFixture,resource=RESOURCE) {
  const pending=await pendingConsent(f,resource);
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
  return f.runtime.dispatchFetch(`${ISSUER}/runtime/token`,{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"},body:new URLSearchParams(body).toString()}) as Promise<Response>;
}
export function resourceRequest(f:OAuthFixture,token:string,resource=RESOURCE) {
  return f.runtime.dispatchFetch(resource,{method:"POST",headers:{Authorization:`Bearer ${token}`,"Content-Type":"application/json"},body:JSON.stringify({jsonrpc:"2.0",id:1,method:"tools/list"})}) as Promise<Response>;
}
