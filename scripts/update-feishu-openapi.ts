import {createHash} from "node:crypto";
import {execFileSync} from "node:child_process";
import {mkdtemp,readFile,rm,writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {createRequire} from "node:module";
import {build} from "esbuild";
import {z,type ZodRawShape} from "zod";
import {zodToJsonSchema} from "zod-to-json-schema";

const version="0.5.1";
const integrity="KgSzQIvVFUTHKjmTvAg3sSeyIZJ35CXMZQ3HygwT8/tQzDkuM4RsUSoVK4TVJKVsKCHP3QBOV9sAyBmMCBNc9g==";
const cliRevision="c5fbf1a52df77d5cb9cac2b1501770b2fb9af7d2";
const registry=`https://raw.githubusercontent.com/larksuite/cli/${cliRevision}/internal/registry/catalog/`;
const require=createRequire(import.meta.url);

type Identity="user"|"tenant";
interface ToolDefinition {
  name:string;project:string;description:string;schema:ZodRawShape;accessTokens?:Identity[];
  path?:string;httpMethod?:string;customHandler?:unknown;supportFileUpload?:boolean;supportFileDownload?:boolean;
}
interface Method {
  path:string;httpMethod:string;scopes?:string[];requiredScopes?:string[];accessTokens?:Identity[];risk?:string;
  docsUrl?:string;
}
interface Service {
  servicePath:string;
  resources:Record<string,{methods?:Record<string,Method>}>;
}

async function bytes(url:string) {
  const response=await fetch(url,{signal:AbortSignal.timeout(15000)});
  if(!response.ok)throw new Error(`Catalog download failed (${response.status})`);
  return Buffer.from(await response.arrayBuffer());
}

function key(method:string,path:string) {
  return `${method.toUpperCase()} ${path.replace(/\{([^}]+)\}/g,":$1")}`;
}

// Only accept documented scopes from the exact method/path and identity.
// Missing or ambiguous rows remain visible in the catalog without execution.
async function documentedMethod(tool:ToolDefinition,docsUrl:string):Promise<Method|null> {
  try {
    const markdown=new URL(docsUrl);
    markdown.hash="";
    markdown.pathname+=".md";
    const response=await fetch(markdown,{redirect:"error",signal:AbortSignal.timeout(5000)});
    if(!response.ok||!response.body||!response.headers.get("Content-Type")?.startsWith("text/")){
      void response.body?.cancel();
      return null;
    }
    const reader=response.body.getReader();
    const decoder=new TextDecoder();
    let text="",length=0;
    try{
      while(length<48_000&&!/### (?:Path|Query|Body) parameters|## Response/.test(text)){
        const chunk=await reader.read();
        if(chunk.done)break;
        length+=chunk.value.byteLength;
        text+=decoder.decode(chunk.value,{stream:true});
      }
    }finally{void reader.cancel().catch(()=>{});}
    const path=/^\s*\|?\s*HTTP URL\s*\|\s*https:\/\/open\.feishu\.cn(\/open-apis\/[^\s<|`]+)/im.exec(text)?.[1];
    const method=/^\s*\|?\s*HTTP Method\s*\|\s*`?(GET|POST|PATCH|PUT|DELETE|HEAD)\b/im.exec(text)?.[1];
    if(!path||!method||key(method,path)!==key(tool.httpMethod!,tool.path!))return null;
    const kind=/^\s*\|?\s*(?:Supported app types|支持的应用类型)\s*\|([^\n]+)/im.exec(text)?.[1];
    if(kind&&!/Custom App|自建应用/i.test(kind))return null;
    const requirement=/^\s*\|?\s*(?:Required scopes|权限要求)([^\n]*)$/im.exec(text);
    const authorization=/^\s*\|?\s*Authorization\s*\|([^\n]+)/im.exec(text)?.[1];
    if(!requirement||!authorization)return null;
    const scopeList=[...new Set(Array.from(requirement[1]!.matchAll(/[（(]([a-z][a-z0-9_.-]*(?::[a-z0-9_.-]+)+)[)）]/gi),m=>m[1]!))];
    const any=/at least 1|any scope|任一/i.test(requirement[1]!);
    const all=/all of|all scopes|全部|所有权限/i.test(requirement[1]!);
    if(!scopeList.length||(scopeList.length>1&&!any&&!all))return null;
    const accessTokens:Identity[]=[];
    if(/user_access_token/.test(authorization))accessTokens.push("user");
    if(/tenant_access_token/.test(authorization))accessTokens.push("tenant");
    if(!accessTokens.length)return null;
    if(any)scopeList.sort((a,b)=>Number(/:(readonly|read)$/.test(b))-Number(/:(readonly|read)$/.test(a)));
    return {path,httpMethod:method,scopes:scopeList,...(all&&!any?{requiredScopes:scopeList}:{}),accessTokens,
      risk:/^(GET|HEAD)$/.test(method)?"read":"write",docsUrl};
  }catch{return null;}
}

const scratch=await mkdtemp(join(tmpdir(),"relay-feishu-catalog-"));
try {
  const release=await bytes(`https://registry.npmjs.org/@larksuiteoapi/lark-mcp/-/lark-mcp-${version}.tgz`);
  if(createHash("sha512").update(release).digest("base64")!==integrity)throw new Error("Feishu OpenAPI release integrity mismatch");
  const archive=join(scratch,"catalog.tgz");
  await writeFile(archive,release);
  execFileSync("tar",["-xzf",archive,"-C",scratch,"package/dist/mcp-tool/tools","package/docs/tools-zh.md"]);
  const bundle=await build({entryPoints:[join(scratch,"package/dist/mcp-tool/tools/index.js")],
    bundle:true,write:false,platform:"node",format:"cjs",external:["zod","@larksuiteoapi/node-sdk"]});
  // Extract definitions only. The SDK is used by custom handlers, which are
  // never invoked by this build and are not executable by the JSON adapter.
  const exports:Record<string,unknown>={};
  new Function("require","module","exports",bundle.outputFiles[0]!.text)(
    (name:string)=>name==="@larksuiteoapi/node-sdk"?{}:require(name),{exports},exports);
  const tools=exports.AllToolsZh as ToolDefinition[];
  if(!tools?.length||new Set(tools.map(tool=>tool.name)).size!==tools.length)throw new Error("Invalid AllToolsZh registry");
  const index=await readFile(join(scratch,"package/docs/tools-zh.md"),"utf8");
  const docs=new Map(Array.from(index.matchAll(/^\| ([\w.]+) \| \[[^\]]+\]\((https:\/\/open\.feishu\.cn\/document\/[^)\s]+)\)/gm),
    match=>[match[1]!,match[2]!]));

  const manifest=JSON.parse((await bytes(registry+"manifest.json")).toString()) as {services:Array<{file:string;sha256:string}>};
  const services=await Promise.all(manifest.services.map(async entry=>{
    const raw=await bytes(registry+entry.file);
    if(createHash("sha256").update(raw).digest("hex")!==entry.sha256)throw new Error("Feishu CLI catalog integrity mismatch");
    return JSON.parse(raw.toString()) as Service;
  }));
  const methods=new Map<string,Method>();
  for(const service of services)for(const resource of Object.values(service.resources))for(const method of Object.values(resource.methods??{})) {
    if(!method.path||!method.httpMethod)continue;
    const path=method.path.startsWith("/open-apis/")?method.path:`${service.servicePath}/${method.path.replace(/^\//,"")}`;
    methods.set(key(method.httpMethod,path),method);
  }
  // Read-only operations missing from the CLI snapshot, checked against
  // the Required scopes and Authorization rows in the corresponding API docs.
  const baseScopes=["bitable:app:readonly","bitable:app"];
  const additionalReadScopes:Record<string,string[]>={
    "/open-apis/bitable/v1/apps/:app_token/tables":baseScopes,
    "/open-apis/bitable/v1/apps/:app_token/tables/:table_id/fields":["base:field:read",...baseScopes],
    "/open-apis/bitable/v1/apps/:app_token/tables/:table_id/records":baseScopes,
    "/open-apis/docx/v1/documents/:document_id/raw_content":["docx:document:readonly","docx:document"],
  };
  for(const [path,scopes] of Object.entries(additionalReadScopes))
    methods.set(key("GET",path),{path,httpMethod:"GET",scopes,accessTokens:["user","tenant"],risk:"read"});

  const out=new URL("../src/runtime/connectors/lark-doc/openapi-catalog.json",import.meta.url);
  const saved=await readFile(out,"utf8").catch(()=>null);
  const documented=new Map<string,Method>((saved?JSON.parse(saved).documented??[]:[]) as Array<[string,Method]>);
  if(process.argv.includes("--read-api-docs")){
    const remaining=tools.filter(tool=>tool.path&&tool.httpMethod&&docs.has(tool.name)&&!methods.has(key(tool.httpMethod,tool.path)));
    let cursor=0;
    await Promise.all(Array.from({length:8},async()=>{
      while(cursor<remaining.length){
        const tool=remaining[cursor++]!;
        const metadata=await documentedMethod(tool,docs.get(tool.name)!);
        if(metadata)documented.set(key(metadata.httpMethod,metadata.path),metadata);
      }
    }));
    console.info(`Verified ${documented.size} additional methods in the API documentation`);
  }
  const catalog=tools.map(tool=>{
    const endpoint=tool.path&&tool.httpMethod?key(tool.httpMethod,tool.path):null;
    const method=endpoint?(methods.get(endpoint)??documented.get(endpoint)):undefined;
    const scopes=method?.requiredScopes?.length?method.requiredScopes:method?.scopes??[];
    const alternatives=!method?.requiredScopes?.length&&scopes.length>1;
    const sourceIdentities=tool.accessTokens??[];
    const identities=sourceIdentities.filter(identity=>method?.accessTokens?.includes(identity));
    const risk=tool.httpMethod==="DELETE"?"high-risk-write":method?.risk??null;
    const item={name:tool.name,domain:tool.project,description:tool.description,identities:sourceIdentities,scopes,docsUrl:docs.get(tool.name),
      ...(alternatives?{alternatives:true}:{}),risk};
    if(!tool.path||!tool.httpMethod||!scopes.length||!identities.length||tool.customHandler||
      tool.supportFileDownload||tool.supportFileUpload||!["read","write","high-risk-write"].includes(risk??"")||
      !/^\/open-apis(?:\/(?:[A-Za-z0-9_-]+|:[A-Za-z0-9_]+))+$/.test(tool.path))
      return {...item,execution:null};
    const {useUAT:_identity,...parameters}=tool.schema;
    return {...item,execution:{path:tool.path,method:tool.httpMethod,identities,
      inputSchema:zodToJsonSchema(z.object(parameters),{$refStrategy:"none"})}};
  }).sort((a,b)=>a.domain.localeCompare(b.domain)||a.name.localeCompare(b.name));
  const executable=catalog.flatMap(tool=>tool.execution?[{...tool,execution:tool.execution}]:[]);
  const shapes=executable.map(tool=>[tool.name,tool.execution.inputSchema]);
  const routes=executable.map(({execution:{inputSchema,...execution},...tool})=>{
    const properties="properties" in inputSchema?inputSchema.properties:{};
    const args=Object.keys(properties??{});
    const parameters=(properties as {params?:{properties?:object}})?.params?.properties;
    return {...tool,execution:{...execution,args,query:Object.keys(parameters??{})}};
  });
  await writeFile(out,`{"version":${JSON.stringify(version)},"cliRevision":${JSON.stringify(cliRevision)},"tools":[\n`+
    catalog.map(({execution,...tool})=>JSON.stringify({...tool,executable:Boolean(execution)})).join(",\n")+
    `\n],"documented":${JSON.stringify([...documented].sort(([a],[b])=>a.localeCompare(b)))}}\n`);
  await writeFile(new URL("./openapi-executable.json",out),`[\n${routes.map(tool=>JSON.stringify(tool)).join(",\n")}\n]\n`);
  await writeFile(new URL("./openapi-schemas.json",out),`{\n${shapes.map(([name,shape])=>`${JSON.stringify(name)}:${JSON.stringify(shape)}`).join(",\n")}\n}\n`);
  console.info(`OpenAPI catalog: ${catalog.length} entries, ${executable.length} executable`);
} finally {
  await rm(scratch,{recursive:true,force:true});
}
