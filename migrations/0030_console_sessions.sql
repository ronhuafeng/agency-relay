-- Console login state and browser sessions. Feishu tokens are not stored.
CREATE TABLE console_login_states (
  state TEXT PRIMARY KEY,
  code_verifier TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX console_login_states_expires_at ON console_login_states(expires_at);

CREATE TABLE console_sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX console_sessions_user_id ON console_sessions(user_id);
