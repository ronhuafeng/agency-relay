export interface AppDependencies {
  fetch: typeof fetch;
  now: () => Date;
}

export type ExecutionDependencies = AppDependencies;

export type AccountKind = "human" | "service" | "legacy_unresolved";

export interface UserRow {
  id: string;
  email: string | null;
  status: string;
  role?: "admin" | "user";
  canonical_email?: string | null;
  account_kind?: AccountKind;
  display_name?: string | null;
  login_capable?: 0 | 1;
  created_at: string;
  updated_at: string;
}

export interface ApiKeyRow {
  id: string;
  user_id: string;
  key_prefix: string;
  key_hash: string;
  status: string;
  scopes: string;
  name?: string | null;
  family_id?: string;
  expires_at: string | null;
  last_used_at: string | null;
  created_at: string;
  revoked_at: string | null;
}

export interface CodexAuthRow {
  id: string;
  kind: "shared";
  label: string;
  environment: "production";
  upstream_email: string | null;
  upstream_account_id: string | null;
  status: string;
  admission_state: "enabled" | "paused";
  expires_at: string | null;
  last_refresh_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface UsageSummaryTotals {
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
}

export interface UsageSummaryRow extends UsageSummaryTotals {
  first_day: string;
  last_day: string;
  user_id: string;
  email: string | null;
  route_profile_id: string;
  response_model: string;
  last_seen_at: string | null;
}

export interface MediaUsageSummaryTotals {
  started_jobs: number;
  completed_jobs: number;
  failed_jobs: number;
  expired_jobs: number;
  outputs: number;
  video_seconds: number;
  output_measurements: number;
  duration_measurements: number;
  provider_cost_usd_ticks: number;
  cost_measurements: number;
}

export interface MediaUsageSummaryRow extends MediaUsageSummaryTotals {
  first_day: string;
  last_day: string;
  user_id: string;
  email: string | null;
  route_profile_id: string;
  capability: "image_generation" | "image_edit" | "video_generation" | "video_edit" | "video_extension";
  last_seen_at: string | null;
}

export interface MediaUsageSummaryResult {
  totals: MediaUsageSummaryTotals;
  rows: MediaUsageSummaryRow[];
}

export interface UsageSummaryResult {
  totals: UsageSummaryTotals;
  rows: UsageSummaryRow[];
  usersWithUsage: number;
  latestUsageAt: string | null;
}

/** Daily projections retain exact plan/capability authority; no displayed-row limit. */
export interface UsageDailyPoint extends UsageSummaryTotals { day: string; route_profile_id: string }
export interface MediaUsageDailyPoint extends MediaUsageSummaryTotals {
  day: string;
  route_profile_id: string;
  capability: MediaUsageSummaryRow["capability"];
}
export interface UsageDailyResult { responses: UsageDailyPoint[]; media: MediaUsageDailyPoint[] }

export interface RequestContext {
  requestId: string;
  startedAt: number;
  /** End-user authentication completion; request-local timing only. */
  authCompletedAt?: number;
  userId?: string;
  apiKeyId?: string;
  sessionId?: string;
  threadId?: string;
}

export interface CapturedProviderUsage {
  input_tokens: number | null;
  cached_input_tokens: number | null;
  cache_write_input_tokens?: number | null;
  output_tokens: number | null;
  reasoning_tokens: number | null;
  total_tokens: number | null;
  provider_cost_usd_ticks: number | null;
}

export interface CapturedResponseUsage {
  response_id: string | null;
  model: string | null;
  usage: CapturedProviderUsage | null;
}

type CodexObservationErrorCode =
  | "client_request_aborted"
  | "response_observation_parse_failed"
  | "response_observation_premature_eof"
  | "response_observation_limit"
  | "response_observation_decompression_failed"
  | "response_observation_read_failed"
  | "response_observation_skipped"
  | "response_observation_unsupported_encoding"
  | "request_accounting_failed"
  | "upstream_transport_failed";

type CodexObservationStage =
  | "response_body"
  | "response_decompression"
  | "response_parse"
  | "request_accounting"
  | "upstream_fetch";

type CodexObservedContentEncoding =
  | "br"
  | "deflate"
  | "gzip"
  | "identity"
  | "multiple"
  | "unsupported";

export interface CodexTransportObservation {
  transport_trace_id: string;
  upstream_headers_ms: number | null;
  first_sse_chunk_ms: number | null;
  first_sse_event_ms: number | null;
  stream_duration_ms: number | null;
  stream_bytes: number;
  stream_chunks: number;
  terminal_event: "response.completed" | "response.failed" | "response.incomplete" | "error" | null;
  usage_captured: boolean;
  client_aborted: boolean;
  upstream_status: number | null;
  transport: "http_sse" | "http_json" | "http_other";
  observation_status: "ok" | "skipped" | "error";
  observation_error_code: CodexObservationErrorCode | null;
  observation_stage: CodexObservationStage;
  content_encoding: CodexObservedContentEncoding | null;
}

export interface AuthenticatedUser {
  user: UserRow;
  apiKey: ApiKeyRow;
}

export interface CodexToken {
  auth_id: string;
  access_token: string;
  refresh_token?: string;
  id_token?: string;
  expires_at?: string;
  account_id?: string;
  email?: string;
  status: "active" | "reauth_required" | "revoked";
  last_refresh_at?: string;
}

export interface FreshAccessToken {
  access_token: string;
  account_id?: string;
}

export interface CodexAuthRefreshResult {
  auth_id: string;
  refresh_available: boolean;
}

export interface TokenCiphertext {
  kid: "v1";
  iv: string;
  ciphertext: string;
}

export interface ErrorBody {
  error: {
    message: string;
    type: string;
    code?: string;
    request_id?: string;
  };
}
