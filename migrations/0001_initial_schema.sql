CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS api_keys (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  key_prefix TEXT NOT NULL,
  key_hash TEXT NOT NULL,
  status TEXT NOT NULL,
  scopes TEXT NOT NULL,
  expires_at TEXT,
  last_used_at TEXT,
  created_at TEXT NOT NULL,
  revoked_at TEXT,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS codex_auths (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  upstream_email TEXT,
  upstream_account_id TEXT,
  status TEXT NOT NULL,
  expires_at TEXT,
  last_refresh_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS request_audit (
  id TEXT PRIMARY KEY,
  request_id TEXT,
  route TEXT,
  user_id TEXT NOT NULL,
  key_id TEXT,
  codex_auth_id TEXT,
  model TEXT,
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

CREATE TABLE IF NOT EXISTS usage_daily (
  user_id TEXT NOT NULL,
  day TEXT NOT NULL,
  model TEXT NOT NULL DEFAULT 'N/A',
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
  PRIMARY KEY (user_id, day, model),
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_api_keys_prefix ON api_keys(key_prefix);
CREATE INDEX IF NOT EXISTS idx_api_keys_user_status ON api_keys(user_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_codex_auths_shared ON codex_auths(kind) WHERE kind = 'shared';

CREATE INDEX IF NOT EXISTS idx_request_audit_user_created ON request_audit(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_request_audit_key_created ON request_audit(key_id, created_at);
CREATE INDEX IF NOT EXISTS idx_request_audit_request_id ON request_audit(request_id);
CREATE INDEX IF NOT EXISTS idx_request_audit_route_created ON request_audit(route, created_at);
CREATE INDEX IF NOT EXISTS idx_request_audit_session_thread ON request_audit(session_id, thread_id);
CREATE INDEX IF NOT EXISTS idx_request_audit_response_id ON request_audit(response_id);
CREATE INDEX IF NOT EXISTS idx_request_audit_created ON request_audit(created_at);

CREATE INDEX IF NOT EXISTS idx_usage_daily_day_model ON usage_daily(day, model);
CREATE INDEX IF NOT EXISTS idx_usage_daily_user_model_last_seen ON usage_daily(user_id, model, last_seen_at);
CREATE INDEX IF NOT EXISTS idx_usage_daily_user_last_seen ON usage_daily(user_id, last_seen_at);
