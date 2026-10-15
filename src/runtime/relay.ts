import {admitRuntimeRequest} from "./authorization";
import {requireRuntimeInstallation,RUNTIME_PROFILES} from "./profiles";
import {clientDrivenStream,ByteStreamError,type ByteStreamEnd} from "../proxy/byte-stream";
import type {AppDependencies} from "../types";
import type {RuntimeTransportError} from "./oauth";

const CONTENT_HEADERS=new Set(["accept","accept-encoding","accept-language","content-type","content-encoding","content-language"]);
const MCP_HEADERS=new Set(["mcp-protocol-version","mcp-method","mcp-name"]);
const MAX_UPLOAD_BYTES=8*1024*1024;
const IDLE_MS=60000;
class RelayFailure extends Error {constructor(readonly code:RuntimeTransportError){super(code);}}

/** Runtime's complete admission/projection/one-dispatch interface. Not a
 * Provider Attempt: opaque transport has no tool outcome or billing oracle. */
export async function relayRuntimeRequest(request:Request,env:Env,ctx:Pick<ExecutionContext,"waitUntil">,deps:AppDependencies):Promise<Response|null> {
  const admission=await admitRuntimeRequest(request,env);
  if(admission instanceof Response||admission===null)return admission;
  const installation=requireRuntimeInstallation(env,admission.installation_id);
  const profile=RUNTIME_PROFILES[installation.profile];
  const started=deps.now().getTime();
  let status:number|null=null;
  let attempted=false;
  let bytes=0;
  let requestBytes=0;
  let headersMs:number|null=null;
  let finished=false;
  let failure:RuntimeTransportError|null=null;
  const abortController=new AbortController();
  const stop=(code:RuntimeTransportError)=>{if(!abortController.signal.aborted){failure=code;abortController.abort();}};
  const clientAbort=()=>stop("client_request_aborted");
  request.signal.addEventListener("abort",clientAbort,{once:true});
  if(request.signal.aborted)clientAbort();
  const leaseTimer=setTimeout(()=>stop("lease_expired"),Math.max(0,admission.lease_expires_at-deps.now().getTime()));
  let idleTimer:ReturnType<typeof setTimeout>|undefined;
  let awaitingHeaders=false;
  const resetIdle=()=>{if(idleTimer!==undefined)clearTimeout(idleTimer);idleTimer=setTimeout(()=>stop("stream_idle_timeout"),IDLE_MS);};
  const aborted=new Promise<never>((_,reject)=>{
    const rejectAbort=()=>reject(new RelayFailure(failure??"client_request_aborted"));
    abortController.signal.addEventListener("abort",rejectAbort,{once:true});
    if(abortController.signal.aborted)rejectAbort();
  });
  // The same abort promise is raced at both external waits, not new budgets.
  // Catch also owns a late abort when no wait remains.
  void aborted.catch(()=>undefined);
  const finish=(kind:ByteStreamEnd,error:RuntimeTransportError|null=null)=>{
    if(finished)return;finished=true;
    awaitingHeaders=false;
    clearTimeout(leaseTimer);if(idleTimer!==undefined)clearTimeout(idleTimer);
    request.signal.removeEventListener("abort",clientAbort);
    abortController.abort();
    const recording=env.RUNTIME_OAUTH.getByName("organization").completeLease(admission.lease_id,{
      attempted,upstream_status:status,terminal:kind,error,duration_ms:Math.max(0,deps.now().getTime()-started),
      headers_ms:headersMs,request_bytes_observed:requestBytes,response_bytes_observed:bytes
    }).catch(()=>{console.error(JSON.stringify({event:"runtime_terminal_record_unavailable"}));});
    try{ctx.waitUntil(recording);}catch{/* Recording cannot replace transport. */}
  };
  try{
    if(admission.profile!==installation.profile||admission.profile_revision!==profile.revision){finish("error","runtime_profile_unavailable");return runtimeFailure(503,"runtime_profile_unavailable");}
    const length=request.headers.get("Content-Length");
    if(length!==null&&/^\d+$/.test(length)&&Number(length)>MAX_UPLOAD_BYTES){finish("error","request_too_large");return runtimeFailure(413,"request_too_large");}
    const material=await Promise.race([env.RUNTIME_CREDENTIALS.getByName(installation.id).read(installation.id,admission.credential_ref,admission.credential_revision),aborted])
      .catch(error=>{throw error instanceof RelayFailure?error:new RelayFailure("upstream_credential_unavailable");});
    if(!material){finish("error","upstream_credential_unavailable");return runtimeFailure(503,"upstream_credential_unavailable");}
    const headers=projectHeaders(request.headers,true);
    headers.set(profile.credentialHeader,material);
    const upload=request.body?clientDrivenStream(request.body,abortController.signal,{
      maxBytes:MAX_UPLOAD_BYTES,idleMs:IDLE_MS,
      onChunk:chunk=>{requestBytes+=chunk.byteLength;if(awaitingHeaders)resetIdle();},
      onEnd:(kind,error)=>{if(kind==="error")stop(error instanceof ByteStreamError&&error.code==="byte_limit_exceeded"?"request_too_large":error instanceof ByteStreamError?"stream_idle_timeout":"upstream_transport_failed");}
    }):null;
    if(abortController.signal.aborted)throw new RelayFailure(failure??"client_request_aborted");
    awaitingHeaders=true;resetIdle();
    attempted=true;
    const upstream=await Promise.race([deps.fetch(profile.upstream,{method:"POST",headers,body:upload,redirect:"manual",signal:abortController.signal}),aborted]);
    awaitingHeaders=false;
    if(idleTimer!==undefined){clearTimeout(idleTimer);idleTimer=undefined;}
    headersMs=Math.max(0,deps.now().getTime()-started);
    status=upstream.status;
    const error=status>=300&&status<400?"upstream_redirect_rejected":status===401||status===403?"upstream_credential_unavailable":upstream.headers.has("Mcp-Session-Id")?"runtime_transport_unsupported":null;
    if(error){void upstream.body?.cancel().catch(()=>undefined);finish("error",error);return runtimeFailure(502,error);}
    const responseHeaders=projectHeaders(upstream.headers,false);
    responseHeaders.set("Cache-Control","no-store");
    responseHeaders.set("Referrer-Policy","no-referrer");
    const body=upstream.body?clientDrivenStream(upstream.body,abortController.signal,{
      idleMs:IDLE_MS,onChunk:(chunk)=>{bytes=Math.min(Number.MAX_SAFE_INTEGER,bytes+chunk.byteLength);},
      onEnd:(kind,error)=>{
        const code=failure??(error instanceof ByteStreamError?"stream_idle_timeout":kind==="error"?"upstream_transport_failed":null);
        finish(code&&code!=="client_request_aborted"?"error":kind,code);
      }
    }):null;
    if(!body)finish("completed");
    return new Response(body,{status:upstream.status,statusText:upstream.statusText,headers:responseHeaders});
  }catch(error){
    const code=error instanceof RelayFailure?error.code:failure??"upstream_transport_failed";
    finish(code==="client_request_aborted"?"cancelled":"error",code);
    return runtimeFailure(code==="client_request_aborted"?499:code==="request_too_large"?413:code==="stream_idle_timeout"||code==="lease_expired"?504:code==="upstream_credential_unavailable"?503:502,code);
  }
}

/** Explicit protocol/content allowlist: credentials/custom response challenges
 * have no forwarding path. Per-tool modern envelope fields stay opaque. */
function projectHeaders(incoming:Headers,requestSide:boolean):Headers {
  const headers=new Headers();
  const hopNames=new Set((incoming.get("Connection")??"").split(",").map(name=>name.trim().toLowerCase()));
  incoming.forEach((value,name)=>{
    if(hopNames.has(name))return;
    if(CONTENT_HEADERS.has(name)&& (requestSide||!name.startsWith("accept")) || MCP_HEADERS.has(name)
      ||requestSide&&/^mcp-param-[a-z0-9-]+$/.test(name) ||!requestSide&&name==="retry-after")headers.set(name,value);
  });
  return headers;
}
function runtimeFailure(status:number,error:string):Response {
  return Response.json({error},{status,headers:{"Cache-Control":"no-store","Referrer-Policy":"no-referrer"}});
}
