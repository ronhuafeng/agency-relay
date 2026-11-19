import {canonicalMailbox} from "../../../auth/principal";
import {pkceChallengeS256} from "../../../crypto";
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
  const challenge = await pkceChallengeS256(verifier);
  const destination = new URL("https://accounts.feishu.cn/open-apis/authen/v1/authorize");
  destination.search = new URLSearchParams({client_id:appId,redirect_uri:redirect,state,response_type:"code",scope:[...new Set([...IDENTITY_SCOPES,...scopes])].join(" "),
    code_challenge:challenge,code_challenge_method:"S256",prompt:"consent"}).toString();
  return destination.href;
}

type TokenRequest = {grant_type:"authorization_code";code:string;redirect_uri:string;code_verifier:string}
  | {grant_type:"refresh_token";refresh_token:string};

export class LarkUserOAuthError extends Error {
  constructor(readonly reason:"provider_rejected"|"token_shape"|"refresh_unavailable"|"missing_scopes",
    readonly status?:number,readonly providerCode?:number) {super(reason);}
}

export function logLarkUserFailure(stage:"callback_input"|"session"|"state"|"authority"|"app_credential"|"token"|"identity"|"grant",cause?:unknown):false {
  const failure=cause instanceof LarkUserOAuthError?cause:undefined;
  console.log({event:"runtime_lark_user",stage,reason:failure?.reason,http_status:failure?.status,provider_code:failure?.providerCode});
  return false;
}

export async function larkUserToken(app:LarkAppCredential, request:TokenRequest, send:(request:Request)=>Promise<Response>):Promise<LarkUserTokens> {
  const started=Date.now();
  const response=await send(new Request("https://accounts.feishu.cn/oauth/v3/token",{
    method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded",Accept:"application/json"},
    body:new URLSearchParams({...request,client_id:app.appId,client_secret:app.appSecret}),redirect:"manual",signal:AbortSignal.timeout(8000),
  }));
  const data=await readResponse(response);
  const scopes=typeof data.scope==="string"?data.scope.split(/\s+/).filter(Boolean):null;
  if(!token(data.access_token)||!lifetime(data.expires_in))throw new LarkUserOAuthError("token_shape");
  if(!token(data.refresh_token)||!lifetime(data.refresh_token_expires_in))throw new LarkUserOAuthError("refresh_unavailable");
  if(!scopes)throw new LarkUserOAuthError("missing_scopes");
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
  const data=await response.json<Record<string,unknown>|null>().catch(()=>null);
  if(!response.ok||!data||data.code!==0) {
    const code=data?.code;
    throw new LarkUserOAuthError("provider_rejected",response.status,typeof code==="number"&&Number.isSafeInteger(code)?code:undefined);
  }
  return data;
}

function token(value:unknown):value is string {
  return typeof value==="string"&&/^[\x21-\x7e]{1,8192}$/.test(value);
}

function lifetime(value:unknown):value is number {
  return typeof value==="number"&&Number.isSafeInteger(value)&&value>0&&value<=366*86400;
}
