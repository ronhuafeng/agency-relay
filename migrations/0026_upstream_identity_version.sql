CREATE TABLE upstream_identity_version (
  identity TEXT PRIMARY KEY CHECK (identity IN ('codex_cli', 'grok_build')),
  version TEXT NOT NULL
);
