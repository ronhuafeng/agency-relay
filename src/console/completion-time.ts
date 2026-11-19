/** Completion-time intervals for the request-records page. One bounded aggregate, no raw rows. */
import { listExecutionPlans } from "../plans/execution-plans";
import { parseRequestHistoryQuery, type RequestHistoryQuery } from "./request-history";

const DAY_MS = 86_400_000;
const MAX_WINDOW_MS = 48 * 60 * 60 * 1000;
const RECENT_WINDOW_MS = 24 * 60 * 60 * 1000;
export const COMPLETION_SAMPLE_MINIMUM = 5;

export const COMPLETION_BUCKETS = [
  { id: 0, label: "<200" },
  { id: 1, label: "200–999" },
  { id: 2, label: "1,000–3,999" },
  { id: 3, label: "≥4,000" }
] as const;

export type CompletionBucketId = (typeof COMPLETION_BUCKETS)[number]["id"];

export interface CompletionWindow {
  start: string;
  end: string;
  capped: boolean;
  source: "recent" | "from" | "to" | "range";
}

export interface CompletionBucketPoint {
  id: CompletionBucketId;
  label: string;
  count: number;
  sufficient: boolean;
  p25Ms: number | null;
  p50Ms: number | null;
  p75Ms: number | null;
  p90Ms: number | null;
}

export type CompletionTimeModel =
  | { state: "needs-plan" }
  | { state: "not-applicable"; reason: "result" | "request" }
  | { state: "unavailable" }
  | { state: "ready"; window: CompletionWindow; buckets: readonly CompletionBucketPoint[] };

type Applicability = "ready" | "needs-plan" | "result" | "request";

/** Incompatible filters win over a missing Responses plan, so the page does not imply that choosing a plan would chart them. */
export function completionApplicability(query: Pick<RequestHistoryQuery, "plan" | "result" | "request">): Applicability {
  if (query.result === "error" || query.result === "unknown") return "result";
  if (query.request) return "request";
  const plan = listExecutionPlans().find(item => item.id === query.plan);
  return plan?.usageObserver === "responses" ? "ready" : "needs-plan";
}

/** Selected UTC dates, capped at 48 hours from the end. One date anchors a 48-hour window. No dates use the last 24 UTC hours. */
export function completionWindow(query: Pick<RequestHistoryQuery, "from" | "to">, now: Date): CompletionWindow {
  if (!query.from && !query.to) {
    return { start: new Date(now.getTime() - RECENT_WINDOW_MS).toISOString(), end: now.toISOString(), capped: false, source: "recent" };
  }
  if (query.from && !query.to) {
    const start = Date.parse(`${query.from}T00:00:00.000Z`);
    return { start: new Date(start).toISOString(), end: new Date(start + MAX_WINDOW_MS).toISOString(), capped: false, source: "from" };
  }
  if (!query.from && query.to) {
    const end = Date.parse(`${query.to}T00:00:00.000Z`) + DAY_MS;
    return { start: new Date(end - MAX_WINDOW_MS).toISOString(), end: new Date(end).toISOString(), capped: false, source: "to" };
  }
  const start = Date.parse(`${query.from}T00:00:00.000Z`);
  const end = Date.parse(`${query.to}T00:00:00.000Z`) + DAY_MS;
  if (end - start > MAX_WINDOW_MS) {
    return { start: new Date(end - MAX_WINDOW_MS).toISOString(), end: new Date(end).toISOString(), capped: true, source: "range" };
  }
  return { start: new Date(start).toISOString(), end: new Date(end).toISOString(), capped: false, source: "range" };
}

const aggregate = (userFilter: boolean) => `WITH measured AS (
  SELECT CASE
    WHEN COALESCE(request_audit.output_tokens, 0) + COALESCE(request_audit.reasoning_tokens, 0) < 200 THEN 0
    WHEN COALESCE(request_audit.output_tokens, 0) + COALESCE(request_audit.reasoning_tokens, 0) < 1000 THEN 1
    WHEN COALESCE(request_audit.output_tokens, 0) + COALESCE(request_audit.reasoning_tokens, 0) < 4000 THEN 2
    ELSE 3
  END AS completion_bucket, request_audit.latency_ms AS latency_ms
  FROM request_audit
  LEFT JOIN users ON users.id = request_audit.user_id
  WHERE request_audit.status = 'ok'
    AND request_audit.latency_ms IS NOT NULL
    AND request_audit.latency_ms >= 0
    AND (request_audit.output_tokens IS NOT NULL OR request_audit.reasoning_tokens IS NOT NULL)
    AND COALESCE(request_audit.output_tokens, 0) >= 0
    AND COALESCE(request_audit.reasoning_tokens, 0) >= 0
    AND request_audit.route_profile_id = ?
    AND request_audit.created_at >= ?
    AND request_audit.created_at < ?
    ${userFilter ? "AND (request_audit.user_id = ? OR users.email = ?)" : ""}
), ranked AS (
  SELECT completion_bucket, latency_ms,
    ROW_NUMBER() OVER (PARTITION BY completion_bucket ORDER BY latency_ms) AS rank,
    COUNT(*) OVER (PARTITION BY completion_bucket) AS sample_count
  FROM measured
)
SELECT completion_bucket, sample_count,
  MAX(CASE WHEN rank = ((25 * sample_count + 99) / 100) THEN latency_ms END) AS p25_ms,
  MAX(CASE WHEN rank = ((50 * sample_count + 99) / 100) THEN latency_ms END) AS p50_ms,
  MAX(CASE WHEN rank = ((75 * sample_count + 99) / 100) THEN latency_ms END) AS p75_ms,
  MAX(CASE WHEN rank = ((90 * sample_count + 99) / 100) THEN latency_ms END) AS p90_ms
FROM ranked
GROUP BY completion_bucket, sample_count`;

function safeInteger(value: unknown): number | null {
  if (typeof value === "bigint" && value >= 0n && value <= BigInt(Number.MAX_SAFE_INTEGER)) return Number(value);
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function bucketsFrom(rows: readonly Record<string, unknown>[]): readonly CompletionBucketPoint[] {
  const byId = new Map<number, CompletionBucketPoint>();
  for (const row of rows) {
    const id = safeInteger(row.completion_bucket);
    const count = safeInteger(row.sample_count);
    if (id === null || count === null || id > 3 || byId.has(id) || count < 1) throw new Error("invalid completion aggregate");
    const label = COMPLETION_BUCKETS[id]?.label;
    if (!label) throw new Error("invalid completion aggregate");
    const sufficient = count >= COMPLETION_SAMPLE_MINIMUM;
    const percentile = (field: string) => {
      const value = row[field] === null ? null : safeInteger(row[field]);
      if (!sufficient) return null;
      if (value === null) throw new Error("invalid completion aggregate");
      return value;
    };
    const point: CompletionBucketPoint = {
      id: id as CompletionBucketId, label, count, sufficient,
      p25Ms: percentile("p25_ms"), p50Ms: percentile("p50_ms"), p75Ms: percentile("p75_ms"), p90Ms: percentile("p90_ms")
    };
    if (point.sufficient && !(point.p25Ms! <= point.p50Ms! && point.p50Ms! <= point.p75Ms! && point.p75Ms! <= point.p90Ms!)) {
      throw new Error("invalid completion aggregate");
    }
    byId.set(id, point);
  }
  return COMPLETION_BUCKETS.map(bucket => byId.get(bucket.id) ?? {
    id: bucket.id, label: bucket.label, count: 0, sufficient: false, p25Ms: null, p50Ms: null, p75Ms: null, p90Ms: null
  });
}

export async function readCompletionTime(env: Env, url: URL, now: Date): Promise<CompletionTimeModel> {
  const query = parseRequestHistoryQuery(url);
  const applicability = completionApplicability(query);
  if (applicability === "needs-plan") return { state: "needs-plan" };
  if (applicability !== "ready") return { state: "not-applicable", reason: applicability };
  const window = completionWindow(query, now);
  try {
    const values: unknown[] = [query.plan, window.start, window.end];
    if (query.user) values.push(query.user, query.user);
    const result = await env.DB.prepare(aggregate(query.user !== "")).bind(...values).all<Record<string, unknown>>();
    return { state: "ready", window, buckets: bucketsFrom(result.results ?? []) };
  } catch {
    console.error(JSON.stringify({ event: "completion_time_read_failed" }));
    return { state: "unavailable" };
  }
}
