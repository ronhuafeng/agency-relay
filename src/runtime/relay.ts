import {admitRuntimeRequest} from "./authorization";
import {requireRuntimeInstallation,RUNTIME_PROFILES} from "./profiles";
import {connectionHeaderNames} from "../proxy/adapter";
import {cancelUnreadBody,clientDrivenStream,ByteStreamError,copyBytes,type ByteStreamEnd} from "../proxy/byte-stream";
import type {AppDependencies} from "../types";
import type {RuntimeTransportError} from "./oauth";

const CONTENT_HEADERS=new Set(["accept","accept-encoding","accept-language","content-type","content-encoding","content-language"]);
const MCP_HEADERS=new Set(["mcp-protocol-version","mcp-method","mcp-name"]);
const MAX_UPLOAD_BYTES=8*1024*1024;
const IDLE_MS=60000;
const DEFINITE_RESPONSE_BYTES=65536;
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
    if(error){void cancelUnreadBody(upstream);finish("error",error);return runtimeFailure(502,error);}
    const responseHeaders=projectHeaders(upstream.headers,false);
    responseHeaders.set("Cache-Control","no-store");
    responseHeaders.set("Referrer-Policy","no-referrer");
    const framed=await frameUpstreamBody(upstream,abortController.signal,(chunk)=>{bytes=Math.min(Number.MAX_SAFE_INTEGER,bytes+chunk.byteLength);},(kind,error)=>{
      const code=failure??(error instanceof ByteStreamError?"stream_idle_timeout":kind==="error"?"upstream_transport_failed":null);
      finish(code&&code!=="client_request_aborted"?"error":kind,code);
    });
    if(framed.kind==="definite"){
      bytes=framed.bytes.byteLength;
      responseHeaders.set("Content-Length",String(framed.bytes.byteLength));
      finish("completed");
      return new Response(framed.bytes,{status:upstream.status,statusText:upstream.statusText,headers:responseHeaders});
    }
    return new Response(framed.stream,{status:upstream.status,statusText:upstream.statusText,headers:responseHeaders});
  }catch(error){
    const code=error instanceof RelayFailure?error.code:failure??"upstream_transport_failed";
    finish(code==="client_request_aborted"?"cancelled":"error",code);
    return runtimeFailure(code==="client_request_aborted"?499:code==="request_too_large"?413:code==="stream_idle_timeout"||code==="lease_expired"?504:code==="upstream_credential_unavailable"?503:502,code);
  }
}


async function frameUpstreamBody(upstream:Response,signal:AbortSignal,onChunk:(chunk:Uint8Array)=>void,onEnd:(kind:ByteStreamEnd,error?:unknown)=>void):Promise<{kind:"definite";bytes:Uint8Array<ArrayBuffer>}|{kind:"open";stream:ReadableStream<Uint8Array>}> {
  if(!upstream.body)return {kind:"definite",bytes:new Uint8Array(new ArrayBuffer(0))};
  const reader=upstream.body.getReader();
  const buffered:Uint8Array[]=[];
  let total=0;
  let pending:Promise<ReadableStreamReadResult<Uint8Array>>|undefined;
  const timers=nativeTimers();
  const open=(queued:Promise<ReadableStreamReadResult<Uint8Array>>|undefined)=>({kind:"open" as const,stream:clientDrivenStream(remainingBody(reader,buffered.splice(0),queued),signal,{idleMs:IDLE_MS,onChunk,onEnd})});
  try{
    while(total<=DEFINITE_RESPONSE_BYTES){
      if(signal.aborted)throw new Error("relay_aborted");
      const read=reader.read();
      pending=read;
      let timer:ReturnType<typeof setTimeout>|undefined;
      const outcome=await Promise.race([
        read.then(result=>({kind:"read" as const,result})).catch(error=>({kind:"error" as const,error})),
        new Promise<{kind:"wait"}>(resolve=>{timer=timers.set(()=>resolve({kind:"wait"}),0);})
      ]);
      if(timer!==undefined)timers.clear(timer);
      if(outcome.kind==="wait"){
        if(signal.aborted)throw new Error("relay_aborted");
        return open(pending);
      }
      pending=undefined;
      if(outcome.kind==="error")throw outcome.error;
      if(outcome.result.done){
        try{reader.releaseLock();}catch{/* The completed reader is already released. */}
        return {kind:"definite",bytes:copyBytes(buffered,total)};
      }
      buffered.push(outcome.result.value);
      total+=outcome.result.value.byteLength;
      if(total>DEFINITE_RESPONSE_BYTES)return open(undefined);
    }
  }catch(error){
    await reader.cancel().catch(()=>undefined);
    try{reader.releaseLock();}catch{/* The failed reader is already released. */}
    throw error;
  }
  throw new Error("relay_frame_invariant");
}

/** Bytes already pulled stay in order ahead of the one in-flight read.
 * A second read on this reader would be rejected. */
function remainingBody(reader:ReadableStreamDefaultReader<Uint8Array>,prefix:Uint8Array[],pending?:Promise<ReadableStreamReadResult<Uint8Array>>):ReadableStream<Uint8Array> {
  const queued=prefix;
  let next=pending;
  const release=()=>{try{reader.releaseLock();}catch{/* The reader is already released. */}};
  return new ReadableStream<Uint8Array>({
    async pull(controller){
      if(queued.length>0){controller.enqueue(queued.shift()!);return;}
      const result=next?await next:await reader.read();
      next=undefined;
      if(result.done){release();controller.close();return;}
      controller.enqueue(result.value);
    },
    async cancel(reason){try{await reader.cancel(reason);}finally{release();}}
  },{highWaterMark:0});
}

function nativeTimers():{set:typeof setTimeout;clear:typeof clearTimeout} {
  const host=globalThis as {__nativeSetTimeout?:typeof setTimeout;__nativeClearTimeout?:typeof clearTimeout};
  return {set:host.__nativeSetTimeout??setTimeout,clear:host.__nativeClearTimeout??clearTimeout};
}

/** Explicit protocol/content allowlist: credentials/custom response challenges
 * have no forwarding path. Per-tool modern envelope fields stay opaque. */
function projectHeaders(incoming:Headers,requestSide:boolean):Headers {
  const headers=new Headers();
  const hopNames=connectionHeaderNames(incoming.get("Connection"));
  incoming.forEach((value,name)=>{
    if(hopNames.has(name))return;
    // Response accept* headers are request metadata, not content.
    const content=CONTENT_HEADERS.has(name)&&(requestSide||!name.startsWith("accept"));
    const mcpParameter=requestSide&&/^mcp-param-[a-z0-9-]+$/.test(name);
    const retryAfter=!requestSide&&name==="retry-after";
    if(content||MCP_HEADERS.has(name)||mcpParameter||retryAfter)headers.set(name,value);
  });
  return headers;
}
function runtimeFailure(status:number,error:string):Response {
  return Response.json({error},{status,headers:{"Cache-Control":"no-store","Referrer-Policy":"no-referrer"}});
}
