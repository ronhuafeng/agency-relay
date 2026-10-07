-- Access board + CLI operator mutation audit (no secrets / tokens / key plaintext).
CREATE TABLE IF NOT EXISTS operator_mutation_audit (
  id TEXT PRIMARY KEY,
  at TEXT NOT NULL,
  actor_kind TEXT NOT NULL,
  actor_email TEXT,
  actor_subject TEXT,
  action TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  result TEXT NOT NULL,
  request_id TEXT,
  meta TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_operator_mutation_audit_at
  ON operator_mutation_audit(at);

CREATE INDEX IF NOT EXISTS idx_operator_mutation_audit_target
  ON operator_mutation_audit(target_type, target_id);
