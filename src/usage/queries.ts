import { d1ChangeCount, nonNegativeIntegerOrZero, stringOrNull } from "../records";
import type { UsageSummaryTotals, UsageSummaryRow, MediaUsageSummaryTotals, MediaUsageSummaryRow, MediaUsageSummaryResult, UsageSummaryResult, MediaUsageDailyPoint, UsageDailyResult } from "./types";
import type { UsageDailyPoint } from "./types";
import { HttpError } from "../errors";
import { REAL_TASK_EXECUTION_PLAN_IDS } from "../plans/execution-plans";

interface UsageRangeQuery {
  mode: "all" | "day" | "range";
  day?: string | null;
  from?: string | null;
  to?: string | null;
  q?: string | null;
}

interface UsageSummaryQuery extends UsageRangeQuery {
  user_id?: string | null;
  route_profile_id?: string | null;
  response_model?: string | null;
  limit: number;
}

interface MediaUsageSummaryQuery extends UsageRangeQuery {
  user_id?: string | null;
  route_profile_id?: string | null;
  limit: number;
}

export function requestAuditRetentionDays(raw: string): number {
  const invalid = new HttpError(500, "REQUEST_AUDIT_RETENTION_DAYS must be an integer from 1 to 3650", "server_error", "invalid_request_audit_retention_days");
  if (!/^[1-9]\d*$/.test(raw)) throw invalid;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed > 3650) throw invalid;
  return parsed;
}

export async function cleanupRequestAudit(env: Env, cutoffIso: string): Promise<number> {
  const result = await env.DB.prepare("DELETE FROM request_audit WHERE created_at < ?").bind(cutoffIso).run();
  return d1ChangeCount(result);
}

export async function queryUsageSummary(
  env: Env,
  input: UsageSummaryQuery
): Promise<UsageSummaryResult> {
  const { where, bindings } = usageSummaryWhere(input);
  // Totals and rows are independent aggregates over the same scope.
  const [totalsRow, rows] = await Promise.all([env.DB.prepare(
    `SELECT
       COALESCE(SUM(ud.requests), 0) AS requests,
       COALESCE(SUM(ud.ok_requests), 0) AS ok_requests,
       COALESCE(SUM(ud.error_requests), 0) AS error_requests,
       COALESCE(SUM(ud.input_tokens), 0) AS input_tokens,
       COALESCE(SUM(ud.cached_input_tokens), 0) AS cached_input_tokens,
       COALESCE(SUM(ud.output_tokens), 0) AS output_tokens,
       COALESCE(SUM(ud.reasoning_tokens), 0) AS reasoning_tokens,
       COALESCE(SUM(ud.total_tokens), 0) AS total_tokens,
       COALESCE(SUM(ud.token_measurements), 0) AS token_measurements,
       COALESCE(SUM(ud.provider_cost_usd_ticks), 0) AS provider_cost_usd_ticks,
       COALESCE(SUM(ud.cost_measurements), 0) AS cost_measurements,
       COALESCE(SUM(ud.api_equivalent_usd_ticks), 0) AS api_equivalent_usd_ticks,
       COALESCE(SUM(ud.api_equivalent_measurements), 0) AS api_equivalent_measurements,
       COUNT(DISTINCT ud.user_id) AS users_with_usage,
       MAX(ud.last_seen_at) AS latest_usage_at
     FROM usage_daily AS ud
     ${where}`
  ).bind(...bindings).first<UsageSummaryTotalsRow>(), queryUsageSummaryRows(env, where, bindings, input.limit)]);

  return {
    totals: normalizeUsageTotals(totalsRow),
    rows,
    usersWithUsage: nonNegativeIntegerOrZero(totalsRow?.users_with_usage),
    latestUsageAt: stringOrNull(totalsRow?.latest_usage_at)
  };
}

export async function queryMediaUsageSummary(
  env: Env,
  input: MediaUsageSummaryQuery
): Promise<MediaUsageSummaryResult> {
  const { where, bindings } = mediaUsageSummaryWhere(input);
  const [totalsRow, rowsResult] = await Promise.all([env.DB.prepare(
    `SELECT
       COALESCE(SUM(mu.started_jobs), 0) AS started_jobs,
       COALESCE(SUM(mu.completed_jobs), 0) AS completed_jobs,
       COALESCE(SUM(mu.failed_jobs), 0) AS failed_jobs,
       COALESCE(SUM(mu.expired_jobs), 0) AS expired_jobs,
       COALESCE(SUM(mu.outputs), 0) AS outputs,
       COALESCE(SUM(mu.video_seconds), 0) AS video_seconds,
       COALESCE(SUM(mu.output_measurements), 0) AS output_measurements,
       COALESCE(SUM(mu.duration_measurements), 0) AS duration_measurements,
       COALESCE(SUM(mu.provider_cost_usd_ticks), 0) AS provider_cost_usd_ticks,
       COALESCE(SUM(mu.cost_measurements), 0) AS cost_measurements
     FROM media_usage_daily AS mu
     ${where}`
  ).bind(...bindings).first<MediaUsageSummaryTotals>(), env.DB.prepare(
    `SELECT
       MIN(mu.day) AS first_day,
       MAX(mu.day) AS last_day,
       mu.user_id AS user_id,
       users.email AS email,
       mu.route_profile_id AS route_profile_id,
       mu.capability AS capability,
       SUM(mu.started_jobs) AS started_jobs,
       SUM(mu.completed_jobs) AS completed_jobs,
       SUM(mu.failed_jobs) AS failed_jobs,
       SUM(mu.expired_jobs) AS expired_jobs,
       SUM(mu.outputs) AS outputs,
       SUM(mu.video_seconds) AS video_seconds,
       SUM(mu.output_measurements) AS output_measurements,
       SUM(mu.duration_measurements) AS duration_measurements,
       SUM(mu.provider_cost_usd_ticks) AS provider_cost_usd_ticks,
       SUM(mu.cost_measurements) AS cost_measurements,
       MAX(mu.last_seen_at) AS last_seen_at
     FROM media_usage_daily AS mu
     LEFT JOIN users ON users.id = mu.user_id
     ${where}
     GROUP BY mu.user_id, users.email, mu.route_profile_id, mu.capability
     ORDER BY provider_cost_usd_ticks DESC, started_jobs DESC
     LIMIT ?`
  ).bind(...bindings, input.limit).all<MediaUsageSummaryRow>()]);
  return {
    totals: normalizeMediaUsageTotals(totalsRow),
    rows: rowsResult.results ?? []
  };
}

/** Full-ledger SQL aggregation, independent of the bounded detail/export rows.
 * Only finite ranges reach this seam. Model applies only to Responses, as in summary/export.
 */
export async function queryUsageDaily(env: Env, input: UsageSummaryQuery): Promise<UsageDailyResult> {
  const from = input.mode === "day" ? input.day : input.from;
  const to = input.mode === "day" ? input.day : input.to;
  if (input.mode === "all" || !from || !to || !Number.isFinite(Date.parse(from)) || !Number.isFinite(Date.parse(to))
    || from > to || (Date.parse(to) - Date.parse(from)) / 86_400_000 >= 30) throw new Error("Daily usage requires a finite range of at most 30 UTC days");
  const responseFilter = usageSummaryWhere(input);
  const mediaFilter = mediaUsageSummaryWhere(input);
  const [responses, media] = await Promise.all([
    env.DB.prepare(`SELECT ud.day, ud.route_profile_id,
      SUM(ud.requests) AS requests, SUM(ud.ok_requests) AS ok_requests, SUM(ud.error_requests) AS error_requests,
      SUM(ud.input_tokens) AS input_tokens, SUM(ud.cached_input_tokens) AS cached_input_tokens,
      SUM(ud.output_tokens) AS output_tokens, SUM(ud.reasoning_tokens) AS reasoning_tokens,
      SUM(ud.total_tokens) AS total_tokens, SUM(ud.token_measurements) AS token_measurements,
      SUM(ud.provider_cost_usd_ticks) AS provider_cost_usd_ticks, SUM(ud.cost_measurements) AS cost_measurements,
      SUM(ud.api_equivalent_usd_ticks) AS api_equivalent_usd_ticks,
      SUM(ud.api_equivalent_measurements) AS api_equivalent_measurements
      FROM usage_daily AS ud ${responseFilter.where}
      GROUP BY ud.day, ud.route_profile_id ORDER BY ud.route_profile_id, ud.day`)
      .bind(...responseFilter.bindings).all<UsageDailyPoint>(),
    env.DB.prepare(`SELECT mu.day, mu.route_profile_id, mu.capability,
      SUM(mu.started_jobs) AS started_jobs, SUM(mu.completed_jobs) AS completed_jobs,
      SUM(mu.failed_jobs) AS failed_jobs, SUM(mu.expired_jobs) AS expired_jobs,
      SUM(mu.outputs) AS outputs, SUM(mu.video_seconds) AS video_seconds,
      SUM(mu.output_measurements) AS output_measurements, SUM(mu.duration_measurements) AS duration_measurements,
      SUM(mu.provider_cost_usd_ticks) AS provider_cost_usd_ticks, SUM(mu.cost_measurements) AS cost_measurements
      FROM media_usage_daily AS mu ${mediaFilter.where}
      GROUP BY mu.day, mu.route_profile_id, mu.capability ORDER BY mu.route_profile_id, mu.capability, mu.day`)
      .bind(...mediaFilter.bindings).all<MediaUsageDailyPoint>()
  ]);
  return { responses: responses.results ?? [], media: media.results ?? [] };
}

export interface RequestAttemptStateRow {
  route_profile_id: string;
  request_count: number;
  ok_count: number;
  error_count: number;
  last_success_at: string | null;
  last_failure_at: string | null;
  avg_latency_ms: number | null;
  upstream_status_sample: string | null;
}

export interface KeyClientVerificationRow {
  user_id: string;
  key_id: string;
  route_profile_id: string;
  last_success_at: string | null;
  last_failure_at: string | null;
}

/** Task-related request observations for an exact key; ok does not establish terminal task completion. */
export async function queryClientVerification(env: Env, keyIds?: readonly string[], userId?: string): Promise<KeyClientVerificationRow[]> {
  const result = await env.DB.prepare(
    `SELECT user_id, key_id, route_profile_id,
       MAX(CASE WHEN status = 'ok' THEN created_at END) AS last_success_at,
       MAX(CASE WHEN status = 'error' THEN created_at END) AS last_failure_at
     FROM request_audit
     WHERE key_id IS NOT NULL
       AND route_profile_id IN (${REAL_TASK_EXECUTION_PLAN_IDS.map(() => "?").join(", ")})
       ${keyIds ? `AND key_id IN (${keyIds.length ? keyIds.map(() => "?").join(",") : "NULL"})` : ""}
       ${userId ? "AND user_id = ? AND EXISTS (SELECT 1 FROM api_keys AS own WHERE own.id = request_audit.key_id AND own.user_id = ?)" : ""}
     GROUP BY user_id, key_id, route_profile_id`
  ).bind(...REAL_TASK_EXECUTION_PLAN_IDS, ...(keyIds ?? []), ...(userId ? [userId, userId] : [])).all<KeyClientVerificationRow>();
  return result.results ?? [];
}

export async function queryRequestAttemptState(env: Env): Promise<RequestAttemptStateRow[]> {
  const result = await env.DB.prepare(
    `SELECT
       route_profile_id AS route_profile_id,
       COUNT(*) AS request_count,
       SUM(CASE WHEN status = 'ok' THEN 1 ELSE 0 END) AS ok_count,
       SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS error_count,
       MAX(CASE WHEN status = 'ok' THEN created_at END) AS last_success_at,
       MAX(CASE WHEN status = 'error' THEN created_at END) AS last_failure_at,
       AVG(latency_ms) AS avg_latency_ms,
       GROUP_CONCAT(DISTINCT upstream_status) AS upstream_status_sample
     FROM request_audit
     GROUP BY route_profile_id
     ORDER BY route_profile_id ASC`
  ).all<RequestAttemptStateRow>();
  return (result.results ?? []).map((row) => ({
    route_profile_id: String(row.route_profile_id ?? ""),
    request_count: nonNegativeIntegerOrZero(row.request_count),
    ok_count: nonNegativeIntegerOrZero(row.ok_count),
    error_count: nonNegativeIntegerOrZero(row.error_count),
    last_success_at: stringOrNull(row.last_success_at),
    last_failure_at: stringOrNull(row.last_failure_at),
    avg_latency_ms: row.avg_latency_ms === null || row.avg_latency_ms === undefined
      ? null
      : Number(row.avg_latency_ms),
    upstream_status_sample: stringOrNull(row.upstream_status_sample)
  }));
}

async function queryUsageSummaryRows(
  env: Env,
  where: string,
  bindings: unknown[],
  limit: number
): Promise<UsageSummaryRow[]> {
  const rowsResult = await env.DB.prepare(
    `SELECT
       MIN(ud.day) AS first_day,
       MAX(ud.day) AS last_day,
       ud.user_id AS user_id,
       users.email AS email,
       ud.route_profile_id AS route_profile_id,
       ud.response_model AS response_model,
       SUM(ud.requests) AS requests,
       SUM(ud.ok_requests) AS ok_requests,
       SUM(ud.error_requests) AS error_requests,
       SUM(ud.input_tokens) AS input_tokens,
       SUM(ud.cached_input_tokens) AS cached_input_tokens,
       SUM(ud.output_tokens) AS output_tokens,
       SUM(ud.reasoning_tokens) AS reasoning_tokens,
       SUM(ud.total_tokens) AS total_tokens,
       SUM(ud.token_measurements) AS token_measurements,
       SUM(ud.provider_cost_usd_ticks) AS provider_cost_usd_ticks,
       SUM(ud.cost_measurements) AS cost_measurements,
       SUM(ud.api_equivalent_usd_ticks) AS api_equivalent_usd_ticks,
       SUM(ud.api_equivalent_measurements) AS api_equivalent_measurements,
       MAX(ud.last_seen_at) AS last_seen_at
     FROM usage_daily AS ud
     LEFT JOIN users ON users.id = ud.user_id
     ${where}
     GROUP BY ud.user_id, users.email, ud.route_profile_id, ud.response_model
     ORDER BY total_tokens DESC, requests DESC
     LIMIT ?`
  ).bind(...bindings, limit).all<UsageSummaryRow>();
  return rowsResult.results ?? [];
}

function appendUsageScope(
  alias: "ud" | "mu",
  input: UsageRangeQuery & { user_id?: string | null; route_profile_id?: string | null },
  conditions: string[],
  bindings: unknown[]
): void {
  if (input.mode === "day") {
    conditions.push(`${alias}.day = ?`);
    bindings.push(input.day);
  } else if (input.mode === "range") {
    conditions.push(`${alias}.day >= ?`, `${alias}.day <= ?`);
    bindings.push(input.from, input.to);
  }
  if (input.user_id) {
    conditions.push(`${alias}.user_id = ?`);
    bindings.push(input.user_id);
  }
  if (input.route_profile_id) {
    conditions.push(`${alias}.route_profile_id = ?`);
    bindings.push(input.route_profile_id);
  }
}

function usageSummaryWhere(input: UsageRangeQuery & {
  user_id?: string | null;
  route_profile_id?: string | null;
  response_model?: string | null;
}): { where: string; bindings: unknown[] } {
  const conditions: string[] = [];
  const bindings: unknown[] = [];
  appendUsageScope("ud", input, conditions, bindings);
  if (input.response_model) {
    conditions.push("ud.response_model = ?");
    bindings.push(input.response_model);
  }
  if (input.q) {
    conditions.push(usageSearchWhere("ud", true));
    bindings.push(input.q, input.q, input.q, input.q);
  }
  return {
    where: conditions.length ? `WHERE ${conditions.join(" AND ")}` : "",
    bindings
  };
}

function moneyOrZero(value: number | null | undefined): number {
  if (value == null) return 0;
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError("Usage amount exceeds exact integer range");
  return value;
}

function normalizeUsageTotals(row: UsageSummaryTotals | null): UsageSummaryTotals {
  return {
    requests: nonNegativeIntegerOrZero(row?.requests),
    ok_requests: nonNegativeIntegerOrZero(row?.ok_requests),
    error_requests: nonNegativeIntegerOrZero(row?.error_requests),
    input_tokens: nonNegativeIntegerOrZero(row?.input_tokens),
    cached_input_tokens: nonNegativeIntegerOrZero(row?.cached_input_tokens),
    output_tokens: nonNegativeIntegerOrZero(row?.output_tokens),
    reasoning_tokens: nonNegativeIntegerOrZero(row?.reasoning_tokens),
    total_tokens: nonNegativeIntegerOrZero(row?.total_tokens),
    token_measurements: nonNegativeIntegerOrZero(row?.token_measurements),
    provider_cost_usd_ticks: moneyOrZero(row?.provider_cost_usd_ticks),
    cost_measurements: nonNegativeIntegerOrZero(row?.cost_measurements),
    api_equivalent_usd_ticks: moneyOrZero(row?.api_equivalent_usd_ticks),
    api_equivalent_measurements: nonNegativeIntegerOrZero(row?.api_equivalent_measurements)
  };
}

function mediaUsageSummaryWhere(input: MediaUsageSummaryQuery): { where: string; bindings: unknown[] } {
  const conditions: string[] = [];
  const bindings: unknown[] = [];
  appendUsageScope("mu", input, conditions, bindings);
  if (input.q) {
    conditions.push(usageSearchWhere("mu", false));
    bindings.push(input.q, input.q, input.q);
  }
  return {
    where: conditions.length ? `WHERE ${conditions.join(" AND ")}` : "",
    bindings
  };
}

function usageSearchWhere(alias: "ud" | "mu", model: boolean): string {
  return `(${model ? `instr(lower(${alias}.response_model), lower(?)) > 0 OR ` : ""}
    instr(lower(${alias}.user_id), lower(?)) > 0 OR
    ${alias}.user_id IN (SELECT id FROM users WHERE
      instr(lower(COALESCE(email, '')), lower(?)) > 0 OR
      instr(lower(COALESCE(display_name, '')), lower(?)) > 0))`;
}

function normalizeMediaUsageTotals(row: MediaUsageSummaryTotals | null): MediaUsageSummaryTotals {
  return {
    started_jobs: nonNegativeIntegerOrZero(row?.started_jobs),
    completed_jobs: nonNegativeIntegerOrZero(row?.completed_jobs),
    failed_jobs: nonNegativeIntegerOrZero(row?.failed_jobs),
    expired_jobs: nonNegativeIntegerOrZero(row?.expired_jobs),
    outputs: nonNegativeIntegerOrZero(row?.outputs),
    video_seconds: nonNegativeNumberOrZero(row?.video_seconds),
    output_measurements: nonNegativeIntegerOrZero(row?.output_measurements),
    duration_measurements: nonNegativeIntegerOrZero(row?.duration_measurements),
    provider_cost_usd_ticks: moneyOrZero(row?.provider_cost_usd_ticks),
    cost_measurements: nonNegativeIntegerOrZero(row?.cost_measurements)
  };
}

interface UsageSummaryTotalsRow extends UsageSummaryTotals {
  users_with_usage: number;
  latest_usage_at: string | null;
}

function nonNegativeNumberOrZero(value: number | null | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}
