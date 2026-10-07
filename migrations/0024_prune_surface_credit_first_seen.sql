CREATE TABLE user_surface_credit_usage_pruned (
  user_id TEXT NOT NULL,
  surface_grant TEXT NOT NULL,
  period_start TEXT NOT NULL
    CHECK (length(period_start) = 10 AND substr(period_start, 9, 2) = '01'),
  consumed_credits INTEGER NOT NULL DEFAULT 0
    CHECK (consumed_credits >= 0 AND consumed_credits <= 9007199254740991),
  admitted_attempts INTEGER NOT NULL DEFAULT 0
    CHECK (admitted_attempts >= 0 AND admitted_attempts <= 9007199254740991),
  last_seen_at TEXT NOT NULL,
  PRIMARY KEY (user_id, surface_grant, period_start),
  FOREIGN KEY (user_id) REFERENCES users(id)
);

INSERT INTO user_surface_credit_usage_pruned (
  user_id,
  surface_grant,
  period_start,
  consumed_credits,
  admitted_attempts,
  last_seen_at
)
SELECT
  user_id,
  surface_grant,
  period_start,
  consumed_credits,
  admitted_attempts,
  last_seen_at
FROM user_surface_credit_usage;

DROP INDEX idx_surface_credit_usage_period;
DROP TABLE user_surface_credit_usage;
ALTER TABLE user_surface_credit_usage_pruned RENAME TO user_surface_credit_usage;

CREATE INDEX idx_surface_credit_usage_period
  ON user_surface_credit_usage(period_start, surface_grant);
