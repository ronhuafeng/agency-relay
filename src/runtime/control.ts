import {credentialActor} from "../auth/credential-defaults";
import type {OperatorMutationContext} from "../admin/operator-mutations";
import {HttpError,jsonResponse} from "../errors";
import {copyBytes} from "../proxy/byte-stream";
import {headerMediaType,isRecord} from "../records";
import {changeRuntimeInstallation,configureRuntimeInstallation,invalidRuntimeOperation,readRuntimeAccess,readRuntimeInstallation,readRuntimeOperation,setRuntimeAccess} from "./installations";
import {runtimeInstallations} from "./profiles";

const PREFIX="/admin/runtime-installations";
export function isRuntimeControlPath(path:string):boolean {
  return path===PREFIX || /^\/admin\/runtime-installations\/[a-z][a-z0-9-]{0,63}(?:\/access\/[^/]{1,200}|\/operations\/[A-Za-z0-9_-]{1,96})?$/.test(path);
}

/** Shared operator/browser API. routeAdmin owns authentication and Origin checks;
 * the lifecycle owns current-actor checks in each committing SQL operation. */
export async function runtimeControlResponse(request:Request,env:Env,url:URL,operator:OperatorMutationContext):Promise<Response|null> {
  if(!isRuntimeControlPath(url.pathname))return null;
  const actor=credentialActor(operator);
  const respond=(value:unknown)=>jsonResponse(value,{headers:{"Cache-Control":"no-store"}});
  try {
    if(url.pathname===PREFIX) {
      if(request.method!=="GET")throw method();
      const installations=[];
      for(const item of runtimeInstallations(env)) installations.push(await readRuntimeInstallation(env,actor,item.id));
      return respond({installations});
    }
    const operation=/^\/admin\/runtime-installations\/([^/]+)\/operations\/([^/]+)$/.exec(url.pathname);
    if(operation){if(request.method!=="GET")throw method();return respond({stages:await readRuntimeOperation(env,actor,operation[1]!,operation[2]!)});}
    const [,id,subject]=/^\/admin\/runtime-installations\/([^/]+)(?:\/access\/([^/]+))?$/.exec(url.pathname)!;
    if(request.method==="GET")return respond(subject
      ?await readRuntimeAccess(env,actor,id!,decodeURIComponent(subject))
      :await readRuntimeInstallation(env,actor,id!));
    if(request.method!==(subject?"PUT":"POST"))throw method();
    const body=await readBody(request);
    if(subject) {
      keys(body,["state","expectedRevision","expiresAt"]);
      if(body.state!=="granted"&&body.state!=="revoked")throw invalidRuntimeOperation();
      if(body.expiresAt!==null&&typeof body.expiresAt!=="string")throw invalidRuntimeOperation();
      return respond(await setRuntimeAccess(env,actor,id!,decodeURIComponent(subject),{state:body.state,expectedRevision:body.expectedRevision as number,expiresAt:body.expiresAt},operator.now));
    }
    if(body.action==="configure") {
      keys(body,["action"]);
      return respond(await configureRuntimeInstallation(env,actor,id!,operator.now));
    }
    const common={expectedRevision:body.expectedRevision as number,operationId:body.operationId as string};
    const allowed=["action","expectedRevision","operationId"];
    if(body.action==="supply") {
      keys(body,[...allowed,"material","authority"]);
      return respond(await changeRuntimeInstallation(env,actor,id!,{...common,action:"supply",material:body.material as string,authority:body.authority as "same"|"rebind"},operator.now));
    }
    if(body.action==="rename") {
      keys(body,[...allowed,"label"]);
      return respond(await changeRuntimeInstallation(env,actor,id!,{...common,action:"rename",label:body.label as string},operator.now));
    }
    keys(body,allowed);
    if(body.action!=="enable"&&body.action!=="disable"&&body.action!=="retire"&&body.action!=="recover")throw invalidRuntimeOperation();
    return respond(await changeRuntimeInstallation(env,actor,id!,{...common,action:body.action},operator.now));
  } catch(error) {
    if(error instanceof HttpError)throw error;
    // Never pass storage, crypto, RPC or JSON exception text to the global logger.
    throw new HttpError(503,"Runtime operation could not be confirmed. Read its current state.","server_error","runtime_state_unavailable");
  }
}

function method(){return new HttpError(405,"Method not allowed.","invalid_request_error","method_not_allowed");}
function keys(body:Record<string,unknown>,allowed:string[]) {if(Object.keys(body).some(key=>!allowed.includes(key)))throw invalidRuntimeOperation();}
async function readBody(request:Request):Promise<Record<string,unknown>> {
  if(headerMediaType(request.headers.get("Content-Type"))!=="application/json")throw invalidRuntimeOperation();
  const reader=request.body?.getReader();if(!reader)throw invalidRuntimeOperation();
  const chunks:Uint8Array[]=[];let size=0;
  try {
    for(;;){const chunk=await reader.read();if(chunk.done)break;size+=chunk.value.byteLength;if(size>8192){await reader.cancel();throw invalidRuntimeOperation();}chunks.push(chunk.value);}
    const bytes=copyBytes(chunks,size);
    const parsed:unknown=JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(bytes));
    if(!isRecord(parsed))throw invalidRuntimeOperation();
    return parsed as Record<string,unknown>;
  } catch {throw invalidRuntimeOperation();} finally {reader.releaseLock();}
}
