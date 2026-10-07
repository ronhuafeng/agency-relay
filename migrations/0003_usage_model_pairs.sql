DROP TABLE request_audit;
DROP TABLE usage_daily;

CREATE TABLE request_audit (
  id TEXT PRIMARY KEY,
  request_id TEXT,
  route TEXT,
  user_id TEXT NOT NULL,
  key_id TEXT,
  codex_auth_id TEXT,
  requested_model TEXT NOT NULL DEFAULT 'N/A',
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

CREATE TABLE usage_daily (
  user_id TEXT NOT NULL,
  day TEXT NOT NULL,
  requested_model TEXT NOT NULL DEFAULT 'N/A',
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
  PRIMARY KEY (user_id, day, requested_model, response_model),
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE INDEX idx_request_audit_user_created ON request_audit(user_id, created_at);
CREATE INDEX idx_request_audit_key_created ON request_audit(key_id, created_at);
CREATE INDEX idx_request_audit_request_id ON request_audit(request_id);
CREATE INDEX idx_request_audit_route_created ON request_audit(route, created_at);
CREATE INDEX idx_request_audit_session_thread ON request_audit(session_id, thread_id);
CREATE INDEX idx_request_audit_response_id ON request_audit(response_id);
CREATE INDEX idx_request_audit_created ON request_audit(created_at);

CREATE INDEX idx_usage_daily_day_model_pair ON usage_daily(day, requested_model, response_model);
CREATE INDEX idx_usage_daily_user_model_pair_last_seen ON usage_daily(user_id, requested_model, response_model, last_seen_at);
