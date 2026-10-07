-- Subscription Account metadata; no secrets in D1.
CREATE TABLE IF NOT EXISTS subscription_accounts (
  id TEXT PRIMARY KEY,
  capability_source TEXT NOT NULL,
  environment TEXT NOT NULL,
  label TEXT NOT NULL,
  status TEXT NOT NULL,
  provider_account_ref TEXT,
  project_ref TEXT,
  expires_at TEXT,
  refresh_available INTEGER NOT NULL DEFAULT 0,
  last_refresh_at TEXT,
  reauth_required_at TEXT,
  last_success_at TEXT,
  last_failure_at TEXT,
  last_test_at TEXT,
  last_test_status TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_subscription_accounts_active_source_env
  ON subscription_accounts(capability_source, environment)
  WHERE status IN ('active', 'reauth_required', 'degraded');

CREATE TABLE IF NOT EXISTS control_plane_audit (
  id TEXT PRIMARY KEY,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  previous_status TEXT,
  next_status TEXT,
  failure_code TEXT,
  detail TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_control_plane_audit_created
  ON control_plane_audit(created_at);
