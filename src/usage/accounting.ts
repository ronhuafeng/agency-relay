import { nonNegativeIntegerOrZero, utcDay } from "../records";
import type { CapturedProviderUsage, CapturedResponseUsage } from "./types";
import { nowIso } from "../crypto";
import { executionPlanPresentation } from "../plans/execution-plans";
import type { UsageObserver } from "../plans/execution-plans";
import { apiEquivalentValue } from "./api-value";

interface RequestAuditSubject {
  request_id?: string | null;
  route_profile_id: string;
  route?: string | null;
  user_id: string;
  key_id?: string | null;
  codex_auth_id?: string | null;
  upstream_status?: number | null;
  error_code?: string | null;
  session_id?: string | null;
  thread_id?: string | null;
  latency_ms?: number | null;
}

/** Current execution snapshot columns retained in request_audit. */
export interface RouteDecisionAuditFields {
  ingress_profile_id?: string | null;
  ingress_protocol?: string | null;
  resolved_model?: string | null;
  capability_source?: string | null;
  subscription_account_id?: string | null;
  egress_profile_id?: string | null;
}

function prepareAuditInsert(
  env: Env,
  input: RequestAuditSubject & {
    id: string;
    response_model?: string | null;
    status: string;
    response_id?: string | null;
    usage?: CapturedProviderUsage | null;
    apiValue?: { ticks: number; version: string } | null;
  } & RouteDecisionAuditFields,
  now: Date
): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT INTO request_audit
     (id, request_id, route_profile_id, route, user_id, key_id, codex_auth_id, response_model, status, upstream_status, error_code, session_id, thread_id, latency_ms,
      response_id, input_tokens, cached_input_tokens, output_tokens, reasoning_tokens, total_tokens,
      provider_cost_usd_ticks, created_at,
      ingress_profile_id, ingress_protocol, resolved_model, capability_source, subscription_account_id,
      egress_profile_id, cache_write_input_tokens, api_equivalent_usd_ticks, api_price_version)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    input.id,
    input.request_id ?? null,
    input.route_profile_id,
    input.route ?? null,
    input.user_id,
    input.key_id ?? null,
    input.codex_auth_id ?? null,
    modelIdOrNA(input.response_model),
    input.status,
    input.upstream_status ?? null,
    input.error_code ?? null,
    input.session_id ?? null,
    input.thread_id ?? null,
    input.latency_ms ?? null,
    input.response_id ?? null,
    input.usage?.input_tokens ?? null,
    input.usage?.cached_input_tokens ?? null,
    input.usage?.output_tokens ?? null,
    input.usage?.reasoning_tokens ?? null,
    input.usage?.total_tokens ?? null,
    input.usage?.provider_cost_usd_ticks ?? null,
    nowIso(now),
    input.ingress_profile_id ?? null,
    input.ingress_protocol ?? null,
    input.resolved_model ?? null,
    input.capability_source ?? null,
    input.subscription_account_id ?? null,
    input.egress_profile_id ?? null,
    input.usage?.cache_write_input_tokens ?? null,
    input.apiValue?.ticks ?? null,
    input.apiValue?.version ?? null
  );
}

function prepareUsageDailyUpsert(
  env: Env,
  input: {
    user_id: string;
    route_profile_id: string;
    response_model?: string | null;
    requests: number;
    ok_requests: number;
    error_requests: number;
    input_tokens: number;
    cached_input_tokens: number;
    output_tokens: number;
    reasoning_tokens: number;
    total_tokens: number;
    token_measurements: number;
    provider_cost_usd_ticks: number;
    cost_measurements: number;
    api_equivalent_usd_ticks: number;
    api_equivalent_measurements: number;
  },
  now = new Date()
): D1PreparedStatement {
  const responseModel = modelIdOrNA(input.response_model);
  const seenAt = nowIso(now);
  const day = utcDay(now);

  return env.DB.prepare(
    `INSERT INTO usage_daily
     (user_id, day, route_profile_id, response_model, requests, ok_requests,
      error_requests, input_tokens, cached_input_tokens, output_tokens,
      reasoning_tokens, total_tokens, token_measurements,
      provider_cost_usd_ticks, cost_measurements, first_seen_at, last_seen_at,
      api_equivalent_usd_ticks, api_equivalent_measurements)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id, day, route_profile_id, response_model) DO UPDATE SET
       requests = usage_daily.requests + excluded.requests,
       ok_requests = usage_daily.ok_requests + excluded.ok_requests,
       error_requests = usage_daily.error_requests + excluded.error_requests,
       input_tokens = usage_daily.input_tokens + excluded.input_tokens,
       cached_input_tokens = usage_daily.cached_input_tokens + excluded.cached_input_tokens,
       output_tokens = usage_daily.output_tokens + excluded.output_tokens,
       reasoning_tokens = usage_daily.reasoning_tokens + excluded.reasoning_tokens,
       total_tokens = usage_daily.total_tokens + excluded.total_tokens,
       token_measurements = usage_daily.token_measurements + excluded.token_measurements,
       provider_cost_usd_ticks = usage_daily.provider_cost_usd_ticks + excluded.provider_cost_usd_ticks,
       cost_measurements = usage_daily.cost_measurements + excluded.cost_measurements,
       api_equivalent_usd_ticks = usage_daily.api_equivalent_usd_ticks + excluded.api_equivalent_usd_ticks,
       api_equivalent_measurements = usage_daily.api_equivalent_measurements + excluded.api_equivalent_measurements,
       first_seen_at = CASE
         WHEN usage_daily.first_seen_at IS NULL OR excluded.first_seen_at < usage_daily.first_seen_at
           THEN excluded.first_seen_at
         ELSE usage_daily.first_seen_at
       END,
       last_seen_at = MAX(usage_daily.last_seen_at, excluded.last_seen_at)`
  ).bind(
    input.user_id,
    day,
    input.route_profile_id,
    responseModel,
    input.requests,
    input.ok_requests,
    input.error_requests,
    input.input_tokens,
    input.cached_input_tokens,
    input.output_tokens,
    input.reasoning_tokens,
    input.total_tokens,
    input.token_measurements,
    input.provider_cost_usd_ticks,
    input.cost_measurements,
    seenAt,
    seenAt,
    input.api_equivalent_usd_ticks,
    input.api_equivalent_measurements
  );
}

/** Atomic final commit for one completed Provider Attempt. */
export async function commitProviderAttemptAccounting(
  env: Env,
  input: RequestAuditSubject & {
    audit_id: string;
    status: "ok" | "error";
    usage_observer: UsageObserver;
    usage_capture: CapturedResponseUsage | null;
  } & RouteDecisionAuditFields,
  now = new Date()
): Promise<void> {
  if (input.usage_observer !== "responses" && input.usage_capture !== null) {
    throw new Error(`Execution Plan ${input.route_profile_id} cannot commit Responses usage`);
  }

  const usage = input.usage_capture?.usage;
  const apiValue = input.usage_observer === "responses"
    && executionPlanPresentation(input.route_profile_id).costBasis === "openai_standard"
    ? apiEquivalentValue(input.usage_capture) : null;
  const statements: D1PreparedStatement[] = [prepareAuditInsert(env, {
    id: input.audit_id,
    request_id: input.request_id,
    route_profile_id: input.route_profile_id,
    route: input.route,
    user_id: input.user_id,
    key_id: input.key_id,
    codex_auth_id: input.codex_auth_id,
    response_model: input.usage_capture?.model,
    status: input.status,
    upstream_status: input.upstream_status,
    error_code: input.error_code,
    session_id: input.session_id,
    thread_id: input.thread_id,
    latency_ms: input.latency_ms,
    response_id: input.usage_capture?.response_id,
    usage,
    apiValue,
    ingress_profile_id: input.ingress_profile_id,
    ingress_protocol: input.ingress_protocol,
    resolved_model: input.resolved_model,
    capability_source: input.capability_source,
    subscription_account_id: input.subscription_account_id,
    egress_profile_id: input.egress_profile_id
  }, now)];

  if (input.usage_observer === "responses") {
    statements.push(prepareUsageDailyUpsert(env, {
      user_id: input.user_id,
      route_profile_id: input.route_profile_id,
      response_model: input.usage_capture?.model,
      requests: 1,
      ok_requests: input.status === "ok" ? 1 : 0,
      error_requests: input.status === "error" ? 1 : 0,
      input_tokens: nonNegativeIntegerOrZero(usage?.input_tokens),
      cached_input_tokens: nonNegativeIntegerOrZero(usage?.cached_input_tokens),
      output_tokens: nonNegativeIntegerOrZero(usage?.output_tokens),
      reasoning_tokens: nonNegativeIntegerOrZero(usage?.reasoning_tokens),
      total_tokens: nonNegativeIntegerOrZero(usage?.total_tokens),
      token_measurements: hasTokenMeasurement(usage) ? 1 : 0,
      provider_cost_usd_ticks: nonNegativeIntegerOrZero(usage?.provider_cost_usd_ticks),
      cost_measurements: usage?.provider_cost_usd_ticks !== null
        && usage?.provider_cost_usd_ticks !== undefined ? 1 : 0,
      api_equivalent_usd_ticks: apiValue?.ticks ?? 0,
      api_equivalent_measurements: apiValue ? 1 : 0
    }, now));
  }

  await env.DB.batch(statements);
}

function hasTokenMeasurement(usage: CapturedProviderUsage | null | undefined): boolean {
  return usage?.total_tokens !== null && usage?.total_tokens !== undefined;
}

function modelIdOrNA(value: string | null | undefined): string {
  if (typeof value !== "string") {
    return "N/A";
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : "N/A";
}
