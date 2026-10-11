import type { AdminDashboardAccessModel } from "../dashboard-data";
import { parseApiKeyScopes } from "../../auth/authenticate";
import { keyIsExpired, keyStateLabel } from "../key-label";
import { productAccessLabels } from "../client-setup";
import { formatOperatorInstantOrDash, personLabel } from "../format";
import { accountChoices, clientFromGrant, type Client } from "./access-options";
import { Button } from "./components/button";
import { ConfirmationFallback, KeyExpiryField } from "./fields";
import { SelectView } from "./forms";
import { inventoryUrl } from "./href";
import { DashLink } from "./chrome";
import { Badge } from "./components/badge";
import { TaskClose } from "./task-workspace";
function KeyAccount({model, keyId, grant, client, editable}: {readonly model: AdminDashboardAccessModel; readonly keyId: string; readonly grant: string; readonly client: Client; readonly editable: boolean}) {
  const binding = model.credentialBindings.find((binding) => binding.api_key_id === keyId && binding.surface_grant === grant);
  const accountId = binding?.codex_auth_id ?? binding?.subscription_account_id ?? ""; const accounts = accountChoices(model, client);
  const label = productAccessLabels([grant])[0] ?? "客户端";
  if (accounts === null) return <div className="key-account-fact" data-credential-read-state="unknown"><strong>{label}</strong><p role="alert">连接列表暂时未读到。<a href={model.canonicalUrl}>重新读取</a></p></div>;
  if (!editable) return <div className="key-account-fact"><strong>{label}</strong><span>{accounts.find((account) => account.id === accountId)?.label ?? (accountId ? "账号不可用" : "未选择账号")}</span></div>;
  const selected = accounts.some((account) => account.id === accountId) ? accountId : "";
  return <form className="inline-form" method="post" action={`/admin/ui/keys/${encodeURIComponent(keyId)}/credential-bindings/${client}${model.selectedPersonId ? `?person=${encodeURIComponent(model.selectedPersonId)}` : ""}`} data-action="credential-binding-set" data-dashboard-draft="binding">
    <input type="hidden" name="key_return" value={model.canonicalUrl} />
    <p className="caption">仅更改密钥 <code>{model.selectedKey?.key_prefix ?? keyId}</code> 的 {label} 上游身份，影响后续请求。其他密钥、服务权限和额度不变；服务商资源与历史不会迁移。</p>
    <SelectView control={{id: `select-binding-${keyId}-${client}`, name: "credential_account_id", label: `${label} 账号`, required: true, value: selected, options: accounts.length === 0 ? [{value: "", label: "没有可用账号", disabled: true}] : [{value: "", label: "选择账号", disabled: selected.length > 0}, ...accounts.map((account) => ({value: account.id, label: `${account.label} · ${account.status}`, disabled: account.disabled}))]}} />
    <Button type="submit" variant="outline">使用这个账号</Button>
  </form>;
}
export function KeyDetail({model}: {readonly model: AdminDashboardAccessModel}) {
  const key = model.selectedKey; const person = model.selectedUser;
  if (!key || !person) return <section className="workspace-section" data-key-missing=""><h2>没有这个密钥</h2><p className="caption">这个人没有这个密钥。</p><DashLink className="action-link" href={inventoryUrl(model.canonicalUrl, {key: null}, "keys")}>查看这个人的密钥</DashLink></section>;
  const expired = keyIsExpired(key, model.nowMs); const grants = parseApiKeyScopes(key.scopes); const warning = `撤销 ${key.key_prefix}。后续认证将被拒绝，不能恢复。已经开始的请求或外部任务不保证立即停止。`;
  const replacement = `更换 ${key.key_prefix}？这会创建一个新密钥。换发不会自动撤销原密钥。请先保存新的安装文件，再验证客户端。`;
  return <section className="key-detail workspace-section" id="key-detail" tabIndex={-1} data-key-detail={key.id}><header className="key-detail-head"><div><span className="eyebrow">{personLabel(person)}</span><h2>{key.name??"未命名密钥"}</h2><code className="key-prefix">{key.key_prefix}</code></div><div className="task-head-actions"><Badge className="key-state">{keyStateLabel(key, person, model.nowMs)}</Badge><TaskClose href={inventoryUrl(model.canonicalUrl, {key: null}, "keys")} label="收起密钥详情"/></div></header>
    <dl className="key-facts"><div><dt>创建时间</dt><dd>{formatOperatorInstantOrDash(key.created_at)}</dd></div><div><dt>到期时间</dt><dd>{key.expires_at ? formatOperatorInstantOrDash(key.expires_at) : "没有到期时间"}</dd></div><div><dt>最近使用</dt><dd>{formatOperatorInstantOrDash(key.last_used_at)}</dd></div></dl>
    <section className="key-accounts" aria-label="客户端账号"><h3>客户端账号</h3>{grants.map((grant) => {const client = clientFromGrant(grant); return client ? <KeyAccount key={grant} model={model} keyId={key.id} grant={grant} client={client} editable={key.status === "active" && !expired} /> : null;})}{grants.length === 0 ? <p className="empty">没有客户端访问。</p> : null}{grants.includes("surface:xai:production") ? <p className="caption">xAI API 可以操作组织共享的资源。</p> : null}</section>
    {key.status === "active" ? <section className="key-operations" aria-label="密钥操作">{expired ? <DashLink className="action-link" href={inventoryUrl(model.canonicalUrl, {key: null, task: "give-access"}, "give-access")}>授予新的访问</DashLink> : <div className="key-operation"><p className="caption">这会再发一个密钥和客户端文件。换发不会自动撤销原密钥。</p><form className="inline-form" method="post" action={`/admin/ui/keys/${encodeURIComponent(key.id)}/replace`} data-action="replace-key" data-dashboard-draft="replacement" data-draft-scope="key" data-confirmation={replacement}><ConfirmationFallback message={replacement} /><input type="hidden" name="key_return" value={model.canonicalUrl} /><KeyExpiryField /><input type="hidden" name="confirm" value="1" /><Button type="submit">更换密钥</Button></form></div>}
      <div className="key-operation"><p className="caption">撤销后拒绝新的认证，无法恢复。</p><form className="inline-form" method="post" action={`/admin/ui/keys/${encodeURIComponent(key.id)}/revoke?person=${encodeURIComponent(person.id)}`} data-action="revoke-key" data-confirmation={warning}><ConfirmationFallback message={warning} /><input type="hidden" name="key_return" value={model.canonicalUrl} /><input type="hidden" name="confirm" value="1" /><Button type="submit" variant="destructive">撤销密钥</Button></form></div>
    </section> : null}
  </section>;
}
