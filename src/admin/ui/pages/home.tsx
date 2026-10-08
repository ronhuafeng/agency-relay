import type { AuthManagementProjection, StatusTone } from "../../auth-management";
import { statusToneForState } from "../../auth-management";
import type { RequestAttemptStateRow } from "../../../db";
import { formatNumber, formatOperatorInstantOrDash, presentText } from "../../format";
import { executionPlanPresentation } from "../../../plans/execution-plans";
import { DashLink, Panel, View } from "../chrome";
import { accountDashboardUrl, inventoryUrl, viewHref } from "../href";
import { Icon } from "../icon";
import { Button } from "../components/button";
import { Badge } from "../components/badge";
import { Empty, EmptyContent, EmptyHeader, EmptyTitle } from "../components/empty";
import { UsageTrends, type UsageTrendsModel } from "../usage-trends";

export interface HomeAccount {
  readonly key: string;
  readonly label: string;
  readonly client: "Codex" | "Grok";
  readonly projection: AuthManagementProjection;
}

export interface HomeModel {
  readonly canonicalUrl: string;
  readonly range: { readonly key: string };
  readonly userCount: number;
  readonly keyCount: number;
  readonly attempts: readonly RequestAttemptStateRow[];
  readonly accounts: readonly HomeAccount[];
  readonly trends: UsageTrendsModel | null;
}

interface AttentionItem {
  readonly kind: "client-failure" | "account";
  readonly tone: StatusTone;
  readonly title: string;
  readonly detail: string;
  readonly href: string;
  readonly action: string;
  readonly route?: string;
  readonly credentialKey?: string;
}

function accountAttention(account: HomeAccount, base: string): AttentionItem {
  return {
    kind: "account",
    tone: statusToneForState(account.projection.state),
    credentialKey: account.key,
    title: `${account.client === "Codex" ? "ChatGPT" : "Grok"} · ${presentText(account.label)}`,
    detail: presentText(account.projection.statusLabel),
    href: accountDashboardUrl(base, account.key),
    action: "打开账号"
  };
}

function attentionItems(model: HomeModel): AttentionItem[] {
  const failures = [...model.attempts]
    .filter((row) => row.last_failure_at && (!row.last_success_at || row.last_failure_at > row.last_success_at))
    .sort((a, b) => b.error_count - a.error_count)
    .slice(0, 5);
  const items: AttentionItem[] = failures.map((row) => ({
    kind: "client-failure",
    tone: "bad",
    title: executionPlanPresentation(row.route_profile_id).usageLabel,
    detail: `${formatNumber(row.error_count)} 次失败 · 最近 ${formatOperatorInstantOrDash(row.last_failure_at)}`,
    href: inventoryUrl(model.canonicalUrl, { view: "audit", range: model.range.key, audit_plan: row.route_profile_id, audit_result: "error", audit_from: row.last_failure_at?.slice(0, 10) ?? null, audit_to: row.last_failure_at?.slice(0, 10) ?? null }, "request-history"),
    action: "查看请求",
    route: row.route_profile_id
  }));
  for (const account of model.accounts) {
    const tone = statusToneForState(account.projection.state);
    if (tone === "bad" || tone === "warn") items.push(accountAttention(account, model.canonicalUrl));
  }
  return items;
}

function AttentionRow({ item }: { readonly item: AttentionItem }) {
  return <li data-attention={item.kind} data-tone={item.tone} data-attention-account={item.credentialKey}><div><strong>{item.title}</strong><span data-credential-status={item.credentialKey ? "" : undefined}>{item.detail}</span>{item.route?<code className="attention-route">{item.route}</code>:null}</div><DashLink className="action-link" href={item.href}>{item.action}<Icon name="arrow"/></DashLink></li>;
}

function AccountCards({ accounts, base }: { readonly accounts: readonly HomeAccount[]; readonly base: string }) {
  return <>{accounts.map(account => <article key={account.key} className="route-card" data-home-account={account.client === "Codex" ? "chatgpt" : "grok"} data-credential-key={account.key}>
    <div className="route-card-head"><div><DashLink className="action-link" href={accountDashboardUrl(base, account.key)}>{presentText(account.label)}</DashLink><span className="meta">{account.client === "Codex" ? "ChatGPT" : "Grok"}</span></div><Badge data-credential-status="" className={`tone-badge tone-${statusToneForState(account.projection.state)}`}>{presentText(account.projection.statusLabel)}</Badge></div>
    <template data-credential-attention-item=""><AttentionRow item={accountAttention(account, base)}/></template>
  </article>)}</>;
}

export function HomePage({ model }: { readonly model: HomeModel }) {
  const items = attentionItems(model);
  return <View label="首页" role="home" mode="product" className="pulse-board view-stack">
    <div className="magnitude-row home-resource-summary" data-home-summary="true">
      <DashLink className="magnitude" href={viewHref("access",model.range.key)}><Icon name="access"/><span>成员与服务账号</span><strong>{formatNumber(model.userCount)}</strong><Icon name="arrow"/></DashLink>
      <DashLink className="magnitude" href={viewHref("access",model.range.key)}><Icon name="keys"/><span>密钥</span><strong>{formatNumber(model.keyCount)}</strong><Icon name="arrow"/></DashLink>
      <DashLink className="magnitude" href={viewHref("credentials",model.range.key)}><Icon name="credentials"/><span>上游连接</span><strong>{formatNumber(model.accounts.length)}</strong><Icon name="arrow"/></DashLink>
    </div>
    {model.trends ? <UsageTrends model={model.trends}/> : <Panel title="用量报告">
      <Empty role="alert" data-home-usage="unavailable"><EmptyHeader><EmptyTitle>用量暂时无法读取</EmptyTitle></EmptyHeader><EmptyContent><p>当前统计未知，请重试。</p><Button asChild variant="outline"><DashLink href={model.canonicalUrl}>重试</DashLink></Button></EmptyContent></Empty>
    </Panel>}
    <div className="home-overview-grid" data-has-attention={String(items.length>0)}>
      {items.length > 0 || model.accounts.length > 0 ? <Panel className="attention-panel" panel="attention" hidden={items.length === 0} title="需要处理" meta={<span data-attention-count="">{`${items.length} 项`}</span>}><ul className="attention-list" data-attention-queue="true">
        {items.map(item => <AttentionRow key={`${item.kind}:${item.href}:${item.title}`} item={item}/>)}
      </ul></Panel> : null}
      {model.accounts.length > 0 ? <div className="home-account-host" hidden data-home-accounts="true"><AccountCards accounts={model.accounts} base={model.canonicalUrl}/></div> : <div className="account-onboarding"><p>还没有上游连接。</p><Button asChild><DashLink href={`${viewHref("credentials", model.range.key)}&task=add-account`}>连接账号</DashLink></Button></div>}
    </div>
  </View>;
}
