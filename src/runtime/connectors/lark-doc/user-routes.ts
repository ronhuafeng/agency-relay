import {createElement as h} from "react";
import {readConsoleSessionPrincipalByHash} from "../../../auth/console-session";
import {assertConsoleBrowserWrite} from "../../../console/browser-write";
import {consoleDocument} from "../../../console/console-shell";
import {memberHref} from "../../../console/member-href";
import {larkUserAuthority,readRuntimeAuthority} from "../../installations";
import {runtimeBrowserSessionHash} from "../../member";
import {runtimeInstallations} from "../../profiles";
import {LARK_USER_CALLBACK} from "./user-oauth";
import {larkTools} from "./profile";

const ROOT="/runtime/feishu-user";
const ACTION=/^\/runtime\/feishu-user\/([a-z][a-z0-9-]{0,63})\/(connect|disconnect|failed)$/;
const STATE=/^([a-z][a-z0-9-]{0,63})\.[A-Za-z0-9_-]{43}$/;
const PRIVATE={"Cache-Control":"no-store","Referrer-Policy":"no-referrer"};

/** Called only on the console origin. The callback never accepts a return URL. */
export async function larkUserAuthorizationResponse(request:Request,env:Env,url:URL):Promise<Response|null> {
  const isCallback=url.pathname===LARK_USER_CALLBACK&&request.method==="GET";
  const action=ACTION.exec(url.pathname);
  if(!isCallback&&!action)return null;
  const state=url.searchParams.getAll("state");
  const installation=isCallback?STATE.exec(state.length===1?state[0]!:"")?.[1]:action?.[1];
  const member=memberHref("integrations");
  if(!installation||!runtimeInstallations(env).some(item=>item.id===installation&&item.profile==="lark.doc"))
    return isCallback?redirect(member):null;
  const returnTo=`${member}&installation=${installation}`;
  const failed=`${ROOT}/${installation}/failed`;
  if(action?.[2]==="failed")return request.method==="GET"&&!url.search
    ?page("飞书授权未完成","请使用与 Relay 组织邮箱匹配的飞书账号，并授予所需权限。",returnTo,"返回飞书工具服务",403)
    :null;
  if(!isCallback) {
    if(request.method!=="POST"||url.search)return null;
    assertConsoleBrowserWrite(request,env,url);
  }
  const sessionHash=await runtimeBrowserSessionHash(env,request);
  const principal=sessionHash?await readConsoleSessionPrincipalByHash(env,sessionHash):null;
  if(!principal||!sessionHash)return redirect(failed);
  const secrets=env.RUNTIME_CREDENTIALS.getByName(installation);
  if(action?.[2]==="disconnect") {
    await secrets.disconnectLarkUser(installation,principal.id);
    return redirect(returnTo);
  }
  const current=await readRuntimeAuthority(env,principal.id,installation,new Date(),{hash:sessionHash,email:principal.email,epoch:principal.sessionEpoch});
  if(!current||current.profile!=="lark.doc")return redirect(failed);
  const authority=larkUserAuthority(current);
  const callback=`${url.origin}${LARK_USER_CALLBACK}`;
  const browser={sessionHash,email:principal.email};
  if(isCallback) {
    const codes=url.searchParams.getAll("code");
    if(codes.length!==1||! /^[\x21-\x7e]{1,2048}$/.test(codes[0]!)||url.searchParams.has("error"))return redirect(failed);
    const connected=await secrets.finishLarkUser(authority,browser,callback,state[0]!,codes[0]!).catch(()=>false);
    return redirect(connected?returnTo:failed);
  }
  const scopes=larkTools.filter(tool=>tool.identity!=="tat"&&current.feishu_tools?.includes(tool.name))
    .flatMap(tool=>[...(tool.alternatives?tool.scopes.slice(0,1):tool.scopes),...(tool.supplementalScopes??[])]);
  const destination=await secrets.beginLarkUser(authority,browser,callback,scopes);
  // A link works under the console's same-origin form policy, including after
  // in-place navigation from a console page that shares that policy.
  return destination?page("授权飞书账号","在飞书确认授权后，Relay 可用你的成员身份调用已获准的工具。",destination,"继续到飞书"):redirect(failed);
}

function redirect(location:string):Response {
  return new Response(null,{status:303,headers:{...PRIVATE,Location:location}});
}

function page(title:string,message:string,href:string,label:string,status=200):Response {
  return new Response(consoleDocument({title,main:h("section",{className:"gate"},h("h1",null,title),h("p",null,message),
    h("a",{href},label))}),{status,headers:{...PRIVATE,"Content-Type":"text/html; charset=utf-8",
    "Content-Security-Policy":"default-src 'none'; style-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"}});
}
