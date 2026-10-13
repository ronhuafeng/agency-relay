import {consoleCookieToken} from "../auth/console-session";
import {hmacSha256Hex} from "../crypto";
import {HttpError} from "../errors";
import type {RuntimeMemberModel} from "./oauth";

export async function runtimeBrowserSessionHash(env:Env,request:Request):Promise<string|null> {
  const token=consoleCookieToken(request);
  return token?hmacSha256Hex(env.API_KEY_HASH_PEPPER,token):null;
}

/** Same authority projection for scoped JSON and personal HTML; no provider probe. */
export async function readRuntimeMember(env:Env,request:Request):Promise<RuntimeMemberModel> {
  const reply=await env.RUNTIME_OAUTH.getByName("organization").memberData(await runtimeBrowserSessionHash(env,request));
  if(reply.status!==200||"error" in reply.body)
    throw new HttpError(reply.status,"Runtime access could not be read.","authentication_error","runtime_state_unavailable");
  return reply.body;
}
