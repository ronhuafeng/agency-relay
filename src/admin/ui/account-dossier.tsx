import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "./components/table";
import type { ReactNode } from "react";
import type { CodexAccountSnapshot, CodexAdditionalRateLimit, CodexRateLimitWindow } from "../../codex/account";
import { formatNumber, formatOperatorInstant } from "../format";
import { Progress } from "./components/progress";
import { Badge } from "./components/badge";

function Facts({items}: {readonly items: readonly (readonly [string, ReactNode])[]}) {
  return <dl className="data-list">{items.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>;
}
function Unavailable({title, className = ""}: {readonly title: string; readonly className?: string}) {
  return <section className={`account-panel ${className}`} data-upstream-read="unavailable"><div className="panel-head"><h3>{title}</h3><Badge>未读到</Badge></div></section>;
}
function yesNo(value: boolean | null | undefined, yes = "是", no = "否"): string { return value == null ? "未报告" : value ? yes : no; }
function reportedLabel(value: string | null, labels: Readonly<Record<string, string>>): string {
  if (value === null) return "未报告";
  return Object.hasOwn(labels, value) ? labels[value] ?? value : value;
}
function percent(value: number | null | undefined): string { return value == null ? "未报告" : `${Math.round(value * 10) / 10}%`; }
function duration(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "未报告";
  const minutes = Math.max(0, Math.floor(value / 60));
  if (minutes < 1) return `${Math.max(0, Math.floor(value))} 秒`;
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60); const days = Math.floor(hours / 24);
  return days > 0 ? `${days} 天 ${hours % 24} 小时` : `${hours} 小时 ${minutes % 60} 分钟`;
}
function instant(value: string | number | null | undefined): ReactNode {
  if (value == null) return "未报告";
  const date = typeof value === "number" ? new Date(value * 1000) : new Date(value);
  if (!Number.isFinite(date.getTime())) return "未报告";
  return <time dateTime={date.toISOString()}>{formatOperatorInstant(date.toISOString())}</time>;
}
function UsageBar({value, label}: {readonly value: number | null; readonly label: string}) {
  return value === null ? null : <Progress value={Math.min(100, Math.max(0, value))} aria-label={label} />;
}
function LimitWindow({label, window}: {readonly label: string; readonly window: CodexRateLimitWindow | null}) {
  if (!window) return <p className="window-empty"><span className="window-empty-label">{label}</span><span className="window-empty-value">未报告</span></p>;
  return <article className="window"><div><strong>{label}</strong><span>{percent(window.usedPercent)}</span></div>
    <UsageBar value={window.usedPercent} label={`${label} ${percent(window.usedPercent)}`} />
    <Facts items={[["窗口长度", duration(window.windowSeconds)], ["距离重置", duration(window.resetAfterSeconds)], ["重置时间", instant(window.resetsAt)]]} />
  </article>;
}
function ModelLimit({limit}: {readonly limit: CodexAdditionalRateLimit}) {
  const details = limit.rateLimit; const primary = details?.primaryWindow; const used = primary?.usedPercent ?? null;
  const name = reportedLabel(limit.name, {"Code review": "代码审查"});
  return <article className="model-limit-row"><div className="model-limit-head"><strong>{name}</strong><span className="model-limit-feature">{reportedLabel(limit.meteredFeature, {codex_review: "代码审查额度"})}</span><span className="model-limit-used">{used === null ? "未报告" : `已用 ${percent(used)}`}</span></div>
    <UsageBar value={used} label={`${name} ${percent(used)}`} /><p className="model-limit-meta">允许 {yesNo(details?.allowed)} · 已达到限额 {yesNo(details?.limitReached)}</p>
  </article>;
}
function Limits({snapshot}: {readonly snapshot: CodexAccountSnapshot}) {
  if (snapshot.usage.status === "unavailable") return <Unavailable title="限额与计划" />;
  const usage = snapshot.usage.data; const limit = usage.rateLimit;
  return <section className="account-panel"><div className="panel-head"><h3>限额</h3><span className="meta">{yesNo(limit?.limitReached, "已达限额", "未达限额")}</span></div>
    <Facts items={[["计划", reportedLabel(usage.planType, {business: "商业版", free: "免费版", team: "团队版"})], ["允许", yesNo(limit?.allowed)], ["已达到限额", yesNo(limit?.limitReached)], ["限额原因", reportedLabel(usage.rateLimitReachedType, {workspace_member_usage_limit_reached: "工作区成员用量达到上限"})]]} />
    <div className="window-list"><LimitWindow label="主窗口" window={limit?.primaryWindow ?? null} /><LimitWindow label="次窗口" window={limit?.secondaryWindow ?? null} /></div>
    {usage.additionalRateLimits.length > 0 ? <div className="model-limits" data-model-limits="true"><p className="model-limits-heading">模型限额</p>{usage.additionalRateLimits.map((limit) => <ModelLimit key={limit.name} limit={limit} />)}</div> : null}
  </section>;
}
function Credits({snapshot}: {readonly snapshot: CodexAccountSnapshot}) {
  if (snapshot.usage.status === "unavailable") return <Unavailable title="额度与消费" />;
  const credits = snapshot.usage.data.credits; const spend = snapshot.usage.data.spendControl; const individual = spend?.individualLimit;
  return <section className="account-panel"><div className="panel-head"><h3>额度与消费</h3><span className="meta">{yesNo(spend?.reached, "已达消费限额", "未达消费限额")}</span></div>
    <Facts items={[["有额度", yesNo(credits?.hasCredits)], ["不限", yesNo(credits?.unlimited)], ["余额", credits?.balance ?? "未报告"],
      ["约计本地消息", credits?.approxLocalMessagesReported === undefined ? "未报告" : `已报告 ${formatNumber(credits.approxLocalMessagesReported)}`],
      ["约计云端消息", credits?.approxCloudMessagesReported === undefined ? "未报告" : `已报告 ${formatNumber(credits.approxCloudMessagesReported)}`],
      ["已达到消费限额", yesNo(spend?.reached)], ["限额来源", reportedLabel(individual?.source ?? null, {workspace: "工作区", individual: "个人"})], ["限额", individual?.limit ?? "未报告"],
      ["已用", `${individual?.used ?? "未报告"} · ${percent(individual?.usedPercent)}`], ["剩余", `${individual?.remaining ?? "未报告"} · ${percent(individual?.remainingPercent)}`],
      ["距离重置", duration(individual?.resetAfterSeconds)], ["重置时间", instant(individual?.resetsAt)]]} />
  </section>;
}
function TokenActivity({snapshot}: {readonly snapshot: CodexAccountSnapshot}) {
  if (snapshot.profile.status === "unavailable") return <Unavailable title="令牌活动" className="token-activity-panel" />;
  const profile = snapshot.profile.data; const number = (value: number | null): string => value === null ? "未报告" : formatNumber(value);
  return <section className="account-panel token-activity-panel"><div className="panel-head"><h3>令牌活动</h3><span className="meta">{profile.dailyUsage.length} 天</span></div>
    <Facts items={[["累计令牌", number(profile.lifetimeTokens)], ["单日峰值", number(profile.peakDailyTokens)], ["最长单轮", duration(profile.longestRunningTurnSeconds)], ["当前连续天数", profile.currentStreakDays === null ? "未报告" : `${number(profile.currentStreakDays)} 天`], ["最长连续天数", profile.longestStreakDays === null ? "未报告" : `${number(profile.longestStreakDays)} 天`]]} />
    <div className="table-wrap compact-wrap"><Table className="compact-table" aria-label="每日令牌用量" scrollLabel="每日令牌用量，可横向滚动"><TableHeader><TableRow><TableHead scope="col">日期</TableHead><TableHead scope="col" className="number">令牌</TableHead></TableRow></TableHeader><TableBody>
      {profile.dailyUsage.length === 0 ? <TableRow><TableCell colSpan={2}><p className="empty">没有按日报告的令牌用量。</p></TableCell></TableRow> : profile.dailyUsage.map((entry) => <TableRow key={entry.date}><TableCell>{entry.date}</TableCell><TableCell className="number">{formatNumber(entry.tokens)}</TableCell></TableRow>)}
    </TableBody></Table></div>
  </section>;
}
function ResetCredits({snapshot}: {readonly snapshot: CodexAccountSnapshot}) {
  if (snapshot.resetCredits.status === "unavailable") {
    const count = snapshot.usage.status === "available" ? snapshot.usage.data.resetCreditAvailableCount : null;
    return <section className="account-panel reset-panel" data-upstream-read="unavailable"><div className="panel-head"><h3>重置额度</h3><Badge>{count==null?"未读到":"明细未读到"}</Badge></div>{count==null?null:<p className="caption"><strong>{formatNumber(count)} 个可用</strong> · 账号用量记录</p>}</section>;
  }
  const details = snapshot.resetCredits.data;
  return <section className="account-panel reset-panel"><div className="panel-head"><h3>重置额度</h3><span className="meta">{formatNumber(details.availableCount)} 个可用</span></div>
    <p className="scroll-hint" id="reset-credits-scroll-hint">横向滚动可查看其余列。</p><div className="table-wrap wide-table-wrap">
    <Table className="reset-table" aria-label="重置额度明细" scrollLabel="重置额度明细表"><TableHeader><TableRow>{["额度", "类型", "状态", "授予时间", "到期时间", "说明"].map((label) => <TableHead key={label} scope="col">{label}</TableHead>)}</TableRow></TableHeader><TableBody>
      {details.credits.length === 0 ? <TableRow><TableCell colSpan={6}><p className="empty">没有重置额度的明细。</p></TableCell></TableRow> : details.credits.map((credit) => <TableRow key={credit.id}><TableCell><strong>{credit.title === null ? "未命名的重置额度" : reportedLabel(credit.title, {"Full reset": "完全重置"})}</strong></TableCell><TableCell>{reportedLabel(credit.resetType, {codexRateLimits: "Codex 限额"})}</TableCell><TableCell>{reportedLabel(credit.status, {available: "可用", expired: "已过期", redeemed: "已使用"})}</TableCell><TableCell>{instant(credit.grantedAt)}</TableCell><TableCell>{credit.expiresAt ? instant(credit.expiresAt) : "没有到期时间"}</TableCell><TableCell>{reportedLabel(credit.description, {"Weekly + 5 hr": "每周加 5 小时"})}</TableCell></TableRow>)}
    </TableBody></Table></div>
  </section>;
}
export function AccountDossier({accountId, snapshot}: {readonly accountId: string; readonly snapshot: CodexAccountSnapshot}) {
  if ([snapshot.usage,snapshot.profile,snapshot.resetCredits].every(read=>read.status === "unavailable")) return <section className="workspace-section" data-chatgpt-upstream="true" data-account-id={accountId}><h2>上游用量与限制</h2><div data-chatgpt-dossier="true" data-upstream-read="unavailable"><Badge>未读到</Badge><p className="caption">暂时无法读取上游用量与限制。此状态不能说明账号已断开或额度为零。</p></div></section>;
  return <section className="workspace-section" data-chatgpt-upstream="true" data-account-id={accountId}><h2>上游用量与限制</h2><div className="account-grid" role="group" aria-label="ChatGPT 限额与额度" data-chatgpt-dossier="true" data-upstream-read={snapshot.usage.status==="unavailable"&&snapshot.profile.status==="unavailable"&&snapshot.resetCredits.status==="unavailable"?"unavailable":undefined}><Limits snapshot={snapshot} /><Credits snapshot={snapshot} /><TokenActivity snapshot={snapshot} /><ResetCredits snapshot={snapshot} /></div></section>;
}
