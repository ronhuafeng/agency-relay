import {HttpError} from "../errors";
import {copyBytes} from "../proxy/byte-stream";
import {headerMediaType} from "../records";
import {organizationDomain,type LifecycleActor} from "../auth/principal";
import {runtimeInstallations} from "./profiles";
import {changeRuntimeInstallation,configureRuntimeInstallation,readRuntimeInstallation,setRuntimeAccess} from "./installations";
import {readRuntimeMember,runtimeBrowserSessionHash} from "./member";
import {readLarkOpenApiDomains} from "./connectors/lark-doc/openapi";

const invalid=()=>new HttpError(400,"Reopen the Runtime form and check its fields.","invalid_request_error","runtime_invalid_operation");

/** Native HTML forms have the same bounded input and exact field grammar as the
 * Runtime API. Neither form contents nor storage exceptions are logged. */
export async function readRuntimeForm(request:Request,maxBytes=16_384):Promise<Record<string,string>> {
  if(headerMediaType(request.headers.get("Content-Type"))!=="application/x-www-form-urlencoded")throw invalid();
  const reader=request.body?.getReader();if(!reader)throw invalid();
  const chunks:Uint8Array[]=[];let size=0;
  let timer:ReturnType<typeof setTimeout>|undefined;
  const timeout=new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(invalid()),5000);});
  try {
    // A valid 4096-byte header value can occupy 12288 bytes after percent
    // encoding. Keep the native form bounded without reducing the API's limit.
    for(;;){const part=await Promise.race([reader.read(),timeout]);if(part.done)break;size+=part.value.byteLength;if(size>maxBytes)throw invalid();chunks.push(part.value);}
    const bytes=copyBytes(chunks,size);
    const params=new URLSearchParams(new TextDecoder("utf-8",{fatal:true}).decode(bytes));
    const body:Record<string,string>={};
    for(const [key,value] of params){if(Object.hasOwn(body,key)||key==="__proto__"||key==="constructor"||key==="prototype")throw invalid();body[key]=value;}
    return body;
  } catch {await reader.cancel().catch(()=>{});throw invalid();}
  finally {if(timer!==undefined)clearTimeout(timer);reader.releaseLock();}
}
function fields(body:Record<string,string>,allowed:readonly string[]) {
  if(body.confirm!=="1"||Object.keys(body).some(key=>!allowed.includes(key)))throw invalid();
}

export async function revokeRuntimeClient(request:Request,env:Env,id:string) {
  const body=await readRuntimeForm(request);fields(body,["installation","confirm"]);
  const model=await readRuntimeMember(env,request);
  const client=model.consents.find(row=>row.id===id);
  if(!client||client.installation!==body.installation)throw new HttpError(404,"Client authorization not found.","invalid_request_error","not_found");
  const result=await env.RUNTIME_OAUTH.getByName("organization").clientConsents(await runtimeBrowserSessionHash(env,request),id);
  if(result.status!==200)throw new HttpError(result.status,"Client authorization could not be revoked.","invalid_request_error","runtime_revoke_rejected");
  // A lost entitlement does not prevent revocation. Return to the own list when
  // its former installation is no longer visible, rather than selecting another.
  return model.installations.some(row=>row.id===client.installation)?client.installation:undefined;
}

export interface RuntimeAdminModel {
  installations:Awaited<ReturnType<typeof readRuntimeInstallation>>[];
  selectedId:string|null;
  members:Array<{id:string;canonical_email:string;status:string;state:"granted"|"revoked"|null;revision:number;expires_at:string|null}>;
  search:string;
  page:number;
  more:boolean;
  openApiDomains?:Awaited<ReturnType<typeof readLarkOpenApiDomains>>;
}
export async function readRuntimeAdmin(env:Env,actor:LifecycleActor,selectedId:string|null,search="",page=1):Promise<RuntimeAdminModel> {
  // Each read keeps its own authority checks; declared installations are independent of one another.
  const installations=await Promise.all(runtimeInstallations(env).map(declared=>readRuntimeInstallation(env,actor,declared.id)));
  // An unknown selection is a missing object, not a failed read: the page keeps the
  // declared services and names the absence without selecting a substitute.
  const selected=installations.find(row=>row.id===selectedId);
  const members:RuntimeAdminModel["members"]=[];
  let more=false;
  if(selected&&selected.state!=="unconfigured") {
    const escaped=search.replace(/[\\%_]/g,value=>`\\${value}`);
    const result=await env.DB.prepare(`SELECT u.id,u.canonical_email,u.status,a.state,COALESCE(a.revision,0) AS revision,a.expires_at
      FROM users u LEFT JOIN runtime_installation_access a ON a.user_id=u.id AND a.installation_id=?
      WHERE (u.account_kind='human' AND u.login_capable=1 AND u.status='active' AND substr(u.canonical_email,instr(u.canonical_email,'@')+1)=?
        OR a.state='granted') AND (u.canonical_email LIKE ? ESCAPE '\\' OR u.id LIKE ? ESCAPE '\\')
      ORDER BY u.canonical_email,u.id LIMIT 21 OFFSET ?`)
      .bind(selected.id,organizationDomain(env)??"",`%${escaped}%`,`%${escaped}%`,(page-1)*20).all<RuntimeAdminModel["members"][number]>();
    more=result.results.length>20;members.push(...result.results.slice(0,20));
    // Keep the final authorization check after the member read as well.
    await readRuntimeInstallation(env,actor,selected.id);
  }
  const openApiDomains=selected?.profile==="lark.doc"&&selected.state!=="unconfigured"
    ?await readLarkOpenApiDomains():undefined;
  return {installations,selectedId,members,search,page,more,openApiDomains};
}

/** HTML is an adapter to the existing lifecycle, not a second mutation service. */
export async function mutateRuntimeInstallation(env:Env,actor:LifecycleActor,id:string,body:Record<string,string>,now:Date) {
  if(body.action==="configure") {fields(body,["action","confirm","path"]);return configureRuntimeInstallation(env,actor,id,now,body.path);}
  const revision=Number(body.expectedRevision);
  if(!/^\d+$/.test(body.expectedRevision??"")||!Number.isSafeInteger(revision))throw invalid();
  if(body.action==="access") {
    fields(body,["action","confirm","expectedRevision","subject","state","expiresAt"]);
    if(!body.subject||!["granted","revoked"].includes(body.state??""))throw invalid();
    return setRuntimeAccess(env,actor,id,body.subject,{state:body.state as "granted"|"revoked",expectedRevision:revision,expiresAt:body.expiresAt||null},now);
  }
  const common={expectedRevision:revision,operationId:body.operationId??""};
  const allowed=["action","confirm","expectedRevision","operationId"];
  if(body.action==="supply") {
    fields(body,[...allowed,"material","appId","appSecret","authority","credentialHeader"]);
    return changeRuntimeInstallation(env,actor,id,{...common,action:"supply",material:body.material,appId:body.appId,appSecret:body.appSecret,
      authority:body.authority as "same"|"rebind",credentialHeader:body.credentialHeader},now);
  }
  if(body.action==="path") {
    fields(body,[...allowed,"path"]);
    return changeRuntimeInstallation(env,actor,id,{...common,action:"path",path:body.path},now);
  }
  if(body.action==="rename") {
    fields(body,[...allowed,"label"]);
    return changeRuntimeInstallation(env,actor,id,{...common,action:"rename",label:body.label},now);
  }
  if(body.action==="tools") {
    const choices=Object.keys(body).filter(key=>key.startsWith("tool."));
    fields(body,[...allowed,...choices]);
    if(choices.some(key=>body[key]!=="1"))throw invalid();
    return changeRuntimeInstallation(env,actor,id,{...common,action:"tools",names:choices.map(key=>key.slice(5))},now);
  }
  fields(body,allowed);
  if(!["enable","disable","retire","recover"].includes(body.action??""))throw invalid();
  return changeRuntimeInstallation(env,actor,id,{...common,action:body.action as "enable"|"disable"|"retire"|"recover"},now);
}
