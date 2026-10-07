CREATE TABLE upstream_provider_config (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  provider TEXT NOT NULL CHECK (provider IN ('codex', 'sub2api')),
  updated_at TEXT NOT NULL
);
