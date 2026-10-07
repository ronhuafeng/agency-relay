CREATE TABLE user_surface_credit_policies (
  user_id TEXT NOT NULL,
  surface_grant TEXT NOT NULL
    CHECK (surface_grant IN (
      'surface:codex:production',
      'surface:grok:production',
      'surface:xai:production'
    )),
  monthly_allowance INTEGER NOT NULL
    CHECK (monthly_allowance >= 0 AND monthly_allowance <= 9007199254740991),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, surface_grant),
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE user_surface_credit_usage (
  user_id TEXT NOT NULL,
  surface_grant TEXT NOT NULL,
  period_start TEXT NOT NULL
    CHECK (length(period_start) = 10 AND substr(period_start, 9, 2) = '01'),
  consumed_credits INTEGER NOT NULL DEFAULT 0
    CHECK (consumed_credits >= 0 AND consumed_credits <= 9007199254740991),
  admitted_attempts INTEGER NOT NULL DEFAULT 0
    CHECK (admitted_attempts >= 0 AND admitted_attempts <= 9007199254740991),
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  PRIMARY KEY (user_id, surface_grant, period_start),
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE INDEX idx_surface_credit_usage_period
  ON user_surface_credit_usage(period_start, surface_grant);
