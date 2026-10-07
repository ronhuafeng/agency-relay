/** Read-only projection of retained request metadata. Never consult live routing authority. */
import { executionPlanPresentation, listExecutionPlans, publicExecutionPlanPath } from "../plans/execution-plans";
import { inventoryUrl } from "./ui/href";

export const REQUEST_HISTORY_PAGE_SIZE = 25;
export const REQUEST_HISTORY_FIELDS = ["record", "audit_from", "audit_to", "audit_plan", "audit_user", "audit_result", "audit_request", "audit_cursor", "audit_direction"] as const;
const diagnosticUrl = "https://github.com/ronhuafeng/agency-relay/blob/main/docs/operate/debug-transport.md";
const plans = listExecutionPlans();
const canonicalPaths = new Set(plans.map(publicExecutionPlanPath));
const safeId = (value: unknown): string | null => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value) && !/^(?:cfwd_|sk-|Bearer)/i.test(value) ? value : null;
const numberOrNull = (value: unknown): number | null => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;

export interface RequestHistoryQuery {
  record: string | null;
  from: string;
  to: string;
  plan: string;
  user: string;
  result: string;
  request: string;
  cursor: { at: string; id: string } | null;
  direction: "older" | "newer";
}

/** Called before any read, including the enclosing dashboard's canonical URL. */
export function parseRequestHistoryQuery(url: URL): RequestHistoryQuery {
  for (const field of REQUEST_HISTORY_FIELDS) {
    if (url.searchParams.getAll(field).length > 1 || url.searchParams.has(field) && url.searchParams.get("view") !== "audit") throw new Error("invalid request history query");
  }
  const get = (field: string) => url.searchParams.get(field)?.trim() ?? "";
  const from = get("audit_from"), to = get("audit_to"), plan = get("audit_plan"), user = get("audit_user"), result = get("audit_result"), request = get("audit_request"), record = get("record");
  for (const date of [from, to]) if (date && (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date || date > "9998-12-31")) throw new Error("invalid request history date");
  if (from && to && from > to || plan && !safeId(plan) || record && !safeId(record) || request && !safeId(request) || user.length > 254 || /[\u0000-\u0020\u007f]/.test(user) || !["", "ok", "error", "unknown"].includes(result)) throw new Error("invalid request history filter");
  const direction = get("audit_direction") || "older";
  if (direction !== "older" && direction !== "newer") throw new Error("invalid request history direction");
  let cursor: RequestHistoryQuery["cursor"] = null;
  const raw = get("audit_cursor");
  if (raw) {
    if (raw.length > 300 || !/^[A-Za-z0-9_-]+$/.test(raw)) throw new Error("invalid request history cursor");
    let decoded: unknown;
    try { decoded = JSON.parse(atob(raw.replaceAll("-", "+").replaceAll("_", "/"))); } catch { throw new Error("invalid request history cursor"); }
    if (!Array.isArray(decoded) || decoded.length !== 2 || typeof decoded[0] !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(decoded[0]) || !Number.isFinite(Date.parse(decoded[0])) || new Date(decoded[0]).toISOString() !== decoded[0] || !safeId(decoded[1])) throw new Error("invalid request history cursor");
    cursor = { at: decoded[0], id: decoded[1] };
  } else if (url.searchParams.has("audit_direction")) throw new Error("missing request history cursor");
  return { record: record || null, from, to, plan, user, result, request, cursor, direction };
}

interface StoredRequest {
  id: string; request_id: string | null; route_profile_id: string; route: string | null;
  user_id: string; current_email: string | null; key_id: string | null; current_key_name: string | null;
  codex_auth_id: string | null; subscription_account_id: string | null; status: string;
  upstream_status: number | null; error_code: string | null; latency_ms: number | null;
  total_tokens: number | null; input_tokens: number | null; cached_input_tokens: number | null;
  output_tokens: number | null; reasoning_tokens: number | null; provider_cost_usd_ticks: number | null; created_at: string;
}

// Explicit field allowlist. response_id, session/thread values, bodies, raw resource IDs,
// account provider IDs, key hashes and live credentials never enter this read model.
const selection = `SELECT a.id, a.request_id, a.route_profile_id, a.route, a.user_id,
  CASE WHEN length(u.email) > 254 THEN substr(u.email, 1, 253) || '…' ELSE u.email END AS current_email,
  a.key_id, CASE WHEN length(k.name) > 256 THEN substr(k.name, 1, 255) || '…' ELSE k.name END AS current_key_name,
  a.codex_auth_id, a.subscription_account_id, a.status, a.upstream_status,
  a.error_code, a.latency_ms, a.total_tokens, a.input_tokens, a.cached_input_tokens,
  a.output_tokens, a.reasoning_tokens, a.provider_cost_usd_ticks, a.created_at
  FROM request_audit a LEFT JOIN users u ON u.id = a.user_id
  LEFT JOIN api_keys k ON k.id = a.key_id AND k.user_id = a.user_id`;

const reasons: Record<string, { reason: string; check: "key" | "person" | "diagnosis" }> = {
  invalid_api_key: { reason: "Mini 记录了密钥验证拒绝", check: "key" },
  scope_denied: { reason: "Mini 记录了服务权限拒绝", check: "key" },
  surface_not_entitled: { reason: "Mini 记录了服务未启用", check: "person" },
  surface_credit_exhausted: { reason: "Mini 记录了额度不足", check: "person" },
  missing_credential_binding: { reason: "Mini 记录了缺少固定账号绑定", check: "key" },
  invalid_credential_binding: { reason: "Mini 记录了固定账号绑定不可用", check: "key" },
  missing_credential_account: { reason: "Mini 记录了绑定账号不可用", check: "key" },
  missing_subscription_credential: { reason: "Mini 记录了账号凭据缺失", check: "key" },
  reauth_required: { reason: "Mini 记录了账号需要重新授权", check: "key" },
  upstream_transport_failed: { reason: "记录了上游传输失败；未确证根因", check: "diagnosis" },
  codex_upstream_transport_error: { reason: "记录了 Codex 传输失败；未确证根因", check: "diagnosis" },
  provider_upstream_transport_error: { reason: "记录了提供商传输失败；未确证根因", check: "diagnosis" },
  client_request_aborted: { reason: "记录了客户端取消；不推测取消前任务是否完成", check: "diagnosis" },
  video_start_response_invalid: { reason: "记录的视频启动响应缺少必要元数据", check: "diagnosis" },
  video_job_binding_failed: { reason: "记录了视频任务归属保存失败", check: "diagnosis" },
  video_capability_missing: { reason: "记录的视频能力元数据缺失", check: "diagnosis" },
  xai_file_binding_failed: { reason: "记录了文件归属保存失败", check: "diagnosis" },
  provider_response_read_failed: { reason: "记录了提供商响应读取失败", check: "diagnosis" },
  provider_control_response_read_failed: { reason: "记录了提供商控制响应读取失败", check: "diagnosis" },
  provider_websocket_handshake_invalid: { reason: "记录了 WebSocket 握手不符合预期", check: "diagnosis" },
  response_observation_parse_failed: { reason: "记录了用量观测解析失败；不单独证明客户任务失败", check: "diagnosis" },
  response_observation_skipped: { reason: "记录了用量观测跳过；不单独证明客户任务失败", check: "diagnosis" }
};

export interface RequestHistoryRecord {
  id: string; href: string; at: string; requestId: string | null; plan: string | null;
  service: string; path: string | null; catalogMethod: string | null;
  userId: string | null; currentEmail: string | null; keyId: string | null; currentKeyName: string | null;
  credentialId: string | null; status: "ok" | "error" | "unknown"; upstreamStatus: number | null;
  errorCode: string | null; unrecognizedError: boolean; latencyMs: number | null;
  tokens: number | null; inputTokens: number | null; cachedTokens: number | null; outputTokens: number | null; reasoningTokens: number | null; costTicks: number | null;
  reason: string; check: { href: string; label: string };
}

function project(row: StoredRequest, baseUrl: string): RequestHistoryRecord {
  const id = safeId(row.id) ?? "", plan = safeId(row.route_profile_id), userId = safeId(row.user_id), keyId = safeId(row.key_id);
  const catalog = plans.find(candidate => candidate.id === plan);
  const recognized = row.error_code ? reasons[row.error_code] : undefined;
  const personUrl = userId ? `/admin?view=access&person=${encodeURIComponent(userId)}` : null;
  const check = recognized?.check === "key" && personUrl && keyId
    ? { href: `${personUrl}&key=${encodeURIComponent(keyId)}`, label: "核对当前密钥状态" }
    : recognized?.check === "person" && personUrl
      ? { href: personUrl, label: "核对当前人员与服务额度" }
      : { href: diagnosticUrl, label: "查看只读诊断说明" };
  const upstreamStatus = numberOrNull(row.upstream_status);
  return {
    id, href: inventoryUrl(baseUrl, { record: id }, "request-detail"), at: row.created_at, requestId: safeId(row.request_id), plan,
    service: catalog || plan === "codex.historical.responses" ? executionPlanPresentation(plan!).usageLabel : "历史服务（当前目录无标签）",
    path: row.route && canonicalPaths.has(row.route) ? row.route : null,
    catalogMethod: catalog?.method ?? null, userId, currentEmail: row.current_email,
    keyId, currentKeyName: row.current_key_name,
    credentialId: safeId(row.codex_auth_id) ?? safeId(row.subscription_account_id),
    status: row.status === "ok" || row.status === "error" ? row.status : "unknown",
    upstreamStatus: upstreamStatus !== null && upstreamStatus >= 100 && upstreamStatus <= 599 ? upstreamStatus : null,
    errorCode: recognized ? row.error_code : null, unrecognizedError: Boolean(row.error_code && !recognized), latencyMs: numberOrNull(row.latency_ms),
    tokens: numberOrNull(row.total_tokens), inputTokens: numberOrNull(row.input_tokens), cachedTokens: numberOrNull(row.cached_input_tokens), outputTokens: numberOrNull(row.output_tokens), reasoningTokens: numberOrNull(row.reasoning_tokens), costTicks: numberOrNull(row.provider_cost_usd_ticks),
    reason: recognized?.reason ?? (row.error_code ? "错误原因未能安全识别" : row.status === "error" ? "Mini 记录为失败；具体原因未记录" : "没有记录可确认的失败原因"), check
  };
}

export interface RequestHistoryModel {
  query: RequestHistoryQuery; listUrl: string; retentionDays: number | null;
  rows: RequestHistoryRecord[]; detail: RequestHistoryRecord | null;
  previousUrl: string | null; nextUrl: string | null;
  services: Array<{ id: string; label: string }>;
}

export async function readRequestHistory(env: Env, url: URL): Promise<RequestHistoryModel> {
  const query = parseRequestHistoryQuery(url);
  const listUrl = inventoryUrl(`${url.pathname}${url.search}`, { record: null });
  const retention = Number(env.REQUEST_AUDIT_RETENTION_DAYS);
  const base: RequestHistoryModel = { query, listUrl, retentionDays: Number.isInteger(retention) && retention >= 1 && retention <= 3650 ? retention : null, rows: [], detail: null, previousUrl: null, nextUrl: null,
    services: plans.map(plan => ({ id: plan.id, label: `${executionPlanPresentation(plan.id).usageLabel} · ${plan.method} ${publicExecutionPlanPath(plan)}` })) };
  const where: string[] = [], values: unknown[] = [];
  const filter = (sql: string, value: unknown) => { where.push(sql); values.push(value); };
  if (query.from) filter("a.created_at >= ?", `${query.from}T00:00:00.000Z`);
  if (query.to) filter("a.created_at < ?", new Date(Date.parse(query.to) + 86_400_000).toISOString());
  if (query.plan) filter("a.route_profile_id = ?", query.plan);
  if (query.user) { where.push("(a.user_id = ? OR u.email = ?)"); values.push(query.user, query.user); }
  if (query.result === "unknown") where.push("a.status NOT IN ('ok', 'error')");
  else if (query.result) filter("a.status = ?", query.result);
  if (query.request) filter("a.request_id = ?", query.request);
  const newer = query.direction === "newer";
  if (query.cursor) { where.push(`(a.created_at ${newer ? ">" : "<"} ? OR (a.created_at = ? AND a.id ${newer ? ">" : "<"} ?))`); values.push(query.cursor.at, query.cursor.at, query.cursor.id); }
  const [result, selected] = await Promise.all([
    env.DB.prepare(`${selection} ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY a.created_at ${newer ? "ASC" : "DESC"}, a.id ${newer ? "ASC" : "DESC"} LIMIT ?`).bind(...values, REQUEST_HISTORY_PAGE_SIZE + 1).all<StoredRequest>(),
    query.record ? env.DB.prepare(`${selection} WHERE a.id = ? LIMIT 1`).bind(query.record).first<StoredRequest>() : Promise.resolve(null)
  ]);
  const stored = result.results ?? [];
  const hasMore = stored.length > REQUEST_HISTORY_PAGE_SIZE;
  const rows = stored.slice(0, REQUEST_HISTORY_PAGE_SIZE).map(row => project(row, listUrl));
  if (newer) rows.reverse();
  const pageUrl = (row: RequestHistoryRecord, direction: "older" | "newer") => inventoryUrl(listUrl, { audit_cursor: btoa(JSON.stringify([row.at, row.id])).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, ""), audit_direction: direction });
  return { ...base, rows, detail: selected ? project(selected, listUrl) : null,
    previousUrl: rows.length && (newer ? hasMore : query.cursor) ? pageUrl(rows[0]!, "newer") : null,
    nextUrl: rows.length && (newer ? query.cursor : hasMore) ? pageUrl(rows.at(-1)!, "older") : null };
}
