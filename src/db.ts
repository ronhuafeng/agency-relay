import { canonicalMailbox } from "./auth/principal";
import { generateId, nowIso } from "./crypto";
import { HttpError } from "./errors";
import { REAL_TASK_EXECUTION_PLAN_IDS, executionPlanPresentation, type UsageObserver } from "./plans/execution-plans";
import { apiEquivalentValue } from "./usage/api-value";
import type { UsageDailyResult, UsageDailyPoint, MediaUsageDailyPoint, ApiKeyRow, CapturedProviderUsage, CapturedResponseUsage, CodexAuthRow, MediaUsageSummaryResult, MediaUsageSummaryRow, MediaUsageSummaryTotals, UsageSummaryResult, UsageSummaryRow, UsageSummaryTotals, UserRow } from "./types";

export const SHARED_CODEX_AUTH_ID = "shared_default";
const CODEX_AUTH_KIND = "shared";

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

interface EndUserAuthRow {
  api_key_id: string;
  api_key_user_id: string;
  key_prefix: string;
  key_hash: string;
  api_key_status: string;
  scopes: string;
  expires_at: string | null;
  last_used_at: string | null;
  api_key_created_at: string;
  revoked_at: string | null;
  user_id: string | null;
  user_email: string | null;
  user_status: string | null;
  user_created_at: string | null;
  user_updated_at: string | null;
}

export interface EndUserAuthCandidate {
  apiKey: ApiKeyRow;
  user: UserRow | null;
}

export async function createUser(env: Env, input: { id?: string; email?: string | null; status?: string }, now = new Date()): Promise<UserRow> {
  const requested = input.email ?? null;
  const canonical = requested == null || requested.trim() === "" ? null : canonicalMailbox(requested);
  if (requested != null && requested.trim() !== "" && canonical == null) {
    throw new HttpError(400, "Enter a valid email address.", "invalid_request_error", "invalid_email");
  }
  const row: UserRow = {
    id: input.id ?? generateId("usr"),
    email: canonical,
    canonical_email: canonical,
    role: "user",
    status: input.status ?? "active",
    login_capable: canonical ? 1 : 0,
    account_kind: canonical ? "human" : "legacy_unresolved",
    created_at: nowIso(now),
    updated_at: nowIso(now)
  };
  const result = canonical
    ? await env.DB.prepare(
      `INSERT INTO users (id, email, canonical_email, role, status, login_capable, account_kind, created_at, updated_at)
       SELECT ?, ?, ?, 'user', ?, 1, 'human', ?, ?
       WHERE NOT EXISTS (SELECT 1 FROM users WHERE canonical_email = ?)`
    ).bind(row.id, canonical, canonical, row.status, row.created_at, row.updated_at, canonical).run()
    : await env.DB.prepare(
      `INSERT INTO users (id, email, canonical_email, role, status, login_capable, account_kind, created_at, updated_at)
       VALUES (?, NULL, NULL, 'user', ?, 0, 'legacy_unresolved', ?, ?)`
    ).bind(row.id, row.status, row.created_at, row.updated_at).run();
  if ((result.meta.changes ?? 0) !== 1) {
    throw new HttpError(409, "That email already belongs to another account.", "invalid_request_error", "email_conflict");
  }
  return row;
}

export async function getUser(env: Env, userId: string): Promise<UserRow | null> {
  return env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(userId).first<UserRow>();
}

export async function findEndUserAuthByKeyPrefix(env: Env, prefix: string): Promise<EndUserAuthCandidate | null> {
  const row = await env.DB.prepare(
    `SELECT
       ak.id AS api_key_id,
       ak.user_id AS api_key_user_id,
       ak.key_prefix AS key_prefix,
       ak.key_hash AS key_hash,
       ak.status AS api_key_status,
       ak.scopes AS scopes,
       ak.expires_at AS expires_at,
       ak.last_used_at AS last_used_at,
       ak.created_at AS api_key_created_at,
       ak.revoked_at AS revoked_at,
       u.id AS user_id,
       u.email AS user_email,
       u.status AS user_status,
       u.created_at AS user_created_at,
       u.updated_at AS user_updated_at
     FROM api_keys AS ak
     LEFT JOIN users AS u ON u.id = ak.user_id
     WHERE ak.key_prefix = ?
     LIMIT 1`
  ).bind(prefix).first<EndUserAuthRow>();
  if (!row) {
    return null;
  }
  const apiKey: ApiKeyRow = {
    id: row.api_key_id,
    user_id: row.api_key_user_id,
    key_prefix: row.key_prefix,
    key_hash: row.key_hash,
    status: row.api_key_status,
    scopes: row.scopes,
    expires_at: row.expires_at,
    last_used_at: row.last_used_at,
    created_at: row.api_key_created_at,
    revoked_at: row.revoked_at
  };
  const user = row.user_id && row.user_status && row.user_created_at && row.user_updated_at
    ? {
        id: row.user_id,
        email: row.user_email,
        status: row.user_status,
        created_at: row.user_created_at,
        updated_at: row.user_updated_at
      }
    : null;
  return { apiKey, user };
}

export async function touchApiKey(env: Env, keyId: string, staleBefore: Date, now = new Date()): Promise<void> {
  await env.DB.prepare(
    "UPDATE api_keys SET last_used_at = ? WHERE id = ? AND (last_used_at IS NULL OR last_used_at < ?)"
  ).bind(nowIso(now), keyId, nowIso(staleBefore)).run();
}

export async function revokeApiKey(env: Env, keyId: string, now = new Date()): Promise<void> {
  await env.DB.prepare("UPDATE api_keys SET status = 'revoked', revoked_at = ? WHERE id = ?").bind(nowIso(now), keyId).run();
}

export async function getApiKeyById(env: Env, keyId: string): Promise<ApiKeyRow | null> {
  return env.DB.prepare(
    `SELECT id, user_id, key_prefix, key_hash, status, scopes, name, family_id, expires_at, last_used_at, created_at, revoked_at
     FROM api_keys WHERE id = ? LIMIT 1`
  ).bind(keyId).first<ApiKeyRow>();
}

export type OperatorMutationActorKind = "access" | "admin_secret";

export interface OperatorMutationAuditInput {
  actor_kind: OperatorMutationActorKind;
  actor_email?: string | null;
  actor_subject?: string | null;
  actor_user_id?: string | null;
  actor_role?: "admin" | "user" | null;
  action: string;
  target_type: string;
  target_id: string;
  result: "ok" | "error";
  request_id?: string | null;
  /** Secret-free JSON-serializable metadata (no tokens, no key plaintext, no ADMIN_SECRET). */
  meta?: Record<string, unknown> | null;
}

export function operatorMutationAuditStatement(
  env: Env,
  input: OperatorMutationAuditInput,
  now = new Date()
): D1PreparedStatement {
  const at = nowIso(now);
  const metaJson = input.meta == null ? null : JSON.stringify(sanitizeMutationMeta(input.meta));
  return env.DB.prepare(
    `INSERT INTO operator_mutation_audit (
      id, at, actor_kind, actor_email, actor_subject, actor_user_id, actor_role,
      action, target_type, target_id, result, request_id, meta, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    generateId("oma"),
    at,
    input.actor_kind,
    input.actor_email ?? null,
    input.actor_subject ?? null,
    input.actor_user_id ?? null,
    input.actor_role ?? null,
    input.action,
    input.target_type,
    input.target_id,
    input.result,
    input.request_id ?? null,
    metaJson,
    at
  );
}

export async function insertOperatorMutationAudit(
  env: Env,
  input: OperatorMutationAuditInput,
  now = new Date()
): Promise<void> {
  await operatorMutationAuditStatement(env, input, now).run();
}

const MUTATION_META_FORBIDDEN_KEYS = new Set([
  "token",
  "api_key",
  "plaintext",
  "access_token",
  "refresh_token",
  "id_token",
  "admin_secret",
  "password",
  "secret",
  "key_hash"
]);

function sanitizeMutationMeta(meta: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(meta)) {
    const lower = key.toLowerCase();
    if (MUTATION_META_FORBIDDEN_KEYS.has(lower) || lower.includes("token") || lower.includes("secret")) {
      continue;
    }
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean" || value === null) {
      out[key] = value;
    } else if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
      out[key] = value;
    }
  }
  return out;
}

export async function listCodexAuths(env: Env): Promise<CodexAuthRow[]> {
  const result = await env.DB.prepare(
    `SELECT * FROM codex_auths
     WHERE kind = 'shared' AND environment = 'production'
     ORDER BY created_at ASC`
  ).all<CodexAuthRow>();
  return result.results ?? [];
}

export async function getCodexAuth(env: Env, authId: string): Promise<CodexAuthRow | null> {
  return env.DB.prepare(
    `SELECT * FROM codex_auths
     WHERE id = ? AND kind = 'shared' AND environment = 'production'
     LIMIT 1`
  ).bind(authId).first<CodexAuthRow>();
}

export async function createCodexAuth(
  env: Env,
  input: { label: string },
  now = new Date()
): Promise<CodexAuthRow> {
  const timestamp = nowIso(now);
  const row: CodexAuthRow = {
    id: generateId("auth"),
    kind: CODEX_AUTH_KIND,
    label: input.label.trim() || "ChatGPT",
    environment: "production",
    upstream_email: null,
    upstream_account_id: null,
    status: "pending_credential",
    admission_state: "enabled",
    expires_at: null,
    last_refresh_at: null,
    created_at: timestamp,
    updated_at: timestamp
  };
  await env.DB.prepare(
    `INSERT INTO codex_auths
       (id, kind, label, environment, upstream_email, upstream_account_id,
        status, expires_at, last_refresh_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, NULL, NULL, ?, NULL, NULL, ?, ?)`
  ).bind(row.id, row.kind, row.label, row.environment, row.status, timestamp, timestamp).run();
  return row;
}

export async function updateCodexAuthAfterRefresh(
  env: Env,
  authId: string,
  input: { expires_at?: string | null; account_id?: string | null; email?: string | null; status?: string; last_refresh_at?: string | null },
  now = new Date()
): Promise<void> {
  await env.DB.prepare(
    `UPDATE codex_auths
     SET upstream_email = COALESCE(?, upstream_email),
         upstream_account_id = COALESCE(?, upstream_account_id),
         status = COALESCE(?, status),
         expires_at = COALESCE(?, expires_at),
         last_refresh_at = COALESCE(?, last_refresh_at),
         updated_at = ?
     WHERE id = ? AND kind = 'shared'`
  ).bind(
    input.email ?? null,
    input.account_id ?? null,
    input.status ?? null,
    input.expires_at ?? null,
    input.last_refresh_at ?? null,
    nowIso(now),
    authId
  ).run();
}

const ADMINISTRATIVE_TERMINAL_SQL = "status NOT IN ('revoked', 'disabled', 'retiring')";

export async function readCodexAuthStatus(env: Env, authId: string): Promise<string | null> {
  const row = await env.DB.prepare(
    "SELECT status FROM codex_auths WHERE id = ? AND kind = 'shared'"
  ).bind(authId).first<{ status: string }>();
  return row?.status ?? null;
}

/** Refresh projection. An administrative terminal status is authoritative and is not rewritten. */
export async function projectCodexRefreshIfMutable(
  env: Env,
  authId: string,
  input: { expires_at?: string | null; account_id?: string | null; email?: string | null; status?: string; last_refresh_at?: string | null },
  now = new Date()
): Promise<boolean> {
  const result = await env.DB.prepare(
    `UPDATE codex_auths
     SET upstream_email = COALESCE(?, upstream_email),
         upstream_account_id = COALESCE(?, upstream_account_id),
         status = COALESCE(?, status),
         expires_at = COALESCE(?, expires_at),
         last_refresh_at = COALESCE(?, last_refresh_at),
         updated_at = ?
     WHERE id = ? AND kind = 'shared' AND ${ADMINISTRATIVE_TERMINAL_SQL}`
  ).bind(
    input.email ?? null,
    input.account_id ?? null,
    input.status ?? null,
    input.expires_at ?? null,
    input.last_refresh_at ?? null,
    nowIso(now),
    authId
  ).run();
  return (result.meta?.changes ?? 0) > 0;
}

export async function markCodexAuthReauthRequiredIfMutable(env: Env, authId: string, now = new Date()): Promise<boolean> {
  const result = await env.DB.prepare(
    `UPDATE codex_auths SET status = 'reauth_required', updated_at = ?
     WHERE id = ? AND kind = 'shared' AND ${ADMINISTRATIVE_TERMINAL_SQL}`
  ).bind(nowIso(now), authId).run();
  return (result.meta?.changes ?? 0) > 0;
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

export interface VideoJobRow {
  request_id_hash: string;
  user_id: string;
  route_profile_id: string;
  capability: "video_generation" | "video_edit" | "video_extension";
  status: "pending" | "done" | "failed" | "expired";
  video_seconds: number | null;
  outputs: number | null;
  provider_cost_usd_ticks: number | null;
  created_at: string;
  updated_at: string;
  terminal_at: string | null;
  usage_finalized_at: string | null;
}

export async function createVideoJob(
  env: Env,
  input: {
    request_id_hash: string;
    user_id: string;
    route_profile_id: string;
    capability: VideoJobRow["capability"];
  },
  now = new Date()
): Promise<void> {
  const timestamp = nowIso(now);
  await env.DB.prepare(
    `INSERT INTO video_jobs
     (request_id_hash, user_id, route_profile_id, capability, status, video_seconds, outputs,
      provider_cost_usd_ticks, created_at,
      updated_at, terminal_at, usage_finalized_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    input.request_id_hash,
    input.user_id,
    input.route_profile_id,
    input.capability,
    "pending",
    null,
    null,
    null,
    timestamp,
    timestamp,
    null,
    null
  ).run();
}

export async function recordUntrackedVideoStart(
  env: Env,
  input: {
    user_id: string;
    route_profile_id: string;
    capability: VideoJobRow["capability"];
  },
  now = new Date()
): Promise<void> {
  const timestamp = nowIso(now);
  await env.DB.prepare(
    `INSERT INTO media_usage_daily
     (user_id, day, route_profile_id, capability, started_jobs, completed_jobs, failed_jobs,
      expired_jobs, outputs, video_seconds, output_measurements,
      duration_measurements, provider_cost_usd_ticks, cost_measurements,
      first_seen_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id, day, route_profile_id, capability) DO UPDATE SET
       started_jobs = media_usage_daily.started_jobs + 1,
       first_seen_at = MIN(media_usage_daily.first_seen_at, excluded.first_seen_at),
       last_seen_at = MAX(media_usage_daily.last_seen_at, excluded.last_seen_at)`
  ).bind(
    input.user_id,
    timestamp.slice(0, 10),
    input.route_profile_id,
    input.capability,
    1,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    timestamp,
    timestamp
  ).run();
}

export async function findVideoJobForUser(
  env: Env,
  requestIdHash: string,
  userId: string
): Promise<VideoJobRow | null> {
  return await env.DB.prepare(
    "SELECT * FROM video_jobs WHERE request_id_hash = ? AND user_id = ?"
  ).bind(requestIdHash, userId).first<VideoJobRow>();
}

export async function observeVideoJob(
  env: Env,
  input: {
    request_id_hash: string;
    user_id: string;
    status: VideoJobRow["status"];
    video_seconds: number | null;
    outputs: number | null;
    provider_cost_usd_ticks: number | null;
  },
  now = new Date()
): Promise<boolean> {
  const timestamp = nowIso(now);
  const terminal = input.status === "done" || input.status === "failed" || input.status === "expired";
  const result = await env.DB.prepare(
    `UPDATE video_jobs
     SET status = ?, video_seconds = ?, outputs = ?, provider_cost_usd_ticks = ?, updated_at = ?,
         terminal_at = ?, usage_finalized_at = ?
     WHERE request_id_hash = ? AND user_id = ? AND usage_finalized_at IS NULL`
  ).bind(
    input.status,
    input.status === "done" ? input.video_seconds : null,
    input.status === "done" ? input.outputs : null,
    input.status === "done" ? input.provider_cost_usd_ticks : null,
    timestamp,
    terminal ? timestamp : null,
    terminal ? timestamp : null,
    input.request_id_hash,
    input.user_id
  ).run();
  return (result.meta.changes ?? 0) > 0;
}

export async function cleanupVideoJobs(env: Env, cutoffIso: string): Promise<number> {
  const result = await env.DB.prepare(
    "DELETE FROM video_jobs WHERE updated_at < ?"
  ).bind(cutoffIso).run();
  return result.meta.changes ?? 0;
}

export interface XaiFileOwnerRow {
  file_id_hash: string;
  user_id: string;
  source: "upload" | "image_output" | "video_output";
  expires_at: string | null;
  created_at: string;
  updated_at: string;
}

export async function bindXaiFileOwner(
  env: Env,
  input: {
    file_id_hash: string;
    user_id: string;
    source: XaiFileOwnerRow["source"];
    expires_at: string | null;
  },
  now = new Date()
): Promise<boolean> {
  const timestamp = nowIso(now);
  await env.DB.prepare(
    "DELETE FROM xai_file_owners WHERE expires_at IS NOT NULL AND expires_at <= ?"
  ).bind(timestamp).run();
  await env.DB.prepare(
    `INSERT OR IGNORE INTO xai_file_owners
     (file_id_hash, user_id, source, expires_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).bind(
    input.file_id_hash,
    input.user_id,
    input.source,
    input.expires_at,
    timestamp,
    timestamp
  ).run();
  return await findXaiFileOwner(env, input.file_id_hash, input.user_id, now) !== null;
}

export async function findXaiFileOwner(
  env: Env,
  fileIdHash: string,
  userId: string,
  now = new Date()
): Promise<XaiFileOwnerRow | null> {
  return await env.DB.prepare(
    `SELECT * FROM xai_file_owners
     WHERE file_id_hash = ? AND user_id = ?
       AND (expires_at IS NULL OR expires_at > ?)`
  ).bind(fileIdHash, userId, nowIso(now)).first<XaiFileOwnerRow>();
}

export async function deleteXaiFileOwner(
  env: Env,
  fileIdHash: string,
  userId: string
): Promise<boolean> {
  const result = await env.DB.prepare(
    "DELETE FROM xai_file_owners WHERE file_id_hash = ? AND user_id = ?"
  ).bind(fileIdHash, userId).run();
  return (result.meta.changes ?? 0) > 0;
}

export async function recordImageMediaUsage(
  env: Env,
  input: {
    user_id: string;
    route_profile_id: string;
    capability: "image_generation" | "image_edit";
    status: "ok" | "error";
    outputs: number | null;
    provider_cost_usd_ticks: number | null;
  },
  now = new Date()
): Promise<void> {
  const timestamp = nowIso(now);
  const completed = input.status === "ok" ? 1 : 0;
  const failed = input.status === "error" ? 1 : 0;
  const outputs = input.outputs ?? 0;
  const outputMeasurements = input.outputs !== null ? 1 : 0;
  const cost = input.provider_cost_usd_ticks ?? 0;
  const costMeasurements = input.provider_cost_usd_ticks !== null ? 1 : 0;
  await env.DB.prepare(
    `INSERT INTO media_usage_daily
     (user_id, day, route_profile_id, capability, started_jobs, completed_jobs, failed_jobs,
      expired_jobs, outputs, video_seconds, output_measurements,
      duration_measurements, provider_cost_usd_ticks, cost_measurements,
      first_seen_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id, day, route_profile_id, capability) DO UPDATE SET
       started_jobs = media_usage_daily.started_jobs + excluded.started_jobs,
       completed_jobs = media_usage_daily.completed_jobs + excluded.completed_jobs,
       failed_jobs = media_usage_daily.failed_jobs + excluded.failed_jobs,
       outputs = media_usage_daily.outputs + excluded.outputs,
       output_measurements = media_usage_daily.output_measurements + excluded.output_measurements,
       provider_cost_usd_ticks = media_usage_daily.provider_cost_usd_ticks + excluded.provider_cost_usd_ticks,
       cost_measurements = media_usage_daily.cost_measurements + excluded.cost_measurements,
       first_seen_at = MIN(media_usage_daily.first_seen_at, excluded.first_seen_at),
       last_seen_at = MAX(media_usage_daily.last_seen_at, excluded.last_seen_at)`
  ).bind(
    input.user_id,
    timestamp.slice(0, 10),
    input.route_profile_id,
    input.capability,
    1,
    completed,
    failed,
    0,
    outputs,
    0,
    outputMeasurements,
    0,
    cost,
    costMeasurements,
    timestamp,
    timestamp
  ).run();
}

function prepareAuditInsert(
  env: Env,
  input: {
    id: string;
    request_id?: string | null;
    route_profile_id: string;
    route?: string | null;
    user_id: string;
    key_id?: string | null;
    codex_auth_id?: string | null;
    response_model?: string | null;
    status: string;
    upstream_status?: number | null;
    error_code?: string | null;
    session_id?: string | null;
    thread_id?: string | null;
    latency_ms?: number | null;
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
  input: {
    audit_id: string;
    request_id?: string | null;
    route_profile_id: string;
    route?: string | null;
    user_id: string;
    key_id?: string | null;
    codex_auth_id?: string | null;
    status: "ok" | "error";
    upstream_status?: number | null;
    error_code?: string | null;
    session_id?: string | null;
    thread_id?: string | null;
    latency_ms?: number | null;
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

export async function cleanupRequestAudit(env: Env, cutoffIso: string): Promise<number> {
  const result = await env.DB.prepare("DELETE FROM request_audit WHERE created_at < ?").bind(cutoffIso).run();
  return typeof result.meta.changes === "number" ? result.meta.changes : 0;
}

export async function queryUsageSummary(
  env: Env,
  input: UsageSummaryQuery
): Promise<UsageSummaryResult> {
  const { where, bindings } = usageSummaryWhere(input);
  const totalsRow = await env.DB.prepare(
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
  ).bind(...bindings).first<UsageSummaryTotalsRow>();

  const rows = await queryUsageSummaryRows(env, where, bindings, input.limit);

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
  const totalsRow = await env.DB.prepare(
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
  ).bind(...bindings).first<MediaUsageSummaryTotals>();
  const rowsResult = await env.DB.prepare(
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
  ).bind(...bindings, input.limit).all<MediaUsageSummaryRow>();
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

/** Real-task observations for an exact key; unowned events cannot verify setup. */
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

function usageSummaryWhere(input: UsageRangeQuery & {
  user_id?: string | null;
  route_profile_id?: string | null;
  response_model?: string | null;
}): { where: string; bindings: unknown[] } {
  const conditions: string[] = [];
  const bindings: unknown[] = [];

  if (input.mode === "day") {
    conditions.push("ud.day = ?");
    bindings.push(input.day);
  } else if (input.mode === "range") {
    conditions.push("ud.day >= ?");
    conditions.push("ud.day <= ?");
    bindings.push(input.from, input.to);
  }

  if (input.user_id) {
    conditions.push("ud.user_id = ?");
    bindings.push(input.user_id);
  }
  if (input.route_profile_id) {
    conditions.push("ud.route_profile_id = ?");
    bindings.push(input.route_profile_id);
  }
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
  if (input.mode === "day") {
    conditions.push("mu.day = ?");
    bindings.push(input.day);
  } else if (input.mode === "range") {
    conditions.push("mu.day >= ?", "mu.day <= ?");
    bindings.push(input.from, input.to);
  }
  if (input.user_id) {
    conditions.push("mu.user_id = ?");
    bindings.push(input.user_id);
  }
  if (input.route_profile_id) {
    conditions.push("mu.route_profile_id = ?");
    bindings.push(input.route_profile_id);
  }
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

function stringOrNull(value: string | null | undefined): string | null {
  return typeof value === "string" ? value : null;
}

function utcDay(now: Date): string {
  return now.toISOString().slice(0, 10);
}

function nonNegativeIntegerOrZero(value: number | null | undefined): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : 0;
}

function nonNegativeNumberOrZero(value: number | null | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

function modelIdOrNA(value: string | null | undefined): string {
  if (typeof value !== "string") {
    return "N/A";
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : "N/A";
}
