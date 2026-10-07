import type { ControlAuditRow } from "../../control-audit";
import { CREDIT_SURFACE_IDS } from "../../../auth/credits";
import { DashLink, VisibleRowFilter } from "../chrome";
import { Button } from "../components/button";
import { ConfirmationFallback, Field } from "../fields";
import { formatNumber, formatOperatorInstantOrDash, presentText } from "../../format";
import { Badge } from "../components/badge";
import { InfoPopover } from "../components/info-popover";
import { Card, CardContent, CardFooter } from "../components/card";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "../components/table";

interface QuotaDefault {
  readonly surface_grant: string;
  readonly monthly_allowance: number;
  readonly shared_provider_authority?: string;
}


function surfaceTitle(surface: string): string {
  if (surface === "codex") return "Codex";
  if (surface === "grok") return "Grok";
  if (surface === "xai") return "xAI API";
  return surface;
}

export function QuotasPage({ defaults }: { readonly defaults: readonly QuotaDefault[] }) {
  const warning = "保存组织默认额度？继承它的账号将使用这些月度上限；个人额度和已用量保持不变，额度按 UTC 月重置。0 credits 只允许已授权的零消耗操作。xAI API 正额度会开放上游团队共享资源和派生凭据权限。";
  return (
    <section className="view-stack" aria-label="组织额度" data-view-role="quotas">
      <form className="organization-policy-form" data-dashboard-draft="credit-defaults" method="post" action="/admin/ui/credit-defaults" data-confirmation={warning}><Card className="organization-policy-board">
      <input type="hidden" name="confirm" value="1"/>
      <CardContent><Table className="organization-policy-table" aria-label="组织默认月度额度"><TableHeader><TableRow><TableHead>服务</TableHead><TableHead><div className="quota-column-heading"><span>每月额度（credits）</span><InfoPopover id="organization-quota-rules" label="额度规则" iconOnly><p>组织默认只影响继承它的账号。额度每个 UTC 月重置；修改上限不会清零已用量。</p><p>0 credits 仍允许已授权的零消耗操作。xAI API 正额度开放上游团队共享资源及派生凭据权限，不提供人员间资源隔离。</p></InfoPopover></div></TableHead></TableRow></TableHeader><TableBody>
        {defaults.map((row) => {
          const surface = row.surface_grant.split(":")[1] ?? row.surface_grant;
          return (
            <TableRow key={row.surface_grant} data-quota-default={surface}>
              <TableCell><strong>{surfaceTitle(surface)}</strong></TableCell>
              <TableCell><input type="hidden" name={`expected_${surface}`} value={row.monthly_allowance}/><Field control={{ label: `${surfaceTitle(surface)} 每月额度`, name: surface, value: String(row.monthly_allowance), type: "number", min: "0", step: "1", required: true, inputMode: "numeric" }}/></TableCell>
            </TableRow>
          );
        })}
      </TableBody></Table></CardContent><CardFooter><ConfirmationFallback message={warning}/><Button type="submit" disabled={defaults.length !== CREDIT_SURFACE_IDS.length}>保存</Button></CardFooter>
      {defaults.length !== CREDIT_SURFACE_IDS.length ? <p role="alert">组织默认额度未完整读到，请重新读取后再保存。</p> : null}
      </Card></form>
    </section>
  );
}

export function ControlAuditPage({ rows, truncated = false }: { readonly rows: readonly ControlAuditRow[]; readonly truncated?: boolean }) {
  return (
    <section className="view-stack" aria-label="管理记录" data-view-role="control-audit">
      <VisibleRowFilter label="管理记录" placeholder="过滤当前管理记录" countLabel={`${formatNumber(rows.length)} 条`} rowCount={rows.length} shownRowsOnly action={truncated ? <Badge>最近 100 条 · 未显示全部记录</Badge> : undefined}>
        <div className="management-table"><Table scrollLabel="管理操作记录" aria-label="管理操作记录"><TableHeader><TableRow><TableHead>操作与对象</TableHead><TableHead>操作人</TableHead><TableHead>时间 (UTC)</TableHead><TableHead>结果</TableHead><TableHead className="table-header-help"><span className="sr-only">详情</span><InfoPopover id="management-history-scope" label="记录范围" iconOnly><p>按时间倒序显示最近 100 条管理操作。对象使用当前名称，操作人保留当时的邮箱。</p><p>请求结果请查看请求记录。</p></InfoPopover></TableHead></TableRow></TableHeader><TableBody>
          {rows.length === 0
            ? <TableRow><TableCell colSpan={5} className="empty">还没有管理操作记录。</TableCell></TableRow>
            : rows.map((row, index) => (
              <TableRow className="control-record" key={`${row.at}:${index}`}>
                <TableCell className="control-record-object"><strong>{actionLabel(row.action)}</strong>
                <div className="control-record-target">{row.target_href ? <DashLink className="action-link" href={row.target_href}>{presentText(row.target_label ?? targetTypeLabel(row.target_type))}</DashLink> : <span>{presentText(row.target_label ?? targetTypeLabel(row.target_type))}</span>}</div>
                </TableCell><TableCell className="control-record-actor">{presentText(row.actor_email ?? "未记录邮箱")}<span>{row.actor_role === "admin" ? "管理员" : row.actor_role === "user" ? "成员" : "未记录角色"}</span></TableCell>
                <TableCell className="control-record-time"><time dateTime={row.at} title={row.at}>{formatOperatorInstantOrDash(row.at).replace(" UTC","")}</time></TableCell>
                <TableCell className="control-record-result"><ResultBadge result={row.result} /></TableCell>
                <TableCell className="control-record-detail"><InfoPopover id={`control-record-${index}`} label="操作详情" iconOnly><dl className="admin-facts"><div><dt>对象标识</dt><dd>{presentText(row.target_id)}</dd></div><div><dt>对象类型</dt><dd>{targetTypeLabel(row.target_type)}</dd></div><div><dt>身份类型</dt><dd>{actorKindLabel(row.actor_kind)}</dd></div><div><dt>操作标识</dt><dd>{presentText(row.action)}</dd></div></dl></InfoPopover></TableCell>
              </TableRow>
            ))}
        </TableBody></Table></div>
      </VisibleRowFilter>
    </section>
  );
}

function ResultBadge({ result }: { readonly result: string }) {
  const status = resultLabel(result);
  return <Badge className={`tone-badge tone-${status.tone}`}>{status.label}</Badge>;
}

function resultLabel(result: string): { readonly label: string; readonly tone: "ok" | "bad" | "neutral" } {
  if (result === "ok") return { label: "操作成功", tone: "ok" };
  if (result === "error") return { label: "操作失败", tone: "bad" };
  if (result === "denied") return { label: "操作被拒绝", tone: "bad" };
  return { label: "结果未知", tone: "neutral" };
}

function actorKindLabel(kind: string): string {
  if (kind === "access") return "控制台登录";
  if (kind === "admin_secret") return "管理接口";
  return "未记录身份";
}

function targetTypeLabel(type: string): string {
  if (type === "user") return "人员";
  if (type === "surface_credit") return "服务额度";
  if (type === "credential") return "上游账号设置";
  if (type === "api_key") return "密钥";
  if (type === "api_key_surface_credential") return "密钥使用的账号";
  if (type === "codex_auth") return "ChatGPT 账号";
  if (type === "subscription_account") return "Grok 账号";
  return "未记录对象";
}

function actionLabel(action: string): string {
  const labels: Readonly<Record<string, string>> = {
    "service.create": "创建服务账号", "service.rename": "更改服务账号名称", "service.classify": "确认为服务账号", "service.owner.change": "更改服务管理人",
    "user.create": "添加人员", "user.enable": "启用人员", "user.disable": "停用人员", "user.promote": "设为管理员", "user.demote": "设为成员", "user.email": "更改邮箱",
    "key.create": "创建密钥", "key.replace.create": "更换密钥", "key.rename": "更改密钥名称", "key.revoke": "撤销密钥", "key.revoke_all": "撤销全部密钥", "key.credential_binding.set": "更改密钥使用的账号",
    "credit_policy.set": "设置个人额度", "credit_policy.delete": "恢复组织默认额度", "credit_default.set": "设置组织额度", "credential_default.set": "更改默认账号",
    "credential.retire": "停用上游账号", "credential.cleanup_retry": "重试账号清理", "credential.migrate_bindings": "迁移密钥使用的账号", "credential.migrate_defaults": "迁移默认账号",
    "credential.codex_create": "添加 ChatGPT 账号", "subscription.grok_create": "添加 Grok 账号", "credential.codex_oauth_start": "开始连接 ChatGPT", "credential.codex_oauth_complete": "完成连接 ChatGPT", "credential.grok_oauth_start": "开始连接 Grok", "credential.grok_oauth_complete": "完成连接 Grok",
    "credential.codex_refresh": "刷新 ChatGPT 连接", "credential.grok_refresh": "刷新 Grok 连接", "credential.codex_import": "导入 ChatGPT 连接", "credential.grok_test": "检查 Grok 连接", "credential.grok_storage_purge": "清理 Grok 账号数据"
  };
  return Object.hasOwn(labels, action) ? labels[action] ?? "管理操作" : "管理操作";
}
