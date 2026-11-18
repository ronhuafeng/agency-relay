import executable from "./openapi-executable.json";
import {isRecord} from "../../../records";
import {clientDrivenStream} from "../../../proxy/byte-stream";

type TokenType="user"|"tenant";
interface OpenApiExecution {
  path:string;
  method:string;
  identities:TokenType[];
  args:string[];
  query:string[];
}
interface CatalogTool {
  name:string;
  domain:string;
  description:string;
  docsUrl?:string;
  identities:TokenType[];
  scopes:string[];
  alternatives?:true;
  risk:string|null;
}

export const larkOpenApiTools=executable as readonly (CatalogTool&{execution:OpenApiExecution})[];

export async function readLarkOpenApiDomains(){
  const {default:catalog}=await import("./openapi-catalog.json");
  const domains=new Map<string,(CatalogTool&{executable:boolean})[]>();
  for(const tool of catalog.tools as readonly (CatalogTool&{executable:boolean})[]){
    const group=domains.get(tool.domain);
    if(group)group.push(tool);
    else domains.set(tool.domain,[tool]);
  }
  return Array.from(domains);
}

export async function readLarkOpenApiSchemas():Promise<Record<string,unknown>>{
  return (await import("./openapi-schemas.json")).default;
}
const origin="https://open.feishu.cn";

export function openApiRequest(definition:OpenApiExecution,args:unknown,token:string,signal:AbortSignal):Request|null {
  if(args===undefined)args={};
  if(!isRecord(args)||Object.keys(args).some(key=>key!=="path"&&key!=="params"&&key!=="data")||
    (args.path!==undefined&&!isRecord(args.path))||(args.params!==undefined&&!isRecord(args.params)))return null;
  if(Object.keys(args).some(key=>!definition.args.includes(key)))return null;
  const parameters=isRecord(args.path)?args.path:{};
  const used=new Set<string>();
  let invalid=false;
  const path=definition.path.replace(/:([A-Za-z0-9_]+)/g,(_placeholder,key:string)=>{
    used.add(key);
    const value=parameters[key];
    if(!Object.hasOwn(parameters,key)||(typeof value!=="string"&&typeof value!=="number")||
      !/^[^/?#%\\\u0000-\u001f\u007f]{1,512}$/.test(String(value))||value==="."||value==="..") {
      invalid=true;
      return "";
    }
    return encodeURIComponent(String(value));
  });
  if(invalid||Object.keys(parameters).some(key=>!used.has(key)))return null;
  const url=new URL(path,origin);
  if(url.origin!==origin||!url.pathname.startsWith("/open-apis/"))return null;
  if(isRecord(args.params))for(const [key,value] of Object.entries(args.params)){
    if(!definition.query.includes(key))return null;
    for(const part of Array.isArray(value)?value:[value]){
      if(typeof part!=="string"&&typeof part!=="boolean"&&typeof part!=="number")return null;
      url.searchParams.append(key,String(part));
    }
  }
  if(args.data!==undefined&&/^(GET|HEAD)$/.test(definition.method))return null;
  return new Request(url,{method:definition.method,redirect:"manual",signal,
    headers:{Authorization:`Bearer ${token}`,Accept:"application/json",...(args.data===undefined?{}:{"Content-Type":"application/json"})},
    ...(args.data===undefined?{}:{body:JSON.stringify(args.data)})});
}

export async function openApiResult(response:Response,id:string|number,signal:AbortSignal):Promise<Response> {
  if(response.status===204)return Response.json({jsonrpc:"2.0",id,result:{content:[]}});
  if(!response.body||!response.ok){
    void response.body?.cancel();
    return Response.json({jsonrpc:"2.0",id,result:{isError:true,content:[{type:"text",text:`Feishu OpenAPI HTTP ${response.status}`}]}});
  }
  const stream=clientDrivenStream(response.body,signal,{maxBytes:4*1024*1024,idleMs:60_000});
  const body:unknown=await new Response(stream).json();
  if(!isRecord(body)||typeof body.code!=="number")throw new Error("Invalid Feishu OpenAPI response");
  return Response.json({jsonrpc:"2.0",id,result:{...(body.code===0?{}:{isError:true}),content:[{type:"text",text:JSON.stringify(body)}]}});
}
