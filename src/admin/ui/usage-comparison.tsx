import { useState } from "react";
import { Button } from "./components/button";
import { NativeSelect } from "./components/native-select";
import { Label } from "./components/label";
import { InfoPopover } from "./components/info-popover";
import { useEnhanced } from "./use-enhanced";
import { readUsageSeries, type UsageSeriesControl } from "./usage-series";
import { formatNumber } from "../format";

export interface UsageComparisonControl {
  readonly id: string;
  readonly range?: UsageSeriesControl["range"];
  readonly series: readonly UsageSeriesControl[];
}
export function readUsageComparison(value: unknown): UsageComparisonControl | null {
  if (!value || typeof value !== "object" || !("id" in value) || typeof value.id !== "string" || !("series" in value) || !Array.isArray(value.series)) return null;
  const series: UsageSeriesControl[] = [];
  for (const item of value.series) {
    const control = readUsageSeries(item);
    if (!control) return null;
    series.push(control);
  }
  const first = value.series[0];
  const decoded = first && readUsageSeries({...first, range: "range" in value ? value.range : undefined});
  return decoded ? {id: value.id, range: decoded.range, series} : null;
}
type Metric = "count" | "failure" | "tokens" | "starts";
type Layout = "grouped" | "stacked";
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
function SeriesFacts({series}: {readonly series: UsageSeriesControl}) {
  return <><p><code>{series.plan}</code></p><dl className="usage-metrics">{series.metrics.map(metric => <div key={metric.label}><dt>{metric.label}</dt><dd>{metric.value}</dd></div>)}</dl>{series.costHelp ? <p>{series.costHelp}</p> : null}</>;
}

/** Band and stack coordinates belong to the chart; categorical colors come from DTCG. */
export function UsageComparison({control}: {readonly control: UsageComparisonControl}) {
  const enhanced = useEnhanced();
  const responses = control.series.some(series => !series.capability);
  const media = control.series.some(series => series.capability);
  const [metric, setMetric] = useState<Metric>(responses ? "count" : "starts");
  const [layout, setLayout] = useState<Layout>("grouped");
  const [hidden, setHidden] = useState<readonly string[]>([]);
  const days = control.series[0]?.rows ?? [];
  const [day, setDay] = useState(days.at(-1)?.day ?? "");
  const compatible = control.series.filter(series => metric === "starts" ? !!series.capability : !series.capability);
  const visible = compatible.filter(series => !hidden.includes(series.id));
  const colors = new Map(control.series.map((series, index) => [series.id, index % 6 + 1]));
  const dayValues = days.map((_, index) => visible.map(series => valueOf(series.rows[index], metric)));
  const peak = layout === "stacked" ? Math.max(...dayValues.map(values => values.reduce<number>((sum, value) => sum + (value ?? 0), 0))) : Math.max(...dayValues.flat().map(value => value ?? 0));
  const targetStep = Math.max(1, peak / 4);
  const magnitude = 10 ** Math.floor(Math.log10(targetStep));
  const step = magnitude * [1, 2, 5, 10].find(multiple => multiple >= targetStep / magnitude)!;
  const maximum = Math.max(2, Math.ceil(peak / step)) * step;
  const ticks = Array.from({length: maximum / step + 1}, (_, index) => maximum - index * step);
  const band = 600 / days.length;
  const y = (value: number) => 220 - value * 200 / maximum;
  const hasUnknown = dayValues.some(values => values.some(value => value === null));
  return <section className="usage-comparison" aria-label="用量比较">
    <header className="usage-comparison-head">
      <h3>按日用量</h3>
      {control.range ? <nav className="ranges" aria-label="UTC 时间范围"><a href={control.range.href7} data-dashboard-link="" aria-current={control.range.key === "7d" ? "true" : undefined}>7 天</a><a href={control.range.href30} data-dashboard-link="" aria-current={control.range.key === "30d" ? "true" : undefined}>30 天</a></nav> : null}
    </header>
    {enhanced ? <div className="usage-chart-controls">
      <Label>指标<NativeSelect aria-label="比较指标" value={metric} onChange={event => setMetric(event.target.value as Metric)}>{(responses ? ["count", "failure", "tokens"] as const : []).map(key => <option key={key} value={key}>{metricLabels[key]}</option>)}{media ? <option value="starts">{metricLabels.starts}</option> : null}</NativeSelect></Label>
      <Label>布局<NativeSelect aria-label="柱状图布局" value={layout} onChange={event => setLayout(event.target.value as Layout)}><option value="grouped">分组</option><option value="stacked">堆叠</option></NativeSelect></Label>
      <Label>UTC 日期<NativeSelect aria-label="UTC 日期" value={day} onChange={event => setDay(event.target.value)}>{days.map(row => <option key={row.day} value={row.day}>{row.day}{row.current ? " · 未结束" : ""}</option>)}</NativeSelect></Label>
    </div> : <p>{metricLabels[metric]} · 分组</p>}
    <div className="usage-chart-legend" aria-label="显示的服务">{control.series.map(series => <div key={series.id} className="usage-legend-item" data-trend-plan={series.plan} data-trend-capability={series.capability}>
      <Button type="button" variant="ghost" disabled={!enhanced || !compatible.includes(series)} aria-pressed={!hidden.includes(series.id) && compatible.includes(series)} onClick={() => setHidden(hidden.includes(series.id) ? hidden.filter(id => id !== series.id) : [...hidden, series.id])}><svg viewBox="0 0 12 12" className="usage-series-swatch" aria-hidden="true"><rect width="12" height="12" data-series-color={colors.get(series.id)}/></svg>{series.title}</Button>
      <InfoPopover id={`${series.id}-summary`} label={`${series.title} 范围用量`} iconOnly><SeriesFacts series={series}/></InfoPopover>
    </div>)}</div>
    {visible.length ? <div className="usage-chart-frame">
      <div className="usage-chart-y" aria-hidden="true">{ticks.map(tick => <span key={tick}>{formatNumber(tick)}</span>)}</div>
      <div className="usage-chart-body"><svg className="usage-bar-plot" viewBox="0 0 600 240" preserveAspectRatio="none" role="group" aria-label={`${layout === "grouped" ? "分组" : "堆叠"}柱状图 · ${metricLabels[metric]}`}>
        {ticks.map(tick => <path key={tick} className="usage-chart-grid" d={`M0 ${y(tick)} H600`}/>)}
        {days.map((dayRow, dayIndex) => {
          let base = 0;
          return <g key={dayRow.day} data-chart-day={dayRow.day} data-state={day === dayRow.day ? "selected" : undefined}>
            <rect aria-hidden="true" className="usage-day-hit" x={dayIndex * band} y="20" width={band} height="200" onPointerEnter={() => setDay(dayRow.day)} onClick={() => setDay(dayRow.day)}/>
            {visible.map((series, seriesIndex) => {
              const row = series.rows[dayIndex];
              const value = valueOf(row, metric);
              const top = layout === "stacked" ? base + (value ?? 0) : value ?? 0;
              const bottom = layout === "stacked" ? base : 0;
              base = top;
              const barWidth = band * .8 / (layout === "grouped" ? visible.length : 1);
              const left = dayIndex * band + band * .1 + (layout === "grouped" ? seriesIndex * barWidth : 0);
              return <g key={series.id} data-chart-series={series.id} data-daily-plan={series.plan} data-daily-capability={series.capability}>
                {value === null ? <text className="usage-unknown-mark" x={left + barWidth / 2} y="213" textAnchor="middle">?</text> : <rect className="usage-chart-bar" data-series-color={colors.get(series.id)} x={left} y={y(top)} width={Math.max(.5, barWidth - 1)} height={y(bottom) - y(top)} tabIndex={0} role="img" aria-label={pointLabel(series, row, metric)} onPointerEnter={() => setDay(row.day)} onFocus={() => setDay(row.day)} onClick={() => setDay(row.day)}><title>{pointLabel(series, row, metric)}</title></rect>}
              </g>;
            })}
          </g>;
        })}
      </svg><div className="usage-chart-x" aria-hidden="true">{days.map((row, index) => <span key={row.day}><span>{index === 0 || index === days.length - 1 || index % Math.ceil(days.length / 3) === 0 ? row.day.slice(5) : ""}</span></span>)}</div></div>
    </div> : <p role="status">没有选中的可比较服务。</p>}
    <div className="usage-trend-endpoints"><span>{days[0]?.day} UTC</span><span>{days.at(-1)?.day}{days.at(-1)?.current ? " · 未结束" : ""}</span></div>
    {hasUnknown ? <p className="caption">? 表示未记录；柱高只含已记录的值。</p> : null}
    <div className="usage-day-values" aria-live="polite"><strong>{day} UTC{days.find(row => row.day === day)?.current ? " · 未结束" : ""}</strong>{visible.map(series => {const row = series.rows.find(item => item.day === day)!; return <span key={series.id}>{series.title}：{valueOf(row, metric) === null ? "未记录" : formatNumber(valueOf(row, metric)!)}{metric === "tokens" ? ` · ${row.values[2]?.split(" · ")[1] ?? ""}` : ""}</span>;})}</div>
    <details className="usage-chart-description"><summary>图表数据与口径</summary><p>请求和响应失败使用 Responses 记录；媒体开始单独比较。金额来源与覆盖在各服务的范围用量中。当前 UTC 日尚未结束。</p><div className="usage-chart-text">{control.series.map(series => <section key={series.id} data-text-plan={series.plan} data-text-capability={series.capability}><h4>{series.title}</h4><dl>{series.rows.map(row => <div key={row.day}><dt>{dayLabel(row)}</dt><dd>{series.columns.map((column, index) => `${column}：${row.values[index]}`).join("；")}</dd></div>)}</dl></section>)}</div></details>
  </section>;
}
