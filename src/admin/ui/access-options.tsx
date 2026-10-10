import type { AdminDashboardAccessModel } from "../dashboard-data";
import { projectCodexIdentity, projectGrokIdentity } from "../auth-management";
import { AccessChoiceIsland } from "./islands";
import { SelectView } from "./forms";
import type { SurfaceCapabilitySurface } from "../../plans/capabilities";
import { profileForSurfaceGrant } from "../../plans/execution-plans";
export type Client = "codex" | "grok" | "xai";
export function clientFromGrant(grant: string): Client | null {
  return profileForSurfaceGrant(grant)?.id ?? null;
}
export function accountChoices(model: AdminDashboardAccessModel, client: Client) {
  const nowMs = Date.parse(model.dataAsOf);
  return client === "codex" ? model.codexAuths?.map((auth) => ({id: auth.id, label: auth.label, status: projectCodexIdentity({auth, nowMs}).statusLabel})) ?? null : model.subscriptionAccounts?.filter((account) => account.capability_source === "grok" && account.environment === "production").map((account) => ({id: account.id, label: account.label, status: projectGrokIdentity({account, nowMs}).statusLabel})) ?? null;
}
export function ClientAccessOption({access, model}: {readonly access: SurfaceCapabilitySurface; readonly model: AdminDashboardAccessModel}) {
  const accounts = accountChoices(model, access.id);
  if (accounts === null) return <div className="access-option" data-credential-read-state="unknown"><strong>{access.label}</strong><p role="alert">连接列表暂时未读到。<a href={model.canonicalUrl}>重新读取</a></p></div>;
  const description = access.id === "xai" ? "包含上游团队共享资源权限" : "";
  return <div className="access-option"><AccessChoiceIsland choice={{id: access.id, accessLevel: access.accessLevel, label: access.label, badge: access.accessLevel === "selected" ? "指定访问" : null, description}} />
    <SelectView control={{id: `select-access-${access.id}`, name: `${access.id}_credential_account_id`, label: `${access.label} 账号`, required: false, value: "", options: accounts.length === 0 ? [{value: "", label: "没有可用账号", disabled: true}] : [{value: "", label: "选择账号", disabled: false}, ...accounts.map((account) => ({value: account.id, label: `${account.label} · ${account.status}`, disabled: false}))]}} />
  </div>;
}
