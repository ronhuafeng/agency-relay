import {canonicalMailbox} from "../../../auth/principal";
import {base64UrlEncode} from "../../../crypto";
import type {LarkAppCredential} from "./credentials";

const IDENTITY_SCOPES = ["contact:user.email:readonly", "contact:user.employee:readonly", "offline_access"];
export const LARK_USER_CALLBACK = "/runtime/feishu-user/callback";

export interface LarkUserTokens {
  accessToken: string;
  refreshToken: string;
  accessExpiresAt: number;
  refreshExpiresAt: number;
  scopes: string[];
}

export type LarkUserAccess = Pick<LarkUserTokens,"accessToken"|"scopes">;

export async function larkAuthorizeUrl(appId: string, redirect: string, state: string, verifier: string, scopes:readonly string[]): Promise<string> {
  const challenge = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  const destination = new URL("https://accounts.feishu.cn/open-apis/authen/v1/authorize");
  destination.search = new URLSearchParams({client_id:appId,redirect_uri:redirect,state,response_type:"code",scope:[...new Set([...IDENTITY_SCOPES,...scopes])].join(" "),
    code_challenge:base64UrlEncode(new Uint8Array(challenge)),code_challenge_method:"S256",prompt:"consent"}).toString();
  return destination.href;
}

type TokenRequest = {grant_type:"authorization_code";code:string;redirect_uri:string;code_verifier:string}
  | {grant_type:"refresh_token";refresh_token:string};

export async function larkUserToken(app:LarkAppCredential, request:TokenRequest, send:(request:Request)=>Promise<Response>):Promise<LarkUserTokens> {
  const started=Date.now();
  const response=await send(new Request("https://accounts.feishu.cn/oauth/v3/token",{
    method:"POST",headers:{"Content-Type":"application/json",Accept:"application/json"},
    body:JSON.stringify({...request,client_id:app.appId,client_secret:app.appSecret}),redirect:"manual",signal:AbortSignal.timeout(8000),
  }));
  const data=await readResponse(response);
  const scopes=typeof data.scope==="string"?data.scope.split(/\s+/).filter(Boolean):null;
  if (!token(data.access_token)||!token(data.refresh_token)||!lifetime(data.expires_in)||!lifetime(data.refresh_token_expires_in)
    ||!scopes) {
    throw new Error("Feishu did not return a refreshable member token and its scopes");
  }
  return {accessToken:data.access_token,refreshToken:data.refresh_token,accessExpiresAt:started+data.expires_in*1000,
    refreshExpiresAt:started+data.refresh_token_expires_in*1000,scopes};
}

export async function verifyLarkMember(accessToken:string, email:string, send:(request:Request)=>Promise<Response>):Promise<boolean> {
  const response=await send(new Request("https://open.feishu.cn/open-apis/authen/v1/user_info",{
    headers:{Authorization:`Bearer ${accessToken}`,Accept:"application/json"},redirect:"manual",signal:AbortSignal.timeout(8000),
  }));
  const body=await readResponse(response);
  const profile=body.data as {tenant_key?:unknown;email?:unknown;enterprise_email?:unknown}|null|undefined;
  if(typeof profile?.tenant_key!=="string"||!profile.tenant_key.trim())return false;
  const domain=email.slice(email.lastIndexOf("@")+1);
  const mailbox=[profile.enterprise_email,profile.email].map(canonicalMailbox).find(value=>value?.endsWith(`@${domain}`));
  return mailbox===email;
}

async function readResponse(response:Response):Promise<Record<string,unknown>> {
  if(!response.ok) {
    await response.body?.cancel();
    throw new Error("Feishu authorization unavailable");
  }
  const data=await response.json<Record<string,unknown>|null>();
  if(!data||data.code!==0)throw new Error("Feishu authorization rejected");
  return data;
}

function token(value:unknown):value is string {
  return typeof value==="string"&&/^[\x21-\x7e]{1,8192}$/.test(value);
}

function lifetime(value:unknown):value is number {
  return typeof value==="number"&&Number.isSafeInteger(value)&&value>0&&value<=366*86400;
}
