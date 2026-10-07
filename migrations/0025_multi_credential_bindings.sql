-- Multiple physical credentials with one explicit API-key + Surface binding.
-- Existing encrypted Durable Object state stays at its current deterministic id.

DROP INDEX IF EXISTS idx_codex_auths_shared;
DROP INDEX IF EXISTS idx_subscription_accounts_active_source_env;

ALTER TABLE codex_auths
  ADD COLUMN label TEXT NOT NULL DEFAULT 'ChatGPT';

ALTER TABLE codex_auths
  ADD COLUMN environment TEXT NOT NULL DEFAULT 'production';

ALTER TABLE oauth_pending_sessions
  ADD COLUMN credential_account_id TEXT;

CREATE INDEX IF NOT EXISTS idx_codex_auths_environment_status
  ON codex_auths(environment, status, updated_at);

CREATE INDEX IF NOT EXISTS idx_subscription_accounts_source_environment_status
  ON subscription_accounts(capability_source, environment, status, updated_at);

CREATE TABLE api_key_surface_credentials (
  api_key_id TEXT NOT NULL,
  surface_grant TEXT NOT NULL CHECK (surface_grant IN (
    'surface:codex:production',
    'surface:grok:production',
    'surface:xai:production'
  )),
  codex_auth_id TEXT,
  subscription_account_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (api_key_id, surface_grant),
  CHECK (
    (surface_grant = 'surface:codex:production'
      AND codex_auth_id IS NOT NULL
      AND subscription_account_id IS NULL)
    OR
    (surface_grant IN ('surface:grok:production', 'surface:xai:production')
      AND codex_auth_id IS NULL
      AND subscription_account_id IS NOT NULL)
  ),
  FOREIGN KEY (api_key_id) REFERENCES api_keys(id) ON DELETE CASCADE,
  FOREIGN KEY (codex_auth_id) REFERENCES codex_auths(id) ON DELETE RESTRICT,
  FOREIGN KEY (subscription_account_id) REFERENCES subscription_accounts(id) ON DELETE RESTRICT
);

CREATE INDEX idx_api_key_surface_credentials_codex_auth
  ON api_key_surface_credentials(codex_auth_id);

CREATE INDEX idx_api_key_surface_credentials_subscription_account
  ON api_key_surface_credentials(subscription_account_id);

-- Backfill current active keys. A grant without a current compatible account
-- remains unbound and will fail closed after the runtime cutover.
INSERT INTO api_key_surface_credentials (
  api_key_id,
  surface_grant,
  codex_auth_id,
  subscription_account_id,
  created_at,
  updated_at
)
SELECT DISTINCT
  ak.id,
  scope.value,
  CASE
    WHEN scope.value = 'surface:codex:production' THEN (
      SELECT ca.id
      FROM codex_auths AS ca
      WHERE ca.status IN ('active', 'reauth_required', 'degraded')
        AND ca.environment = 'production'
      ORDER BY ca.updated_at DESC, ca.id DESC
      LIMIT 1
    )
    ELSE NULL
  END,
  CASE
    WHEN scope.value IN ('surface:grok:production', 'surface:xai:production') THEN (
      SELECT sa.id
      FROM subscription_accounts AS sa
      WHERE sa.capability_source = 'grok'
        AND sa.environment = 'production'
        AND sa.status IN ('active', 'reauth_required', 'degraded')
      ORDER BY sa.updated_at DESC, sa.id DESC
      LIMIT 1
    )
    ELSE NULL
  END,
  ak.created_at,
  ak.created_at
FROM api_keys AS ak
JOIN json_each(ak.scopes) AS scope
WHERE ak.status = 'active'
  AND (
    (scope.value = 'surface:codex:production' AND EXISTS (
      SELECT 1
      FROM codex_auths AS ca
      WHERE ca.status IN ('active', 'reauth_required', 'degraded')
        AND ca.environment = 'production'
    ))
    OR
    (scope.value IN ('surface:grok:production', 'surface:xai:production') AND EXISTS (
      SELECT 1
      FROM subscription_accounts AS sa
      WHERE sa.capability_source = 'grok'
        AND sa.environment = 'production'
        AND sa.status IN ('active', 'reauth_required', 'degraded')
    ))
  );
