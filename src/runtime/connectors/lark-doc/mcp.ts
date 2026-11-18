import {ByteStreamError,clientDrivenStream,cancelUnreadBody} from "../../../proxy/byte-stream";
import {headerMediaType,isRecord} from "../../../records";
import type {LarkTool} from "./profile";

export const LARK_REQUEST_LIMIT=1024*1024;
const TOOL_LIST_LIMIT=256*1024;

type McpId=string|number;
export interface LarkMcpRequest {
  bytes:ArrayBuffer;
  id:McpId|null;
  method:"protocol"|"list"|"call";
  tool?:string;
  arguments?:unknown;
  offset?:number;
  invalid?:true;
}

export async function readLarkMcpRequest(request:Request,signal:AbortSignal,onBytes:(count:number)=>void):Promise<LarkMcpRequest> {
  const invalid=(bytes=new ArrayBuffer(0),id:McpId|null=null):LarkMcpRequest=>
    ({bytes,id,method:"protocol",invalid:true});
  const encoding=request.headers.get("Content-Encoding")?.trim().toLowerCase();
  if(!request.body||headerMediaType(request.headers.get("Content-Type"))!=="application/json"||
    (encoding&&encoding!=="identity"))return invalid();
  const stream=clientDrivenStream(request.body,signal,{maxBytes:LARK_REQUEST_LIMIT,idleMs:60_000,onChunk:chunk=>onBytes(chunk.byteLength)});
  const bytes=await new Response(stream).arrayBuffer();
  let message:unknown;
  try { message=JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(bytes)); } catch { return invalid(bytes); }
  if(!isRecord(message)||message.jsonrpc!=="2.0"||typeof message.method!=="string"||!message.method)return invalid(bytes);
  const id=typeof message.id==="string"||(typeof message.id==="number"&&Number.isSafeInteger(message.id))?message.id:null;
  const method=request.headers.get("Mcp-Method");
  if(method!==null&&method!==message.method)return invalid(bytes,id);
  if(message.method==="tools/list") {
    if(id===null)return invalid(bytes,id);
    if(!isRecord(message.params)||!Object.hasOwn(message.params,"cursor"))return {bytes,id,method:"list"};
    const {cursor,...params}=message.params;
    if(typeof cursor!=="string"||!/^\d{1,5}$/.test(cursor))return invalid(bytes,id);
    const hostedBody=new TextEncoder().encode(JSON.stringify({...message,params})).buffer;
    return {bytes:hostedBody,id,method:"list",offset:Number(cursor)};
  }
  if(message.method!=="tools/call")return {bytes,id,method:"protocol"};
  const name=isRecord(message.params)?message.params.name:null;
  const headerName=request.headers.get("Mcp-Name");
  if(id===null||typeof name!=="string"||(headerName!==null&&headerName!==name))return invalid(bytes,id);
  return {bytes,id,method:"call",tool:name,arguments:isRecord(message.params)?message.params.arguments:undefined};
}

export function larkToolPage(id:McpId,tools:Record<string,unknown>[],offset=0):Response {
  const page:Record<string,unknown>[]=[];
  const encoder=new TextEncoder();
  let size=0;
  for(const tool of tools.slice(offset)){
    size+=encoder.encode(JSON.stringify(tool)).byteLength;
    if(page.length&&size>128*1024)break;
    page.push(tool);
  }
  const next=offset+page.length;
  return Response.json({jsonrpc:"2.0",id,result:{tools:page,...(next<tools.length?{nextCursor:String(next)}:{})}});
}

export function larkToolIdentity(tool:LarkTool,memberScopes:readonly string[]|null,appOnly:boolean):"uat"|"tat"|null {
  if(tool.identity==="tat")return "tat";
  if(memberScopes&&hasLarkToolScopes(tool,memberScopes))return "uat";
  return tool.identity==="both"&&(memberScopes!==null||appOnly)?"tat":null;
}

export function hasLarkToolScopes(tool:LarkTool,scopes:readonly string[]):boolean {
  return tool.alternatives?tool.scopes.some(scope=>scopes.includes(scope)):tool.scopes.every(scope=>scopes.includes(scope));
}

/** Feishu documents a JSON response for discovery. Bound that response before
 * decoding it, and select only tool definitions owned by this identity. */
export async function readLarkToolList(response:Response,id:McpId,allowed:readonly string[],signal:AbortSignal):Promise<Record<string,unknown>[]> {
  if(!response.ok||response.headers.has("Mcp-Session-Id")||!response.body||headerMediaType(response.headers.get("Content-Type"))!=="application/json") {
    void cancelUnreadBody(response);
    throw new Error("Feishu tool list unavailable");
  }
  const body=clientDrivenStream(response.body,signal,{maxBytes:TOOL_LIST_LIMIT,idleMs:60_000});
  const message=await new Response(body).json<unknown>();
  if(!isRecord(message)||message.jsonrpc!=="2.0"||message.id!==id||!isRecord(message.result)||
    !Array.isArray(message.result.tools)||message.result.nextCursor)throw new Error("Invalid Feishu tool list");
  const tools=new Map<string,Record<string,unknown>>();
  for(const tool of message.result.tools) {
    if(!isRecord(tool)||typeof tool.name!=="string")continue;
    if(allowed.includes(tool.name))tools.set(tool.name,tool);
  }
  return [...tools.values()];
}

export function larkRequestLimitError(error:unknown):"request_too_large"|"stream_idle_timeout"|"lark_mcp_invalid_request" {
  if(!(error instanceof ByteStreamError))return "lark_mcp_invalid_request";
  return error.code==="byte_limit_exceeded"?"request_too_large":"stream_idle_timeout";
}
