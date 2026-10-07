CREATE TABLE codex_auths_current (
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

INSERT INTO codex_auths_current
  (id, kind, upstream_email, upstream_account_id, status, expires_at, last_refresh_at, created_at, updated_at)
SELECT
  id, kind, upstream_email, upstream_account_id, status, expires_at, last_refresh_at, created_at, updated_at
FROM codex_auths;

DROP TABLE codex_auths;
ALTER TABLE codex_auths_current RENAME TO codex_auths;

CREATE UNIQUE INDEX idx_codex_auths_shared ON codex_auths(kind) WHERE kind = 'shared';
