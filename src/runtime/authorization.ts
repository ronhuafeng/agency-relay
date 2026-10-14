import {plansForHostname} from "../plans/execution-plans";
import {runtimeInstallations,RUNTIME_SCOPE} from "./profiles";
import {base64UrlEncode,hmacSha256Hex} from "../crypto";
import {runtimeBrowserSessionHash as browserSessionHash} from "./member";
import {assertConsoleBrowserWrite} from "../admin/browser-write";
import {consoleDocument} from "../admin/console-shell";
import {RuntimeConsent,RuntimeConsentFailure} from "../admin/ui/pages/runtime-consent";
import {createElement} from "react";
import type {RuntimeAdmission} from "./oauth";
import {HttpError} from "../errors";

const BINDING_COOKIE="__Host-runtime-transaction";
const CONSENT_PATH=/^\/runtime\/consent\/[a-f0-9-]{36}$/;
class OAuthInputError extends Error {}

/** Exact issuer/resource role dispatch, independent of Provider bearer auth. */
export async function runtimeAuthorizationResponse(request:Request,env:Env):Promise<Response|null> {
  const url=new URL(request.url);
  const issuer=`https://${env.ADMIN_DASHBOARD_HOST}`;
  if(plansForHostname(url.hostname))return null;
  try {
    const installations=runtimeInstallations(env);
    if(url.origin===issuer&&url.pathname==="/runtime/integrations"&&request.method==="GET"&&!url.search) {
      const reply=await env.RUNTIME_OAUTH.getByName("organization").memberData(await browserSessionHash(env,request));
      return Response.json(reply.body,{status:reply.status,headers:{"Cache-Control":"no-store","Referrer-Policy":"no-referrer"}});
    }
    if(!installations.length)return null;
    const resource=installations.find(item=>resourceMetadataUrl(item.resource)===url.href);
    if(request.method==="GET"&&resource)
      return protocolResponse({resource:resource.resource,authorization_servers:[issuer],bearer_methods_supported:["header"],scopes_supported:[RUNTIME_SCOPE]});
    if(url.origin!==issuer)return null;
    if(request.method==="OPTIONS"&&!url.search&&["/runtime/register","/runtime/token"].includes(url.pathname)) {
      if(request.headers.get("Access-Control-Request-Method")!=="POST")return protocolResponse({error:"invalid_request"},405);
      return new Response(null,{status:204,headers:{"Access-Control-Allow-Origin":"*","Access-Control-Allow-Methods":"POST","Access-Control-Allow-Headers":"Content-Type","Cache-Control":"no-store"}});
    }
    if(url.pathname==="/.well-known/oauth-authorization-server"&&request.method==="GET"&&!url.search)
      return protocolResponse({issuer,authorization_endpoint:`${issuer}/runtime/authorize`,token_endpoint:`${issuer}/runtime/token`,
        registration_endpoint:`${issuer}/runtime/register`,response_types_supported:["code"],grant_types_supported:["authorization_code","refresh_token"],
        code_challenge_methods_supported:["S256"],token_endpoint_auth_methods_supported:["none"],scopes_supported:[RUNTIME_SCOPE]});
    if(url.pathname==="/runtime/register"&&request.method==="POST"&&!url.search) {
      if(!env.RUNTIME_OAUTH)return protocolResponse({error:"temporarily_unavailable"},503);
      if(!await env.RUNTIME_OAUTH.getByName("organization").protocolAttempt("registration"))return protocolResponse({error:"invalid_request"},429);
      if(request.headers.get("Content-Type")?.split(";",1)[0]?.trim()!=="application/json")return protocolResponse({error:"invalid_request"},400);
      const input:unknown=JSON.parse(await readOAuthBody(request));
      if(!input||typeof input!=="object"||Array.isArray(input))return protocolResponse({error:"invalid_request"},400);
      const reply=await env.RUNTIME_OAUTH.getByName("organization").register(input as Record<string,unknown>);
      return protocolResponse(reply.body,reply.status);
    }
    if(url.pathname==="/runtime/authorize"&&request.method==="GET") {
      const query=uniqueFields(url.searchParams,["response_type","client_id","redirect_uri","resource","scope","state","code_challenge","code_challenge_method"]);
      const binding=base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)));
      const reply=await env.RUNTIME_OAUTH.getByName("organization").begin(query,await oauthHash(env,binding),await browserSessionHash(env,request));
      if(!reply.location)return protocolResponse(reply.body,reply.status);
      return new Response(null,{status:303,headers:{Location:reply.location,"Set-Cookie":`${BINDING_COOKIE}=${binding}; HttpOnly; Secure; Path=/; SameSite=Lax; Max-Age=600`,"Cache-Control":"no-store","Referrer-Policy":"no-referrer"}});
    }
    if(CONSENT_PATH.test(url.pathname)&&!url.search&&(request.method==="GET"||request.method==="POST")) {
      if(request.method==="POST")assertConsoleBrowserWrite(request,env,url);
      const binding=cookie(request,BINDING_COOKIE);
      if(!binding)return consentFailure(403);
      let decision:"allow"|"deny"|undefined;
      if(request.method==="POST") {
        if(request.headers.get("Content-Type")?.split(";",1)[0]?.trim()!=="application/x-www-form-urlencoded")return protocolResponse({error:"invalid_request"},400);
        const form=uniqueFields(new URLSearchParams(await readOAuthBody(request)),["decision"]);
        if(form.decision!=="allow"&&form.decision!=="deny")return protocolResponse({error:"invalid_request"},400);
        decision=form.decision;
      }
      const reply=await env.RUNTIME_OAUTH.getByName("organization").consent(url.pathname.split("/").at(-1)!,await oauthHash(env,binding),await browserSessionHash(env,request),decision);
      if(reply.location)return new Response(null,{status:303,headers:{Location:reply.location,"Cache-Control":"no-store","Referrer-Policy":"no-referrer"}});
      if(reply.status!==200)return consentFailure(reply.status);
      const data=reply.body as {id:string;client_name:string;resource:string;scope:string;email:string;redirect_uri:string};
      return new Response(consoleDocument({title:"授权客户端 · Agency Relay",email:data.email,
        main:createElement(RuntimeConsent,{...data,action:url.pathname})}),{headers:{
        // Native same-origin form POST needs a non-null Origin. No referrer is
        // sent to the external client callback under this same-origin policy.
        "Content-Type":"text/html; charset=utf-8","Cache-Control":"no-store","Referrer-Policy":"same-origin",
        // Only the validated callback origin may receive the form's 303 return.
        "Content-Security-Policy":`default-src 'none'; style-src 'self'; base-uri 'none'; form-action 'self' ${new URL(data.redirect_uri).origin}; frame-ancestors 'none'`,
        "X-Frame-Options":"DENY","X-Content-Type-Options":"nosniff","X-Robots-Tag":"noindex, nofollow"
      }});
    }
    if(url.pathname==="/runtime/token"&&request.method==="POST"&&!url.search) {
      if(!await env.RUNTIME_OAUTH.getByName("organization").protocolAttempt("token"))return protocolResponse({error:"invalid_request"},429);
      const reply=await env.RUNTIME_OAUTH.getByName("organization").token(await readOAuthBody(request),request.headers.get("Content-Type"),request.headers.has("Authorization"));
      return protocolResponse(reply.body,reply.status);
    }
    if(!url.search&&(url.pathname==="/runtime/clients"&&request.method==="GET"
      || /^\/runtime\/clients\/[a-f0-9-]{36}$/.test(url.pathname)&&request.method==="DELETE")) {
      assertConsoleBrowserWrite(request,env,url);
      const reply=await env.RUNTIME_OAUTH.getByName("organization").clientConsents(await browserSessionHash(env,request),request.method==="DELETE"?url.pathname.split("/").at(-1):undefined);
      return Response.json(reply.body,{status:reply.status,headers:{"Cache-Control":"no-store","Referrer-Policy":"no-referrer"}});
    }
    if(url.pathname.startsWith("/runtime/"))return protocolResponse({error:"invalid_request"},404);
    return null;
  } catch(error) {
    if(error instanceof HttpError)return protocolResponse({error:error.status===403?"access_denied":"temporarily_unavailable"},error.status);
    return error instanceof OAuthInputError||error instanceof SyntaxError
      ?protocolResponse({error:"invalid_request"},400):protocolResponse({error:"temporarily_unavailable"},503);
  }
}

function consentFailure(status:number):Response {
  return new Response(consoleDocument({title:"授权未完成 · Agency Relay",main:createElement(RuntimeConsentFailure,{status})}),{
    status,headers:{"Content-Type":"text/html; charset=utf-8","Cache-Control":"no-store","Referrer-Policy":"no-referrer",
      "Content-Security-Policy":"default-src 'none'; style-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      "X-Frame-Options":"DENY","X-Content-Type-Options":"nosniff","X-Robots-Tag":"noindex, nofollow"}
  });
}

/** Transport consumes this exact immutable admission. Never reads request body. */
export async function admitRuntimeRequest(request:Request,env:Env):Promise<RuntimeAdmission|Response|null> {
  const url=new URL(request.url);
  if(plansForHostname(url.hostname)||url.origin===`https://${env.ADMIN_DASHBOARD_HOST}`)return null;
  try {
    const installations=runtimeInstallations(env);
    const installation=installations.find(item=>item.resource===url.href);
    if(!installation) {
      if(!installations.some(item=>new URL(item.resource).origin===url.origin)
        || installations.some(item=>resourceMetadataUrl(item.resource)===url.href))return null;
      return protocolResponse({error:"invalid_request"},404);
    }
    if(request.method!=="POST")return protocolResponse({error:"invalid_request"},405);
    if(request.headers.has("Upgrade")||request.headers.has("Mcp-Session-Id")||request.headers.has("Last-Event-ID"))return protocolResponse({error:"runtime_transport_unsupported"},400);
    const version=request.headers.get("Mcp-Protocol-Version");
    // Absent during legacy initialize is forwarded, not invented by the relay.
    if(version!==null&&version!=="2025-11-25"&&version!=="2026-07-28")return protocolResponse({error:"runtime_transport_unsupported"},400);
    if(request.headers.has("Origin")&&request.headers.get("Origin")!==url.origin)return protocolResponse({error:"access_denied"},403);
    const header=request.headers.get("Authorization")??"";
    const token=/^Bearer ([A-Za-z0-9_-]{20,256})$/i.exec(header)?.[1];
    const admitted=token?await env.RUNTIME_OAUTH.getByName("organization").admit(token,installation.resource):null;
    if(admitted&&"installation_id" in admitted)return admitted;
    const response=protocolResponse(admitted?.body??{error:"invalid_token"},admitted?.status??401);
    if(response.status===401)response.headers.set("WWW-Authenticate",`Bearer resource_metadata="${resourceMetadataUrl(installation.resource)}", error="invalid_token"`);
    if(admitted?.body.error==="insufficient_scope")response.headers.set("WWW-Authenticate",`Bearer error="insufficient_scope", scope="${RUNTIME_SCOPE}"`);
    return response;
  } catch {return protocolResponse({error:"temporarily_unavailable"},503);}
}

/** RFC 9728 inserts the well-known suffix before the exact resource path. */
function resourceMetadataUrl(resource:string):string {
  const url=new URL(resource);
  return `${url.origin}/.well-known/oauth-protected-resource${url.pathname}`;
}

function protocolResponse(body:unknown,status=200):Response {
  return Response.json(body,{status,headers:{"Cache-Control":"no-store","Pragma":"no-cache","Referrer-Policy":"no-referrer","Access-Control-Allow-Origin":"*"}});
}
async function readOAuthBody(request:Request):Promise<string> {
  const reader=request.body?.getReader();if(!reader)throw new OAuthInputError();
  const chunks:Uint8Array[]=[];let size=0;
  let timer:ReturnType<typeof setTimeout>|undefined;
  const timeout=new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new OAuthInputError()),5000);});
  try {
    for(;;){
      const chunk=await Promise.race([reader.read(),timeout]);
      if(chunk.done)break;size+=chunk.value.byteLength;if(size>8192)throw new OAuthInputError();chunks.push(chunk.value);
    }
    const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
    return new TextDecoder("utf-8",{fatal:true}).decode(bytes);
  } catch {await reader.cancel();throw new OAuthInputError();} finally {if(timer!==undefined)clearTimeout(timer);reader.releaseLock();}
}

function uniqueFields(params:URLSearchParams,allowed:string[]):Record<string,string> {
  const fields:Record<string,string>={};
  for(const [key,value] of params) {
    if(!allowed.includes(key)||params.getAll(key).length!==1||value.length>2048)throw new OAuthInputError();
    fields[key]=value;
  }
  return fields;
}
function cookie(request:Request,name:string):string|null {
  const values=(request.headers.get("Cookie")??"").split(";").map(part=>part.trim()).filter(part=>part.startsWith(`${name}=`));
  return values.length===1?values[0]!.slice(name.length+1):null;
}
function oauthHash(env:Env,value:string):Promise<string> {return hmacSha256Hex(env.API_KEY_HASH_PEPPER,`runtime-oauth\0${value}`);}
