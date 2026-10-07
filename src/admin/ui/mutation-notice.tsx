import type { DashboardMutationFlash } from "../dashboard-data";
import { buildClientSetupFiles, productAccessLabels } from "../client-setup";
import { Button } from "./components/button";
import { DisclosureIsland } from "./islands";
import { personLabel } from "../format";
import { Icon } from "./icon";
export type SetupResult = Extract<DashboardMutationFlash, {kind: "key_created" | "key_replacement_created"}>;
export function SetupPackage({result}: {readonly result: SetupResult}) {
  const files = buildClientSetupFiles({token: result.token, scopes: result.scopes});
  return <section className="setup-package mutation-flash" data-mutation-flash={result.kind} data-one-time-key="true">
    <div className="panel-head"><h2>安装包已准备好</h2></div>
    <p className="panel-caption"><a className="action-link" data-dashboard-link="" href={result.kind === "key_replacement_created" && result.return_url ? result.return_url : `/admin?view=access&person=${encodeURIComponent(result.user_id)}&key=${encodeURIComponent(result.key_id)}`}>{personLabel({ id: result.user_id, email: result.email })} <Icon name="arrow" /></a></p>
    <p className="panel-caption">新密钥前缀：<code>{result.key_prefix}</code></p>
    <p className="panel-caption">这些文件包含新密钥。离开这个页面后不会再提供。</p>
    {result.kind === "key_replacement_created" ? <p className="panel-caption" data-replacement-overlap={result.old_key_remains_active ? "true" : "false"}>上一个密钥 {result.previous_key_url ? <a data-dashboard-link="" href={result.previous_key_url}><code>{result.previous_key_prefix}</code></a> : <code>{result.previous_key_prefix}</code>} {result.old_key_remains_active ? "在到期或撤销前仍然有效。确认新的安装可用后，再撤销旧密钥。" : "不会因为这次续发恢复有效。请单独验证新密钥的安装。"}</p> : null}
    {files.length ? <ul className="setup-downloads">{files.map((file) => <li key={file.client} data-client-setup={file.client}><div><strong>{file.clientLabel}</strong><p className="caption">安装到 <code>{file.installTarget}</code></p></div>
      <Button asChild variant="outline"><a href={`data:text/plain;charset=utf-8,${encodeURIComponent(file.content)}`} download={file.filename}>下载 {file.filename}</a></Button></li>)}</ul> : <p className="empty">没有选择客户端。</p>}
    <DisclosureIsland control={{id: "one-time-secret", title: "手动复制密钥", token: result.token}} />
  </section>;
}
export function MutationNotice({flash}: {readonly flash: DashboardMutationFlash | null | undefined}) {
  if (flash?.kind === "key_replacement_error") return <section className="mutation-flash" role="alert" data-mutation-input-error=""><h2>密钥没有换发</h2><p>{flash.message}</p><p className="panel-caption">请修改到期时间后重新确认。原密钥和绑定没有更改。</p></section>;
  if (flash?.kind === "credential_task_error") {
    const href = `/admin?view=credentials${flash.provider && flash.account_id ? `&account=${encodeURIComponent(`${flash.provider}:${flash.account_id}`)}` : ""}`;
    return <section className="mutation-flash" role="alert" data-mutation-input-error=""><p>{flash.message}</p><a data-rejected-read="" href={href}>查看当前连接</a></section>;
  }
  if (flash?.kind === "codex_refresh_error") return <section className="panel mutation-flash" role="alert" data-mutation-flash={flash.kind}><p>{flash.message}</p></section>;
  if (flash?.kind === "credit_default_error") return <section className="mutation-flash" role="alert" data-mutation-input-error=""><p>{flash.message}</p><a data-rejected-read="" href="/admin?view=quotas">查看当前组织额度</a></section>;
  if (flash?.kind === "service_error") return flash.action === "create" ? null : <section className="panel mutation-flash" role="alert" data-mutation-input-error=""><p>{flash.message}</p></section>;
  if (flash?.kind === "user_lifecycle_error") return <section className="panel mutation-flash" role="alert" data-mutation-input-error=""><p>{flash.message}</p></section>;
  if (!flash || flash.kind === "user_create_error" || flash.kind === "codex_oauth_started" || flash.kind === "grok_oauth_started") return null;
  if (flash.kind === "key_created" || flash.kind === "key_replacement_created") return <SetupPackage result={flash} />;
  if (flash.kind === "credential_binding") return <section className="panel mutation-flash" role="status" data-mutation-flash={flash.kind}><div className="panel-head"><h2>{`${productAccessLabels([flash.surface_grant])[0] ?? "客户端"} 上游绑定已更新`}</h2></div><p className="panel-caption">仅密钥 <code>{flash.key_id}</code> 的这个服务使用新上游身份。其他密钥、服务权限和额度不变；服务商资源与历史没有迁移。</p></section>;
  if (flash.kind === "user_created") return <section className="panel mutation-flash" role="status" data-mutation-flash={flash.kind}><div className="panel-head"><h2>{`已添加 ${personLabel({ id: flash.user_id, email: flash.email })}。`}</h2></div><p className="panel-caption">已建立普通成员身份，尚未生成密钥。成员可使用这个组织邮箱登录，再按当前额度与服务条件管理自己的密钥。</p></section>;
  if (flash.kind === "credit_default") return (
    <section className="panel mutation-flash" role="status" data-mutation-flash={flash.kind}>
      <div className="panel-head"><h2>组织额度已更新</h2></div>
      <p className="panel-caption">{flash.defaults.map(row=>`${productAccessLabels([row.surface_grant])[0] ?? row.surface_grant} · 每月 ${row.monthly_allowance} credits`).join("；")}。使用组织默认的账号受此设置影响，个人额度和已用量保持不变。</p>
      <p className="panel-caption"><a className="action-link" data-dashboard-link="" data-quota-confirmed-read="" href="/admin?view=quotas">查看当前组织额度</a></p>
      <p className="panel-caption" data-quota-read-guidance="">请使用上方链接读取最新额度；若刷新时提示再次提交，请取消。</p>
    </section>
  );
  let title: string; let detail: string | null = null;
  switch (flash.kind) {
    case "credential_default": title = `${productAccessLabels([flash.surface_grant])[0]} 默认连接已更新`; detail = "新密钥将使用当前默认连接。现有密钥保持原绑定，替换密钥复制原绑定。"; break;
    case "credential_migrated": title = flash.bindings + flash.defaults > 0 ? "所选项目已迁移" : "旧连接已进入停用阶段"; detail = `${flash.bindings} 项密钥绑定、${flash.defaults} 项默认连接已迁移。${flash.bindings + flash.defaults === 0 ? "本次没有移动绑定或默认连接。" : ""}旧连接正在停用；请核对剩余项目后，单独断开旧连接。服务商持有的文件、响应、任务和历史没有迁移。`; break;
    case "credential_disconnected": title = flash.token_cleanup === "failed" ? "连接已断开，令牌清理未确认" : "连接已断开，令牌清理已确认"; detail = flash.token_cleanup === "failed" ? "旧连接不能用于新绑定。请使用此连接的“重试清理”继续处理。" : null; break;
    case "credential_cleanup": title = flash.token_cleanup === "failed" ? "令牌清理仍未确认" : "令牌清理已确认"; detail = flash.token_cleanup === "failed" ? "连接没有恢复。请核对当前状态后重试清理。" : "旧连接的令牌已清理，密钥绑定没有更改。"; break;
    case "service_owner_changed": title = "服务管理人已更新"; detail = "控制台管理权限已按当前分配更新。密钥没有更改：原管理人保存的密钥仍可能用于 API 调用。请按需要另行撤销旧密钥，或先更换、验证新密钥后再撤销旧密钥。额度、绑定、用量和历史保留。"; break;
    case "service_changed": title = flash.action === "create" ? "服务账号已创建" : flash.action === "classify" ? "已确认为服务账号" : "服务名称已更新"; detail = `${flash.display_name}。${flash.action === "create" ? "三个服务额度均为停用，请明确配置额度后再创建密钥。" : "原有密钥、绑定、额度、消耗和历史保留。"}服务账号不能登录或成为管理员。`; break;
    case "key_revoked": title = flash.already_revoked ? "已经撤销" : "密钥已撤销"; detail = `密钥 ${flash.key_prefix ?? "未记录前缀"}${flash.already_revoked ? "之前已经撤销。" : "已撤销。正在使用它的客户端会立刻失败。"}`; break;
    case "user_role": title = "角色已更新"; detail = `当前角色为${flash.role === "admin" ? "管理员" : "普通成员"}。API 密钥的权限和额度未改变。`; break;
    case "user_email": title = "邮箱已迁移"; detail = `${flash.previous_email ?? "未确认邮箱"} → ${flash.email}。旧控制台会话已失效，需使用新邮箱重新登录。API 密钥与历史不变；如有泄漏风险，请另外撤销或替换密钥。`; break;
    case "user_status": title = "人员已更新"; detail = `${personLabel({ id: flash.user_id, email: flash.email })} 的访问${flash.status === "active" ? "已启用" : "已停用"}。`; break;
    case "credit_policy": return <p className="mutation-confirmation" role="status" data-mutation-flash="credit_policy">{flash.surface === "codex" ? "Codex" : flash.surface === "grok" ? "Grok" : "xAI API"} 额度已更新</p>;
    case "codex_created": title = "已添加 ChatGPT 账号"; break;
    case "codex_imported": title = "ChatGPT 已连接"; break;
    case "codex_refreshed": title = "ChatGPT 已刷新"; break;
    case "codex_logged_out": title = "ChatGPT 已断开"; break;
    case "grok_created": title = "已添加 Grok 账号"; break;
    case "grok_imported": title = "Grok 已连接"; break;
    case "grok_refreshed": title = "Grok 已刷新"; break;
    case "grok_logged_out": title = "Grok 已断开"; break;
  }
  const credentialTask = flash.kind.startsWith("credential_");
  const accountKey = flash.kind === "credential_default" ? `${flash.surface_grant === "surface:codex:production" ? "codex" : "grok"}:${flash.account_id}`
    : "provider" in flash && flash.provider && "account_id" in flash ? `${flash.provider}:${flash.account_id}` : null;
  const readUrl = credentialTask ? `/admin?view=credentials${accountKey ? `&account=${encodeURIComponent(accountKey)}` : ""}` : null;
  return <section className="panel mutation-flash" role="status" data-mutation-flash={flash.kind}><div className="panel-head"><h2>{title}</h2></div>{detail ? <p className="panel-caption">{detail}</p> : null}{readUrl ? <a className="action-link" data-dashboard-link="" href={readUrl}>查看当前连接</a> : null}</section>;
}
