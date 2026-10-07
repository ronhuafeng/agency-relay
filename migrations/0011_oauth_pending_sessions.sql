-- Short-lived PKCE OAuth sessions for Access board credential retrieval.
CREATE TABLE IF NOT EXISTS oauth_pending_sessions (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  state TEXT NOT NULL,
  code_verifier TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_oauth_pending_state
  ON oauth_pending_sessions(state);

CREATE INDEX IF NOT EXISTS idx_oauth_pending_expires
  ON oauth_pending_sessions(expires_at);
