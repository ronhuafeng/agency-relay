import { useState } from "react";
import { Button } from "./components/button";
import { useEnhanced } from "./use-enhanced";
import { readUsageSeries, type UsageSeriesControl } from "./usage-series";
import { formatNumber } from "../format";

export interface UsageComparisonControl {
  readonly id: string;
  readonly range?: UsageSeriesControl["range"];
  readonly series: readonly UsageSeriesControl[];
  readonly days?: readonly {readonly day: string; readonly current: boolean}[];
}
export function readUsageComparison(value: unknown): UsageComparisonControl | null {
  if (!value || typeof value !== "object" || !("id" in value) || typeof value.id !== "string" || !("series" in value) || !Array.isArray(value.series)) return null;
  const series: UsageSeriesControl[] = [];
  for (const item of value.series) {
    const control = readUsageSeries(item);
    if (!control) return null;
    series.push(control);
  }
  const range = readComparisonRange(value);
  if (range === null) return null;
  const days = readComparisonDays(value);
  if (!days) return null;
  if (!series.length) return {id: value.id, range, series, days};
  const first = value.series[0];
  const decoded = first && readUsageSeries({...first, range});
  return decoded ? {id: value.id, range: decoded.range, series} : null;
}
function readComparisonRange(value: object): UsageSeriesControl["range"] | null | undefined {
  if (!("range" in value) || value.range === undefined) return undefined;
  const item = value.range;
  if (!item || typeof item !== "object" || !("key" in item) || (item.key !== "7d" && item.key !== "30d") || !("href7" in item) || typeof item.href7 !== "string" || !("href30" in item) || typeof item.href30 !== "string") return null;
  return {key: item.key, href7: item.href7, href30: item.href30};
}
function readComparisonDays(value: object): UsageComparisonControl["days"] | null {
  if (!("days" in value) || value.days === undefined) return [];
  if (!Array.isArray(value.days)) return null;
  const days: {day: string; current: boolean}[] = [];
  for (const row of value.days) {
    if (!row || typeof row !== "object" || typeof row.day !== "string" || typeof row.current !== "boolean") return null;
    days.push({day: row.day, current: row.current});
  }
  return days;
}
type Metric = "count" | "failure" | "tokens" | "starts";
const metricLabels: Record<Metric, string> = {count: "请求（次）", failure: "响应失败（次）", tokens: "已记录令牌", starts: "媒体开始（次）"};
function valueOf(row: UsageSeriesControl["rows"][number], metric: Metric): number | null {
  return metric === "starts" ? row.count : row[metric] ?? null;
}
function dayLabel(row: UsageSeriesControl["rows"][number]): string {
  return `${row.day} UTC${row.current ? " · 未结束" : ""}`;
}
function pointLabel(series: UsageSeriesControl, row: UsageSeriesControl["rows"][number], metric: Metric): string {
  const value = valueOf(row, metric);
  return `${series.title} · ${dayLabel(row)} · ${metricLabels[metric]}：${value === null ? "未记录" : formatNumber(value)}${metric === "tokens" ? ` · ${row.values[2]?.split(" · ")[1] ?? ""}` : ""}`;
}
/** Band and stack coordinates belong to the chart; categorical colors come from DTCG. */
export function UsageComparison({control}: {readonly control: UsageComparisonControl}) {
  const enhanced = useEnhanced();
  const responses = control.series.some(series => !series.capability);
  const metric: Metric = responses ? "tokens" : "starts";
  const [hidden, setHidden] = useState<readonly string[]>([]);
  const days = control.series[0]?.rows ?? control.days ?? [];
  const compatible = control.series.filter(series => metric === "starts" ? !!series.capability : !series.capability);
  const visible = compatible.filter(series => !hidden.includes(series.id));
  const colors = new Map(control.series.map((series, index) => [series.id, index % 6 + 1]));
  const dayValues = days.map((_, index) => visible.map(series => valueOf(series.rows[index], metric)));
  const samples = dayValues.flat().map(value => value ?? 0);
  const peak = samples.length ? Math.max(...samples) : 0;
  const targetStep = Math.max(1, peak / 4);
  const magnitude = 10 ** Math.floor(Math.log10(targetStep));
  const step = magnitude * [1, 2, 5, 10].find(multiple => multiple >= targetStep / magnitude)!;
  const maximum = Math.max(2, Math.ceil(peak / step)) * step;
  const ticks = Array.from({length: maximum / step + 1}, (_, index) => maximum - index * step);
  const band = 600 / days.length;
  const y = (value: number) => 142 - value * 134 / maximum;
  return <section className="usage-comparison" aria-label="用量比较">
    <div className="usage-chart-legend" aria-label="显示的服务">{control.series.map(series => <div key={series.id} className="usage-legend-item" data-trend-plan={series.plan} data-trend-capability={series.capability}>
      <Button type="button" variant="ghost" disabled={!enhanced || !compatible.includes(series)} aria-pressed={!hidden.includes(series.id) && compatible.includes(series)} onClick={() => setHidden(hidden.includes(series.id) ? hidden.filter(id => id !== series.id) : [...hidden, series.id])}><svg viewBox="0 0 12 12" className="usage-series-swatch" aria-hidden="true"><rect width="12" height="12" data-series-color={colors.get(series.id)}/></svg>{series.title}</Button>
      <dl className="sr-only usage-metrics">{series.metrics.map(metric => <div key={metric.label}><dt>{metric.label}</dt><dd>{metric.value}</dd></div>)}</dl>
    </div>)}{control.range ? <nav className="ranges usage-legend-range" aria-label="UTC 时间范围"><a href={control.range.href7} data-dashboard-link="" aria-current={control.range.key === "7d" ? "true" : undefined}>7 天</a><a href={control.range.href30} data-dashboard-link="" aria-current={control.range.key === "30d" ? "true" : undefined}>30 天</a></nav> : null}</div>
    {days.length ? <div className="usage-chart-frame">
      <div className="usage-chart-y" aria-hidden="true">{ticks.map(tick => <span key={tick}>{formatNumber(tick)}</span>)}</div>
      <div className="usage-chart-body"><svg className="usage-bar-plot" viewBox="0 0 600 150" preserveAspectRatio="none" role="group" aria-label={`分组柱状图 · ${metricLabels[metric]}`}>
        {ticks.map(tick => <path key={tick} className="usage-chart-grid" d={`M0 ${y(tick)} H600`}/>)}
        {days.map((dayRow, dayIndex) => {
          return <g key={dayRow.day} data-chart-day={dayRow.day}>
            <rect aria-hidden="true" className="usage-day-hit" x={dayIndex * band} y="8" width={band} height="134"/>
            {visible.map((series, seriesIndex) => {
              const row = series.rows[dayIndex];
              const value = valueOf(row, metric);
              const top = value ?? 0;
              const barWidth = band * .8 / visible.length;
              const left = dayIndex * band + band * .1 + seriesIndex * barWidth;
              return <g key={series.id} data-chart-series={series.id} data-daily-plan={series.plan} data-daily-capability={series.capability}>
                {value === null ? <rect className="usage-unknown-mark" x={left} y="134" width={Math.max(.5, barWidth - 1)} height="8" tabIndex={0} role="img" aria-label={pointLabel(series, row, metric)}/> : <rect className="usage-chart-bar" data-series-color={colors.get(series.id)} x={left} y={y(top)} width={Math.max(.5, barWidth - 1)} height={y(0) - y(top)} tabIndex={0} role="img" aria-label={pointLabel(series, row, metric)}><title>{pointLabel(series, row, metric)}</title></rect>}
              </g>;
            })}
          </g>;
        })}
      </svg><div className="usage-chart-x" aria-hidden="true">{days.map((row, index) => { const step = days.length <= 8 ? 1 : Math.ceil(days.length / 8); return <span key={row.day}><svg className="usage-day-tick" viewBox="0 0 12 6" width="12" height="6" focusable="false"><polygon points="3,1 9,1 11,5 1,5"/><polygon points="2,0 8,0 10,4 0,4"/></svg><span>{index % step === 0 || index === days.length - 1 ? row.day.slice(5) : ""}</span></span>; })}</div></div>
    </div> : <p role="status">没有选中的可比较服务。</p>}

  </section>;
}
