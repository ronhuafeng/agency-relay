import { useState } from "react";
import { ChevronDown } from "lucide-react";
import { Button } from "./components/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "./components/collapsible";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "./components/table";
import { useEnhanced } from "./use-enhanced";

/** Only formatted, authorized ledger facts cross this presentation boundary. */
export interface UsageSeriesControl {
  readonly id: string;
  readonly plan: string;
  readonly capability?: string;
  readonly title: string;
  readonly costHelp?: string;
  readonly range?: {readonly key: "7d" | "30d"; readonly href7: string; readonly href30: string};
  readonly metrics: readonly {readonly label: string; readonly value: string}[];
  readonly columns: readonly string[];
  readonly rows: readonly {readonly day: string; readonly current: boolean; readonly count: number; readonly values: readonly string[]}[];
}
export function readUsageSeries(value: unknown): UsageSeriesControl | null {
  if (!value || typeof value !== "object" || !("id" in value) || typeof value.id !== "string"
    || !("plan" in value) || typeof value.plan !== "string" || !("title" in value) || typeof value.title !== "string"
    || ("capability" in value && typeof value.capability !== "string")
    || !("metrics" in value) || !Array.isArray(value.metrics) || !("columns" in value) || !Array.isArray(value.columns)
    || !value.columns.every(column => typeof column === "string") || !("rows" in value) || !Array.isArray(value.rows)) return null;
  const metrics: {label: string; value: string}[] = [];
  for (const metric of value.metrics) {
    if (!metric || typeof metric !== "object" || typeof metric.label !== "string" || typeof metric.value !== "string") return null;
    metrics.push({label: metric.label, value: metric.value});
  }
  const rows: UsageSeriesControl["rows"][number][] = [];
  for (const row of value.rows) {
    if (!row || typeof row !== "object" || typeof row.day !== "string" || typeof row.current !== "boolean"
      || typeof row.count !== "number" || !Array.isArray(row.values) || !row.values.every((cell: unknown) => typeof cell === "string")) return null;
    rows.push({day: row.day, current: row.current, count: row.count, values: row.values});
  }
  let range: UsageSeriesControl["range"];
  if ("range" in value && value.range !== undefined) {
    const item = value.range;
    if (!item || typeof item !== "object" || !("key" in item) || (item.key !== "7d" && item.key !== "30d")
      || !("href7" in item) || typeof item.href7 !== "string" || !("href30" in item) || typeof item.href30 !== "string") return null;
    range = {key: item.key, href7: item.href7, href30: item.href30};
  }
  if ("costHelp" in value && value.costHelp !== undefined && typeof value.costHelp !== "string") return null;
  return {id: value.id, plan: value.plan, title: value.title, costHelp: "costHelp" in value ? value.costHelp as string : undefined, capability: "capability" in value ? value.capability as string : undefined, range, metrics, columns: value.columns, rows};
}

export function UsageSeriesView({control}: {readonly control: UsageSeriesControl}) {
  const enhanced = useEnhanced();
  const [open, setOpen] = useState(false);
  const maximum = Math.max(1, ...control.rows.map(row => row.count));
  const width = 600 / control.rows.length;
  return <Collapsible open={!enhanced || open} onOpenChange={setOpen} asChild>
    <section className="usage-trend-series" data-trend-plan={control.plan} data-trend-capability={control.capability}>
      <header className="usage-series-head"><h3>{control.title}</h3>{control.range ? <nav className="ranges" aria-label="UTC 时间范围"><a href={control.range.href7} data-dashboard-link="" aria-current={control.range.key === "7d" ? "true" : undefined}>7 天</a><a href={control.range.href30} data-dashboard-link="" aria-current={control.range.key === "30d" ? "true" : undefined}>30 天</a></nav> : null}</header>
      <div className="usage-summary-line">
        <dl className="usage-metrics">{control.metrics.map(metric => {
          const [value, coverage] = metric.value.split(" · ");
          return <div key={metric.label}><dt>{metric.label}</dt><dd><strong>{value}</strong>{coverage ? <span className="usage-metric-coverage"><span className="sr-only"> · </span>{coverage}</span> : null}</dd></div>;
        })}</dl>
        {enhanced ? <CollapsibleTrigger asChild><Button variant="ghost" className="usage-data-trigger" aria-label={`${control.title} 按日数据`}>按日数据<ChevronDown className="ui-icon" aria-hidden="true"/></Button></CollapsibleTrigger> : null}
      </div>
      {control.costHelp ? <p className="muted">{control.costHelp}</p> : null}
      <div className="usage-trend-plot">
        <svg viewBox="0 0 600 100" preserveAspectRatio="none" aria-hidden="true" focusable="false">
          <path d="M0 99.5 H600" className="usage-trend-baseline"/>
          {control.rows.map((row, index) => <rect key={row.day} x={index * width + 2} y={99 - 95 * row.count / maximum} width={Math.max(1, width - 4)} height={95 * row.count / maximum}/>)}
        </svg>
        <div className="usage-trend-endpoints"><span>{control.rows[0]?.day} UTC</span><span>{control.rows.at(-1)?.day}{control.rows.at(-1)?.current ? " · 未结束" : ""}</span></div>
      </div>
      <CollapsibleContent forceMount hidden={enhanced && !open} className="usage-trend-data">
        <Table scrollLabel={`${control.title} 按日数据`}>
          <caption className="sr-only">按日数据 · UTC</caption>
          <TableHeader><TableRow><TableHead scope="col">UTC 日期</TableHead>{control.columns.map(column => <TableHead key={column} scope="col">{column}</TableHead>)}</TableRow></TableHeader>
          <TableBody>{control.rows.map(row => <TableRow key={row.day}><TableHead scope="row">{row.day}{row.current ? " · 未结束" : ""}</TableHead>{row.values.map((cell, index) => <TableCell key={index}>{cell}</TableCell>)}</TableRow>)}</TableBody>
        </Table>
      </CollapsibleContent>
    </section>
  </Collapsible>;
}
