CREATE TABLE request_audit_route_profiles (
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
  FOREIGN KEY (user_id) REFERENCES users(id)
);

INSERT INTO request_audit_route_profiles
  (id, request_id, route_profile_id, route, user_id, key_id, codex_auth_id,
   response_model, status, upstream_status, error_code, session_id, thread_id,
   latency_ms, response_id, input_tokens, cached_input_tokens, output_tokens,
   reasoning_tokens, total_tokens, created_at)
SELECT
  id, request_id, 'codex', route, user_id, key_id, codex_auth_id,
  response_model, status, upstream_status, error_code, session_id, thread_id,
  latency_ms, response_id, input_tokens, cached_input_tokens, output_tokens,
  reasoning_tokens, total_tokens, created_at
FROM request_audit;

DROP TABLE request_audit;
ALTER TABLE request_audit_route_profiles RENAME TO request_audit;

CREATE INDEX idx_request_audit_user_created ON request_audit(user_id, created_at);
CREATE INDEX idx_request_audit_key_created ON request_audit(key_id, created_at);
CREATE INDEX idx_request_audit_request_id ON request_audit(request_id);
CREATE INDEX idx_request_audit_route_created ON request_audit(route, created_at);
CREATE INDEX idx_request_audit_session_thread ON request_audit(session_id, thread_id);
CREATE INDEX idx_request_audit_response_id ON request_audit(response_id);
CREATE INDEX idx_request_audit_created ON request_audit(created_at);
