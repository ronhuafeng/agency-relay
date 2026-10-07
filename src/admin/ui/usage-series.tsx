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
  readonly rows: readonly {readonly day: string; readonly current: boolean; readonly count: number; readonly failure: number; readonly tokens?: number | null; readonly values: readonly string[]}[];
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
      || typeof row.count !== "number" || typeof row.failure !== "number" || row.tokens !== undefined && row.tokens !== null && typeof row.tokens !== "number" || !Array.isArray(row.values) || !row.values.every((cell: unknown) => typeof cell === "string")) return null;
    rows.push({day: row.day, current: row.current, count: row.count, failure: row.failure, tokens: row.tokens, values: row.values});
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
