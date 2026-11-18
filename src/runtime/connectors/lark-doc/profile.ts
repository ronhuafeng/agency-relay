import {larkOpenApiTools} from "./openapi";

export const larkDocProfile = {
  revision: 1,
  upstream: "https://mcp.feishu.cn/mcp",
  credentialHeader: "X-Lark-MCP-TAT",
  transport: "request-scoped",
} as const;

export const LARK_UAT_HEADER = "X-Lark-MCP-UAT";

export const larkToolGroups = {
  documents: "搜索和读取文档",
  people: "查询成员",
  files: "下载附件",
  comments: "查看和添加评论",
  writing: "创建和修改文档",
} as const;

export const larkToolIdentities = {
  uat: "成员身份",
  tat: "应用身份",
  both: "优先成员身份 · 应用身份备用",
} as const;

const editDocumentScopes = ["docx:document:create","wiki:node:read","wiki:node:create","docs:document.media:upload",
  "board:whiteboard:node:create","docx:document:write_only","docx:document:readonly"];

export interface LarkTool {
  name: string;
  label: string;
  group?: keyof typeof larkToolGroups;
  scopes: readonly string[];
  supplementalScopes?: readonly string[];
  identity: keyof typeof larkToolIdentities;
  writes?: true;
  highRisk?: true;
  defaultEnabled?: true;
  alternatives?:true;
  openApi?: (typeof larkOpenApiTools)[number]["execution"];
  description?: string;
}

/** Official hosted MCP tool names and published application permissions. */
export const larkHostedTools: readonly LarkTool[] = [
  {name:"search-doc",label:"搜索云文档",group:"documents",scopes:["search:docs:read","wiki:wiki:readonly"],identity:"uat",defaultEnabled:true},
  {name:"fetch-doc",label:"读取文档正文",group:"documents",scopes:["docx:document:readonly","task:task:read","im:chat:read"],
    supplementalScopes:["wiki:node:read"],identity:"both",defaultEnabled:true},
  {name:"list-docs",label:"浏览知识库目录",group:"documents",scopes:["wiki:wiki:readonly"],identity:"both"},
  {name:"search-user",label:"搜索成员",group:"people",scopes:["contact:user:search"],identity:"uat",defaultEnabled:true},
  {name:"get-user",label:"查看成员资料",group:"people",scopes:["contact:contact.base:readonly","contact:user.base:readonly"],identity:"both"},
  {name:"fetch-file",label:"下载图片和附件",group:"files",scopes:["docs:document.media:download","board:whiteboard:node:read"],identity:"both"},
  {name:"get-comments",label:"查看文档评论",group:"comments",scopes:["docs:document.comment:read","contact:contact.base:readonly"],identity:"both"},
  {name:"add-comments",label:"添加文档评论",group:"comments",scopes:["docs:document.comment:create"],identity:"both",writes:true},
  {name:"create-doc",label:"创建文档",group:"writing",scopes:editDocumentScopes,identity:"both",writes:true},
  {name:"update-doc",label:"修改文档",group:"writing",scopes:editDocumentScopes,identity:"both",writes:true},
];

export const larkTools: readonly LarkTool[] = [...larkHostedTools,...larkOpenApiTools.map((tool):LarkTool=>{
  const identities=tool.execution.identities;
  return {name:tool.name,label:tool.name,description:tool.description,scopes:tool.scopes,alternatives:tool.alternatives,
    identity:identities.length===2?"both":identities.includes("user")?"uat":"tat",
    ...(tool.risk==="read"?{}:{writes:true}),...(tool.risk==="high-risk-write"?{highRisk:true}:{}),openApi:tool.execution};
})];
export const larkToolsByName=new Map(larkTools.map(tool=>[tool.name,tool]));

export function isLarkToolSelection(value:unknown):value is string[] {
  return Array.isArray(value)&&value.length<=larkTools.length&&new Set(value).size===value.length&&
    value.every(name=>larkToolsByName.has(name));
}

export function larkToolSelection(config:string|null):string[] {
  if(config===null)return larkTools.filter(tool=>tool.defaultEnabled).map(tool=>tool.name);
  const selection:unknown=JSON.parse(config);
  if(!Array.isArray(selection)||selection.some(name=>typeof name!=="string")||new Set(selection).size!==selection.length)
    throw new Error("Invalid Feishu tool configuration");
  return selection.filter(name=>larkToolsByName.has(name));
}
