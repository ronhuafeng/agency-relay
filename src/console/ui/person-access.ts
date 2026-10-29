import type { AdminDashboardAccessModel } from "../dashboard-data";
import { parseApiKeyScopes } from "../../auth/authenticate";
import { keyIsExpired } from "../../auth/key-state";
import { productAccessFromScopes } from "../client-setup";
export function clientAccess(model: AdminDashboardAccessModel, user: {id:string;status:string}) {
  const keys = model.accessKeys.filter(key=>key.user_id===user.id);
  const active = productAccessFromScopes(keys.filter(key=>!keyIsExpired(key,model.nowMs)).flatMap(key=>parseApiKeyScopes(key.scopes)));
  const expired = productAccessFromScopes(keys.filter(key=>keyIsExpired(key,model.nowMs)).flatMap(key=>parseApiKeyScopes(key.scopes)));
  return (["codex","grok","xai"] as const).map(client=>({client,label:client === "codex" ? "Codex" : client === "grok" ? "Grok" : "xAI API",state:active[client] ? user.status === "active" ? "granted" : "paused" : expired[client] ? "expired" : "none"} as const));
}
