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
