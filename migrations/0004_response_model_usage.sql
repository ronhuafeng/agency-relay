CREATE TABLE request_audit_response_model (
  id TEXT PRIMARY KEY,
  request_id TEXT,
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

INSERT INTO request_audit_response_model
  (id, request_id, route, user_id, key_id, codex_auth_id, response_model, status,
   upstream_status, error_code, session_id, thread_id, latency_ms, response_id,
   input_tokens, cached_input_tokens, output_tokens, reasoning_tokens, total_tokens, created_at)
SELECT
  id, request_id, route, user_id, key_id, codex_auth_id, response_model, status,
  upstream_status, error_code, session_id, thread_id, latency_ms, response_id,
  input_tokens, cached_input_tokens, output_tokens, reasoning_tokens, total_tokens, created_at
FROM request_audit;

DROP TABLE request_audit;
ALTER TABLE request_audit_response_model RENAME TO request_audit;

CREATE TABLE usage_daily_response_model (
  user_id TEXT NOT NULL,
  day TEXT NOT NULL,
  response_model TEXT NOT NULL DEFAULT 'N/A',
  requests INTEGER NOT NULL DEFAULT 0,
  ok_requests INTEGER NOT NULL DEFAULT 0,
  error_requests INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  cached_input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  reasoning_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  first_seen_at TEXT,
  last_seen_at TEXT NOT NULL,
  PRIMARY KEY (user_id, day, response_model),
  FOREIGN KEY (user_id) REFERENCES users(id)
);

INSERT INTO usage_daily_response_model
  (user_id, day, response_model, requests, ok_requests, error_requests,
   input_tokens, cached_input_tokens, output_tokens, reasoning_tokens, total_tokens,
   first_seen_at, last_seen_at)
SELECT
  user_id,
  day,
  response_model,
  SUM(requests),
  SUM(ok_requests),
  SUM(error_requests),
  SUM(input_tokens),
  SUM(cached_input_tokens),
  SUM(output_tokens),
  SUM(reasoning_tokens),
  SUM(total_tokens),
  MIN(first_seen_at),
  MAX(last_seen_at)
FROM usage_daily
GROUP BY user_id, day, response_model;

DROP TABLE usage_daily;
ALTER TABLE usage_daily_response_model RENAME TO usage_daily;

CREATE INDEX idx_request_audit_user_created ON request_audit(user_id, created_at);
CREATE INDEX idx_request_audit_key_created ON request_audit(key_id, created_at);
CREATE INDEX idx_request_audit_request_id ON request_audit(request_id);
CREATE INDEX idx_request_audit_route_created ON request_audit(route, created_at);
CREATE INDEX idx_request_audit_session_thread ON request_audit(session_id, thread_id);
CREATE INDEX idx_request_audit_response_id ON request_audit(response_id);
CREATE INDEX idx_request_audit_created ON request_audit(created_at);

CREATE INDEX idx_usage_daily_day_model ON usage_daily(day, response_model);
CREATE INDEX idx_usage_daily_user_model_last_seen ON usage_daily(user_id, response_model, last_seen_at);
CREATE INDEX idx_usage_daily_user_last_seen ON usage_daily(user_id, last_seen_at);
