import {admitRuntimeRequest} from "./authorization";
import {requireRuntimeInstallation,RUNTIME_PROFILES} from "./profiles";
import {larkUserAuthority,validRuntimeCredentialHeader} from "./installations";
import {connectionHeaderNames} from "../proxy/adapter";
import {cancelUnreadBody,clientDrivenStream,ByteStreamError,copyBytes,type ByteStreamEnd} from "../proxy/byte-stream";
import type { AppDependencies } from "../types";
import type {RuntimeTransportError} from "./oauth";
import {LARK_REQUEST_LIMIT,hasLarkToolScopes,larkRequestLimitError,larkToolIdentity,larkToolPage,readLarkMcpRequest,readLarkToolList} from "./connectors/lark-doc/mcp";
import {LARK_UAT_HEADER,larkToolsByName} from "./connectors/lark-doc/profile";
import {openApiRequest,openApiResult,readLarkOpenApiSchemas} from "./connectors/lark-doc/openapi";
import {logRuntimeMcp,mcpDiscoveryMethod} from "./mcp-logs";
import {asRecord,headerMediaType} from "../records";

const CONTENT_HEADERS=new Set(["accept","accept-encoding","accept-language","content-type","content-encoding","content-language"]);
const MCP_HEADERS=new Set(["mcp-protocol-version","mcp-method","mcp-name"]);
const MAX_UPLOAD_BYTES=8*1024*1024;
const IDLE_MS=60000;
const DEFINITE_RESPONSE_BYTES=65536;
const LOGGED_INITIALIZE_LIMIT=4096;
class RelayFailure extends Error {constructor(readonly code:RuntimeTransportError){super(code);}}

/** Admission and transport. Only Feishu discovery can dispatch twice.
 * Transport facts do not establish a tool outcome or billable usage. */
export async function relayRuntimeRequest(request:Request,env:Env,ctx:Pick<ExecutionContext,"waitUntil">,deps:AppDependencies):Promise<Response|null> {
  const admission=await admitRuntimeRequest(request,env);
  if(admission instanceof Response||admission===null)return admission;
  const installation=requireRuntimeInstallation(env,admission.installation_id);
  const profile=RUNTIME_PROFILES[installation.profile];
  const started=deps.now().getTime();
  const feishu=admission.profile==="lark.doc";
  let method=feishu?undefined:mcpDiscoveryMethod(request.headers.get("Mcp-Method"));
  let version:unknown=request.headers.get("Mcp-Protocol-Version");
  let httpStatus:number|undefined;
  let toolCount:number|undefined;
  let discoveryError:RuntimeTransportError|undefined;
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
    const duration=Math.max(0,deps.now().getTime()-started);
    if(method&&httpStatus!==undefined)logRuntimeMcp({connector:installation.profile,stage:"discovery",method,
      protocol_version:version,http_status:httpStatus,duration_ms:duration,tool_count:toolCount,error:error??discoveryError});
    const recording=env.RUNTIME_OAUTH.getByName("organization").completeLease(admission.lease_id,{
      attempted,upstream_status:status,terminal:kind,error,duration_ms:duration,
      headers_ms:headersMs,request_bytes_observed:requestBytes,response_bytes_observed:bytes
    }).catch(()=>{console.error(JSON.stringify({event:"runtime_terminal_record_unavailable"}));});
    try{ctx.waitUntil(recording);}catch{/* Recording cannot replace transport. */}
  };
  try{
    if(admission.profile!==installation.profile||admission.profile_revision!==profile.revision){finish("error","runtime_profile_unavailable");return runtimeFailure(503,"runtime_profile_unavailable");}
    const length=request.headers.get("Content-Length");
    if(length!==null&&/^\d+$/.test(length)&&Number(length)>(feishu?LARK_REQUEST_LIMIT:MAX_UPLOAD_BYTES)){
      finish("error","request_too_large");return runtimeFailure(413,"request_too_large");
    }
    const message=feishu?await Promise.race([readLarkMcpRequest(request,abortController.signal,count=>{requestBytes+=count;}),aborted])
      .catch(error=>{throw error instanceof RelayFailure?error:new RelayFailure(larkRequestLimitError(error));}):null;
    if(message?.invalid){
      logRuntimeMcp({connector:installation.profile,stage:"protocol",method:mcpDiscoveryMethod(request.headers.get("Mcp-Method")),
        protocol_version:version,http_status:400,error:"lark_mcp_invalid_request"});
      finish("error","lark_mcp_invalid_request");
      return larkMcpFailure(400,message.id,-32600,"lark_mcp_invalid_request");
    }
    if(message?.initialize)method="initialize";
    if(message?.method==="list")method="tools/list";
    const selected=message&&message.method!=="protocol"
      ?(admission.feishu_tools??[]).flatMap(name=>{
        const tool=larkToolsByName.get(name);
        return tool&&(message.method==="list"||name===message.tool)?[tool]:[];
      })
      :[];
    if(message?.method==="call"&&!selected.length){
      finish("error","lark_mcp_tool_unavailable");
      return larkMcpFailure(400,message.id,-32601,"lark_mcp_tool_unavailable");
    }
    const secrets=env.RUNTIME_CREDENTIALS.getByName(installation.id);
    const readCredential=<T>(read:Promise<T>)=>Promise.race([read,aborted])
      .catch(error=>{throw error instanceof RelayFailure?error:new RelayFailure("upstream_credential_unavailable");});
    const larkAuthority=larkUserAuthority(admission);
    const member=selected.some(tool=>tool.identity!=="tat")?await readCredential(secrets.readLarkUser(larkAuthority)):null;
    // A legacy manual TAT comes from a binding that cannot exchange UATs.
    // A disconnected or expired member grant is not evidence of missing scopes.
    const appOnly=!member&&selected.some(tool=>tool.identity==="both")&&await readCredential(secrets.larkUserStatus(larkAuthority))==="app_required";
    const tools={uat:[] as string[],tat:[] as string[]};
    for(const tool of selected){
      const identity=larkToolIdentity(tool,member?.scopes??null,appOnly);
      if(identity)tools[identity].push(tool.name);
    }
    const apiAppTools=selected.filter(tool=>tool.openApi&&tools.tat.includes(tool.name));
    const apiApp=apiAppTools.length?await readCredential(secrets.readLarkOpenApiTenant(larkAuthority)):null;
    const apiAppNames=new Set(apiApp?apiAppTools.filter(tool=>hasLarkToolScopes(tool,apiApp.scopes)).map(tool=>tool.name):[]);
    tools.tat=tools.tat.filter(name=>!larkToolsByName.get(name)?.openApi||apiAppNames.has(name));
    if(message?.method==="call"&&!tools.uat.length&&!tools.tat.length) {
      finish("error","lark_user_authorization_required");
      return larkMcpFailure(403,message.id,-32000,"lark_user_authorization_required");
    }
    const appHeader=admission.credential_header??profile.credentialHeader;
    const headersFor=(credentialHeader:string,material:string|null|undefined,names:readonly string[])=>{
      if(!material||!validRuntimeCredentialHeader(credentialHeader))throw new RelayFailure("upstream_credential_unavailable");
      const headers=projectHeaders(request.headers,true);
      headers.set(credentialHeader,material);
      if(names.length)headers.set("X-Lark-MCP-Allowed-Tools",names.join(","));
      return headers;
    };
    const catalog=message?.method==="list";
    const readApp=!message||message.method==="protocol"||tools.tat.some(name=>!apiAppNames.has(name));
    const app=readApp?await readCredential(secrets.read(installation.id,admission.credential_ref,admission.credential_revision)):null;
    const upload=message?message.bytes:request.body?clientDrivenStream(request.body,abortController.signal,{
      maxBytes:MAX_UPLOAD_BYTES,idleMs:IDLE_MS,
      onChunk:chunk=>{requestBytes+=chunk.byteLength;if(awaitingHeaders)resetIdle();},
      onEnd:(kind,error)=>{if(kind==="error")stop(error instanceof ByteStreamError&&error.code==="byte_limit_exceeded"?"request_too_large":error instanceof ByteStreamError?"stream_idle_timeout":"upstream_transport_failed");}
    }):null;
    if(abortController.signal.aborted)throw new RelayFailure(failure??"client_request_aborted");
    const dispatch=async(input:string|Request,outgoing?:Headers)=>{
      if(!attempted){awaitingHeaders=true;resetIdle();}
      attempted=true;
      const response=await (typeof input==="string"
        ?deps.fetch(input,{method:"POST",headers:outgoing,body:upload,redirect:"manual",signal:abortController.signal})
        :deps.fetch(input));
      if(status===null){status=response.status;headersMs=Math.max(0,deps.now().getTime()-started);}
      return response;
    };
    let upstream:Response;
    if(catalog&&message.id!==null) {
      const id=message.id;
      const hosted=(names:readonly string[])=>names.filter(name=>!larkToolsByName.get(name)?.openApi);
      const appNames=app?hosted(tools.tat):[],memberNames=hosted(tools.uat);
      const listRequests=[
        ...(memberNames.length?[{headers:headersFor(LARK_UAT_HEADER,member?.accessToken,memberNames),names:memberNames}]:[]),
        ...(appNames.length?[{headers:headersFor(appHeader,app,appNames),names:appNames}]:[]),
      ];
      const replies=await Promise.race([Promise.all(listRequests.map(async({headers,names})=>{
        headers.set("Accept","application/json");
        return readLarkToolList(await dispatch(profile.upstream,headers),id,names,abortController.signal);
      })),aborted]);
      const discovered=new Map(replies.flat().map(tool=>[tool.name,tool]));
      const schemas=selected.some(tool=>tool.openApi&&(tools.uat.includes(tool.name)||apiAppNames.has(tool.name)))
        ?await readLarkOpenApiSchemas():null;
      for(const tool of selected){
        if(schemas&&tool.openApi&&Object.hasOwn(schemas,tool.name)&&(tools.uat.includes(tool.name)||apiAppNames.has(tool.name)))
          discovered.set(tool.name,{name:tool.name,description:tool.description,inputSchema:schemas[tool.name]});
      }
      const page=larkToolPage(id,selected.flatMap(tool=>{
        const definition=discovered.get(tool.name);
        return definition?[definition]:[];
      }),message.offset);
      upstream=page.response;
      toolCount=page.toolCount;
      if(toolCount===0&&!member&&!appOnly&&!tools.tat.length&&selected.some(tool=>tool.identity!=="tat")) {
        discoveryError="lark_user_authorization_required";
      }
    } else if(message?.method==="call"&&message.id!==null&&selected[0]?.openApi) {
      const token=tools.uat.length?member?.accessToken:apiApp?.value;
      if(!token)throw new RelayFailure("upstream_credential_unavailable");
      const apiRequest=openApiRequest(selected[0].openApi,message.arguments,token,abortController.signal);
      if(!apiRequest){
        finish("error","lark_mcp_invalid_request");
        return larkMcpFailure(400,message.id,-32602,"lark_mcp_invalid_request");
      }
      const result=await Promise.race([dispatch(apiRequest),aborted]);
      if(result.status>=300&&result.status<400){
        void cancelUnreadBody(result);
        throw new RelayFailure("upstream_redirect_rejected");
      }
      upstream=await Promise.race([openApiResult(result,message.id,abortController.signal),aborted]);
    } else {
      const headers=tools.uat.length?headersFor(LARK_UAT_HEADER,member?.accessToken,tools.uat):headersFor(appHeader,app,tools.tat);
      upstream=await Promise.race([dispatch(profile.upstream,headers),aborted]);
    }
    awaitingHeaders=false;
    if(idleTimer!==undefined){clearTimeout(idleTimer);idleTimer=undefined;}
    if(method==="initialize")version=upstream.headers.get("Mcp-Protocol-Version");
    const error=upstream.status>=300&&upstream.status<400?"upstream_redirect_rejected":upstream.status===401||upstream.status===403?"upstream_credential_unavailable":upstream.headers.has("Mcp-Session-Id")?"runtime_transport_unsupported":null;
    httpStatus=error?502:upstream.status;
    if(error){void cancelUnreadBody(upstream);finish("error",error);return runtimeFailure(502,error);}
    const responseHeaders=projectHeaders(upstream.headers,false);
    responseHeaders.set("Cache-Control","no-store");
    responseHeaders.set("Referrer-Policy","no-referrer");
    const initializeJson=feishu&&method==="initialize"&&upstream.ok&&headerMediaType(upstream.headers.get("Content-Type"))==="application/json";
    const initializeBytes=initializeJson?new Uint8Array(LOGGED_INITIALIZE_LIMIT):undefined;
    const framed=await frameUpstreamBody(upstream,abortController.signal,(chunk)=>{
      const offset=bytes;
      bytes=Math.min(Number.MAX_SAFE_INTEGER,bytes+chunk.byteLength);
      if(initializeBytes&&bytes<=initializeBytes.length)initializeBytes.set(chunk,offset);
    },(kind,error)=>{
      if(kind==="completed"&&initializeBytes&&bytes<=initializeBytes.length)version=negotiatedLarkVersion(initializeBytes.subarray(0,bytes))??version;
      const code=failure??(error instanceof ByteStreamError?"stream_idle_timeout":kind==="error"?"upstream_transport_failed":null);
      finish(code&&code!=="client_request_aborted"?"error":kind,code);
    });
    if(framed.kind==="definite"){
      bytes=framed.bytes.byteLength;
      if(initializeJson&&bytes<=LOGGED_INITIALIZE_LIMIT)version=negotiatedLarkVersion(framed.bytes)??version;
      responseHeaders.set("Content-Length",String(framed.bytes.byteLength));
      finish("completed");
      return new Response(framed.bytes,{status:upstream.status,statusText:upstream.statusText,headers:responseHeaders});
    }
    return new Response(framed.stream,{status:upstream.status,statusText:upstream.statusText,headers:responseHeaders});
  }catch(error){
    const code=error instanceof RelayFailure?error.code:failure??"upstream_transport_failed";
    httpStatus=code==="client_request_aborted"?499:code==="request_too_large"?413:code==="lark_mcp_invalid_request"?400:code==="stream_idle_timeout"||code==="lease_expired"?504:code==="upstream_credential_unavailable"?503:502;
    finish(code==="client_request_aborted"?"cancelled":"error",code);
    return runtimeFailure(httpStatus,code);
  }
}

function negotiatedLarkVersion(bytes:Uint8Array):unknown {
  try {return asRecord(asRecord(JSON.parse(new TextDecoder().decode(bytes)))?.result)?.protocolVersion;}
  catch {return undefined;}
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

function larkMcpFailure(status:number,id:string|number|null,code:number,message:string):Response {
  return Response.json({jsonrpc:"2.0",id,error:{code,message}},{status,headers:{"Cache-Control":"no-store","Referrer-Policy":"no-referrer"}});
}
