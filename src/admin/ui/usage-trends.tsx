import { UsageComparisonIsland } from "./islands";
import type { UsageSeriesControl } from "./usage-series";
import type { MediaUsageDailyPoint, UsageDailyPoint, UsageDailyResult } from "../../types";
import { executionPlanPresentation } from "../../plans/execution-plans";
import { formatNumber, formatUsdTicks, formatUsageSeconds } from "../format";
import type { UsageTrendRange } from "../usage-query";
import { inventoryUrl } from "./href";
export interface UsageTrendsModel {
  range: UsageTrendRange;
  daily: UsageDailyResult;
  scopeLabel: string;
  filterLabel?: string;
  navigationUrl?: string;
  search?: string;
}
const number = formatNumber;
function measured(value: number, coverage: number, denominator: number, money = false, unit = "", opportunities = "次请求"): string {
  if (coverage === 0) return `${money ? "未提供" : "未记录"} · 覆盖 0/${number(denominator)}`;
  return `${money ? formatUsdTicks(value) : unit ? formatUsageSeconds(value) : number(value)} · 已记录 ${number(coverage)}/${number(denominator)} ${opportunities}`;
}
const zeroResponses = {requests: 0, ok_requests: 0, error_requests: 0, input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, reasoning_tokens: 0, total_tokens: 0, token_measurements: 0, provider_cost_usd_ticks: 0, cost_measurements: 0, api_equivalent_usd_ticks: 0, api_equivalent_measurements: 0};
const zeroMedia = {started_jobs: 0, completed_jobs: 0, failed_jobs: 0, expired_jobs: 0, outputs: 0, video_seconds: 0, output_measurements: 0, duration_measurements: 0, provider_cost_usd_ticks: 0, cost_measurements: 0};
/** These are complete SQL aggregates, never the displayed 100/250 detail rows. */
function sum<T extends Record<string, number>>(zero: T, rows: readonly T[]): T {
  const result = {...zero};
  for (const field of Object.keys(zero) as (keyof T)[]) result[field] = rows.reduce<number>((total, row) => total + row[field], 0) as T[keyof T];
  return result;
}
function responseSeries(plan: string, source: readonly UsageDailyPoint[], range: UsageTrendRange): UsageSeriesControl {
  const presentation = executionPlanPresentation(plan);
  const rows = range.days.map(day => source.find(row => row.day === day) ?? {...zeroResponses, day, route_profile_id: plan});
  const totals = sum(zeroResponses, source);
  return {
    id: `trend-data-${plan}`, plan, title: presentation.usageLabel,
    metrics: [
      {label: "Requests", value: number(totals.requests)},
      {label: "Failure", value: number(totals.error_requests)},
      {label: "Token", value: measured(totals.total_tokens, totals.token_measurements, totals.requests)}
    ],
    columns: ["Requests", "Failure", "Token · 覆盖"],
    rows: rows.map(row => ({day: row.day, current: row.day === range.to, count: row.requests, failure: row.error_requests, tokens: row.token_measurements > 0 ? row.total_tokens : null, values: [number(row.requests), number(row.error_requests), measured(row.total_tokens, row.token_measurements, row.requests)]}))
  };
}
const capabilityLabels = {image_generation: "生成图像", image_edit: "编辑图像", video_generation: "生成视频", video_edit: "编辑视频", video_extension: "延长视频"};
function mediaSeries(plan: string, capability: MediaUsageDailyPoint["capability"], source: readonly MediaUsageDailyPoint[], range: UsageTrendRange): UsageSeriesControl {
  const presentation = executionPlanPresentation(plan);
  const video = capability.startsWith("video");
  const opportunities = (row: typeof zeroMedia) => video ? row.completed_jobs + row.failed_jobs + row.expired_jobs : row.started_jobs;
  const rows = range.days.map(day => source.find(row => row.day === day) ?? {...zeroMedia, day, route_profile_id: plan, capability});
  const totals = sum(zeroMedia, source); const denominator = opportunities(totals);
  const measurement = (value: number, coverage: number, count: number, money = false, unit = "") => measured(value, coverage, count, money, unit, video ? "次终态" : "次请求");
  return {
    id: `trend-data-${plan}-${capability}`, plan, capability, title: `${presentation.clientLabel} · ${capabilityLabels[capability]}`,
    metrics: [
      {label: "开始", value: number(totals.started_jobs)},
      {label: "完成 / 失败 / 过期", value: `${number(totals.completed_jobs)} / ${number(totals.failed_jobs)} / ${number(totals.expired_jobs)}`},
      {label: "输出", value: measurement(totals.outputs, totals.output_measurements, denominator)},
      ...(video ? [{label: "时长", value: measurement(totals.video_seconds, totals.duration_measurements, denominator, false, " 秒")}] : [])
    ],
    columns: ["开始", "完成 / 失败 / 过期", "输出 · 覆盖", ...(video ? ["秒 · 覆盖"] : [])],
    rows: rows.map(row => ({day: row.day, current: row.day === range.to, count: row.started_jobs, failure: row.failed_jobs, values: [number(row.started_jobs), `${number(row.completed_jobs)} / ${number(row.failed_jobs)} / ${number(row.expired_jobs)}`, measurement(row.outputs, row.output_measurements, opportunities(row)), ...(video ? [measurement(row.video_seconds, row.duration_measurements, opportunities(row), false, " 秒")] : [])]}))
  };
}
export function UsageTrends({model, rangeInToolbar = false}: {model: UsageTrendsModel; rangeInToolbar?: boolean}) {
  const {daily, range} = model;
  const plans = [...new Set(daily.responses.map(row => row.route_profile_id))];
  const mediaGroups = [...new Map(daily.media.map(row => [`${row.route_profile_id}:${row.capability}`, {plan: row.route_profile_id, capability: row.capability}])).values()];
  const series = [...plans.map(plan => responseSeries(plan, daily.responses.filter(row => row.route_profile_id === plan), range)),
    ...mediaGroups.map(({plan, capability}) => mediaSeries(plan, capability, daily.media.filter(row => row.route_profile_id === plan && row.capability === capability), range))];
  const labels: Record<string, string> = {"codex.responses": "Codex · Responses", "codex.responses_compact": "Codex · Compact", "codex.historical.responses": "Codex · 历史"};
  const distinctSeries = series.map(item => series.filter(other => other.title === item.title).length > 1 ? {...item, title: labels[item.plan] ?? `${item.title} · ${item.plan}`} : item);
  const navigation = model.navigationUrl ? {key: range.key, href7: inventoryUrl(model.navigationUrl, {range: "7d"}), href30: inventoryUrl(model.navigationUrl, {range: "30d"})} : undefined;
  return <section id="usage-trends" tabIndex={-1} className="usage-trends view-stack" aria-label="按日用量趋势" data-usage-range-label={`${range.from} 至 ${range.to} UTC`} data-usage-search={model.search ?? ""}>
    <h2 className="sr-only">{model.scopeLabel}</h2>{model.filterLabel ? <p className="usage-filter-context">{model.filterLabel}</p> : null}
    <UsageComparisonIsland control={{id: "usage-comparison", range: rangeInToolbar ? undefined : navigation, series: distinctSeries, days: distinctSeries.length ? undefined : range.days.map(day => ({day, current: day === range.to}))}}/>

  </section>;
}
