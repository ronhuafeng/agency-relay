import { UsageTrends, type UsageTrendsModel } from "../usage-trends";
import { formatNumber, formatOperatorInstantOrDash, formatUsdTicks, formatUsageSeconds, presentText } from "../../format";
import { executionPlanPresentation } from "../../../plans/execution-plans";
import type { MediaUsageSummaryRow, UsageSummaryRow } from "../../../types";
import { UsageReportIsland } from "../islands";
import type { UsageFact, UsageRecord } from "../models";
import { usageCost } from "../../usage-cost";
import { Button } from "../components/button";
import { Input } from "../components/input";
import { Label } from "../components/label";
import { Download, Search } from "lucide-react";
import { inventoryUrl } from "../href";

export interface UsagePageModel {
  readonly trends?: UsageTrendsModel;
  readonly rows: readonly UsageSummaryRow[];
  readonly mediaRows: readonly MediaUsageSummaryRow[];
  readonly rowsTruncated: boolean;
  readonly mediaRowsTruncated: boolean;
  readonly range: {readonly emptyLabel: string; readonly rawUsageUrl: string};
  readonly filterPlaceholder?: string;
  readonly limitNote?: string;
  readonly search?: string;
  readonly searchUrl?: string;
}
function formatRatioPercent(numerator: number, denominator: number): string {
  return denominator > 0 ? `${(numerator / denominator * 100).toFixed(1)}%` : "—";
}
function service(plan: string): {authority: string; label: string} {
  switch (executionPlanPresentation(plan).clientLabel) {
    case "Codex": return {authority: "chatgpt", label: "Codex"};
    case "Grok": return {authority: "grok", label: "Grok"};
    case "xAI API": return {authority: "xai", label: "xAI API"};
    case "Client": return {authority: "unattributed", label: "来源未记录"};
  }
}
function responseRecord(row: UsageSummaryRow, index: number): UsageRecord {
  const source = service(row.route_profile_id);
  const measured = row.token_measurements > 0;
  const metrics: UsageFact[] = [{label: "请求", value: formatNumber(row.requests)}, {label: "已记录令牌", value: measured ? formatNumber(row.total_tokens) : "未记录"}];
  const cost = usageCost(row.route_profile_id, row);
  if (cost) metrics.push({label: cost.label, value: cost.measurements > 0 ? formatUsdTicks(cost.ticks) : "未提供"});
  if (row.error_requests > 0) metrics.push({label: "失败请求", value: formatNumber(row.error_requests), tone: "bad"});
  const cache = measured && row.input_tokens > 0 ? formatRatioPercent(row.cached_input_tokens, row.input_tokens) : "—";
  return {
    id: `responses-${index}`, authority: source.authority, service: source.label, plan: row.route_profile_id,
    owner: presentText(row.email ?? row.user_id), title: presentText(row.response_model), metrics,
    note: measured && row.token_measurements < row.requests ? `${formatNumber(row.requests - row.token_measurements)} 次请求未记录令牌用量。` : null,
    details: [
      {label: "成功请求", value: formatNumber(row.ok_requests)}, {label: "失败请求", value: formatNumber(row.error_requests)},
      {label: "输入令牌", value: measured ? formatNumber(row.input_tokens) : "未记录"}, {label: "输出令牌", value: measured ? formatNumber(row.output_tokens) : "未记录"},
      {label: "缓存读取占比", value: cache}, {label: "令牌记录覆盖", value: `${formatRatioPercent(row.token_measurements, row.requests)} · ${formatNumber(row.token_measurements)} / ${formatNumber(row.requests)} 次请求`},
      ...(cost ? [{label: "金额来源", value: cost.help}, {label: "金额记录覆盖", value: `${formatNumber(cost.measurements)} / ${formatNumber(row.requests)} 次请求`}] : []),
      {label: "最近使用", value: formatOperatorInstantOrDash(row.last_seen_at)}, {label: "服务", value: executionPlanPresentation(row.route_profile_id).usageLabel}
    ]
  };
}
function mediaRecord(row: MediaUsageSummaryRow, index: number): UsageRecord {
  const source = service(row.route_profile_id);
  const titles = {image_generation: "生成图像", image_edit: "编辑图像", video_generation: "生成视频", video_edit: "编辑视频", video_extension: "延长视频"};
  const opportunities = row.capability === "image_generation" || row.capability === "image_edit" ? row.started_jobs : row.completed_jobs + row.failed_jobs + row.expired_jobs;
  const metrics: UsageFact[] = [{label: "已开始", value: formatNumber(row.started_jobs)}, {label: "已记录输出", value: row.output_measurements > 0 ? formatNumber(row.outputs) : "未记录"}];
  if (row.capability.startsWith("video")) metrics.push({label: "已记录时长", value: row.duration_measurements > 0 ? formatUsageSeconds(row.video_seconds) : "未记录"});
  const cost = usageCost(row.route_profile_id, row);
  if (cost) metrics.push({label: cost.label, value: cost.measurements > 0 ? formatUsdTicks(cost.ticks) : "未提供"});
  return {
    id: `media-${index}`, authority: source.authority, service: source.label, plan: row.route_profile_id,
    owner: presentText(row.email ?? row.user_id), title: titles[row.capability], metrics, note: null,
    details: [
      {label: "已完成", value: formatNumber(row.completed_jobs)}, {label: "失败", value: formatNumber(row.failed_jobs)}, {label: "已过期", value: formatNumber(row.expired_jobs)},
      {label: "输出记录覆盖", value: `${formatNumber(row.output_measurements)} / ${formatNumber(opportunities)} 次${row.capability.startsWith("video") ? "终态" : "请求"}`}, {label: "时长记录覆盖", value: `${formatNumber(row.duration_measurements)} / ${formatNumber(opportunities)} 次${row.capability.startsWith("video") ? "终态" : "请求"}`},
      {label: "费用记录覆盖", value: `${formatNumber(row.cost_measurements)} / ${formatNumber(opportunities)} 次${row.capability.startsWith("video") ? "终态" : "请求"}`},
      {label: "最近使用", value: formatOperatorInstantOrDash(row.last_seen_at)}, {label: "服务", value: executionPlanPresentation(row.route_profile_id).usageLabel}
    ]
  };
}
export function UsagePage({model}: {readonly model: UsagePageModel}) {
  const url = new URL(model.searchUrl ?? model.trends?.navigationUrl ?? "/admin?view=usage", "https://console.invalid");
  return <div className="usage-page view-stack"><form method="get" action={url.pathname} data-dashboard-search="" data-search-anchor="usage-trends" className="usage-toolbar" aria-label="筛选全部用量">
    {[...url.searchParams].filter(([key]) => key !== "q").map(([key, value]) => <input key={key} type="hidden" name={key} value={value}/>)}
    {model.trends ? <div className="usage-query-range"><nav className="ranges" aria-label="UTC 时间范围"><a href={inventoryUrl(`${url.pathname}${url.search}`, {range: "7d"})} data-dashboard-link="" aria-current={model.trends.range.key === "7d" ? "true" : undefined}>7 天</a><a href={inventoryUrl(`${url.pathname}${url.search}`, {range: "30d"})} data-dashboard-link="" aria-current={model.trends.range.key === "30d" ? "true" : undefined}>30 天</a></nav><span className="usage-query-dates">{model.trends.range.from} 至 {model.trends.range.to} UTC</span></div> : null}
    <Label className="usage-search"><span className="sr-only">{model.filterPlaceholder ?? "搜索人员或模型"}</span><Input type="search" name="q" placeholder={model.filterPlaceholder ?? "搜索人员或模型"} defaultValue={model.search ?? ""} maxLength={256} autoComplete="off"/></Label>
    <Button type="submit" variant="outline"><Search className="ui-icon" aria-hidden="true"/>搜索</Button>
    {model.search ? <Button asChild variant="ghost"><a data-dashboard-link="" href={inventoryUrl(`${url.pathname}${url.search}`, {q: null})}>清除</a></Button> : null}
    <Button asChild variant="outline"><a href={model.range.rawUsageUrl} download="usage.json"><Download className="ui-icon" aria-hidden="true"/>导出数据</a></Button>
  </form>{model.trends ? <UsageTrends model={model.trends} rangeInToolbar/> : null}{model.rows.length + model.mediaRows.length > 0 || !model.trends ? <section id="usage-details" tabIndex={-1} aria-label="用量明细"><UsageReportIsland control={{
    records: [...model.rows.map(responseRecord), ...model.mediaRows.map(mediaRecord)],
    emptyLabel: model.range.emptyLabel,
    exportUrl: model.range.rawUsageUrl,
    truncated: model.rowsTruncated || model.mediaRowsTruncated,
    filterPlaceholder: model.filterPlaceholder ?? "搜索人员或模型",
    limitNote: model.limitNote ?? "请求和媒体记录分别显示最多 250 条，导出文件中各保留最多 1,000 条。"
  }} /></section> : null}</div>;
}
