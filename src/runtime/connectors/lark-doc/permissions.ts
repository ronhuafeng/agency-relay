import {asRecord} from "../../../records";
import type {LarkTool} from "./profile";

export interface LarkPermissionNotice {
  tool: string;
  kind: "app_scope" | "member_scope" | "document_access";
  scopes: readonly string[];
  anyOf?: true;
  identity?: "uat" | "tat";
}

export function missingLarkScopes(tool:LarkTool,granted:readonly string[],kind:"app_scope"|"member_scope"):LarkPermissionNotice|null {
  const scopes=tool.scopes.filter(scope=>!granted.includes(scope));
  if(!scopes.length||(tool.alternatives&&scopes.length!==tool.scopes.length))return null;
  return {tool:tool.name,kind,scopes,...(tool.alternatives?{anyOf:true}:{})};
}

// Feishu distinguishes API scopes (99991672/99991679) from resource access.
// HTTP 403 and unstructured provider prose alone do not identify either.
export function larkProviderPermission(value:unknown,tool:LarkTool,identity:"uat"|"tat"):LarkPermissionNotice|null {
  const body=asRecord(value);
  const code=body?.code;
  if(code===99991672||(code===99991679&&identity==="uat")){
    const violations=asRecord(body?.error)?.permission_violations;
    const allowed=new Set([...tool.scopes,...(tool.supplementalScopes??[])]);
    const reported=new Set(Array.isArray(violations)?violations.flatMap(value=>{
      const field=asRecord(value);
      return field?.type==="action_scope_required"&&typeof field.subject==="string"&&allowed.has(field.subject)
        ?[field.subject]:[];
    }):[]);
    return {tool:tool.name,kind:code===99991672?"app_scope":"member_scope",scopes:[...reported],identity,
      ...(reported.size>1&&(code===99991672||tool.alternatives)?{anyOf:true}:{})};
  }
  // Document content and comment endpoints have resource-specific denial codes.
  if(code===91403||code===1770032||code===1069303||code===1069603||code===1063002)
    return {tool:tool.name,kind:"document_access",scopes:[],identity};
  return null;
}

export function larkPermissionMessage(notice:LarkPermissionNotice):string {
  const {tool,kind,scopes,anyOf,identity}=notice;
  if(kind==="document_access"){
    const actor=identity==="tat"?"飞书应用":"当前飞书成员";
    return `「${tool}」无法执行。${actor}无权访问这份文档。请让文档或知识库管理员为该身份授予所需访问权限。重新连接不会改变文档权限。`;
  }
  const needed=scopes.length?`${anyOf?"需要以下任一权限":"缺少权限"} ${scopes.join("、")}`:"缺少飞书接口权限";
  if(kind==="app_scope"){
    const scopeType=identity==="uat"?"用户身份权限":identity==="tat"?"应用身份权限":"相应权限";
    return `工具「${tool}」的飞书应用${needed}。请管理员在飞书开放平台开通${scopeType}，并确认权限已生效。`;
  }
  return `工具「${tool}」的成员授权${needed}。请在 Relay 的「我的工具服务 → 飞书文档」选择「更新飞书授权」。若飞书提示应用未开通权限，请联系管理员。`;
}

export function larkPermissionResult(id:string|number,...notices:LarkPermissionNotice[]):Response {
  return Response.json({jsonrpc:"2.0",id,result:{isError:true,content:notices.map(notice=>({type:"text",text:larkPermissionMessage(notice)}))}},
    {headers:{"Cache-Control":"no-store","Referrer-Policy":"no-referrer"}});
}

export function larkHostedPermission(bytes:Uint8Array,id:string|number,tool:LarkTool,identity:"uat"|"tat"):LarkPermissionNotice|null {
  try {
    const body=asRecord(JSON.parse(new TextDecoder().decode(bytes)));
    if(body?.jsonrpc!=="2.0")return larkProviderPermission(body,tool,identity);
    if(body.id!==id)return null;
    const error=asRecord(body.error);
    if(error)return larkProviderPermission(error.data,tool,identity)??larkProviderPermission(error,tool,identity);
    const result=asRecord(body.result);
    if(result?.isError!==true)return null;
    for(const value of Array.isArray(result.content)?result.content:[]){
      const content=asRecord(value);
      if(content?.type!=="text"||typeof content.text!=="string")continue;
      // Hosted tools may wrap a structured OpenAPI error in MCP text content.
      try {
        const notice=larkProviderPermission(JSON.parse(content.text),tool,identity);
        if(notice)return notice;
      }catch { /* Freeform text does not prove a permission diagnosis. */ }
    }
  }catch { /* Unknown or incomplete response. */ }
  return null;
}
