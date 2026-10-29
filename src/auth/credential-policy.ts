export const ADMINISTRATIVE_TERMINAL_SQL = "status NOT IN ('revoked', 'disabled', 'retiring')";

export const CODEX_SHARED_PRODUCTION_SQL = "kind = 'shared' AND environment = 'production'";

export const GROK_PRODUCTION_SQL = "capability_source = 'grok' AND environment = 'production'";
