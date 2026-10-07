-- Retired decision-evidence columns are intentionally removed.
-- Preserve every request_audit row and current accounting field; discard only
-- the seven historical fields that the live runtime no longer owns.
CREATE TABLE request_audit_pruned (
  id TEXT PRIMARY KEY,
  request_id TEXT,
  route_profile_id TEXT NOT NULL,
  route TEXT,
  user_id TEXT NOT NULL,
  key_id TEXT,
  codex_auth_id TEXT,
  response_model TEXT NOT NULL DEFAULT 'N/A',
  status TEXT NOT NULL,
  upstream_status INTEGER,
  error_code TEXT,
  session_id TEXT,
  thread_id TEXT,
  latency_ms INTEGER,
  response_id TEXT,
  input_tokens INTEGER,
  cached_input_tokens INTEGER,
  output_tokens INTEGER,
  reasoning_tokens INTEGER,
  total_tokens INTEGER,
  created_at TEXT NOT NULL,
  ingress_profile_id TEXT,
  ingress_protocol TEXT,
  resolved_model TEXT,
  capability_source TEXT,
  subscription_account_id TEXT,
  egress_profile_id TEXT,
  provider_cost_usd_ticks INTEGER
    CHECK (provider_cost_usd_ticks IS NULL OR provider_cost_usd_ticks >= 0),
  FOREIGN KEY (user_id) REFERENCES users(id)
);

INSERT INTO request_audit_pruned (
  id, request_id, route_profile_id, route, user_id, key_id, codex_auth_id,
  response_model, status, upstream_status, error_code, session_id, thread_id,
  latency_ms, response_id, input_tokens, cached_input_tokens, output_tokens,
  reasoning_tokens, total_tokens, created_at, ingress_profile_id,
  ingress_protocol, resolved_model, capability_source, subscription_account_id,
  egress_profile_id, provider_cost_usd_ticks
)
SELECT
  id, request_id, route_profile_id, route, user_id, key_id, codex_auth_id,
  response_model, status, upstream_status, error_code, session_id, thread_id,
  latency_ms, response_id, input_tokens, cached_input_tokens, output_tokens,
  reasoning_tokens, total_tokens, created_at, ingress_profile_id,
  ingress_protocol, resolved_model, capability_source, subscription_account_id,
  egress_profile_id, provider_cost_usd_ticks
FROM request_audit;

DROP TABLE request_audit;
ALTER TABLE request_audit_pruned RENAME TO request_audit;

CREATE INDEX idx_request_audit_user_created ON request_audit(user_id, created_at);
CREATE INDEX idx_request_audit_key_created ON request_audit(key_id, created_at);
CREATE INDEX idx_request_audit_request_id ON request_audit(request_id);
CREATE INDEX idx_request_audit_route_created ON request_audit(route, created_at);
CREATE INDEX idx_request_audit_session_thread ON request_audit(session_id, thread_id);
CREATE INDEX idx_request_audit_response_id ON request_audit(response_id);
CREATE INDEX idx_request_audit_created ON request_audit(created_at);
