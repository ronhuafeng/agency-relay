-- A retiring, revoked, or disabled account cannot receive a new or copied binding.
CREATE TRIGGER api_key_surface_credentials_selectable_codex_insert
BEFORE INSERT ON api_key_surface_credentials
WHEN NEW.codex_auth_id IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM codex_auths
    WHERE id = NEW.codex_auth_id
      AND status IN ('retiring', 'revoked', 'disabled')
  )
BEGIN
  SELECT RAISE(ABORT, 'credential_not_selectable');
END;

CREATE TRIGGER api_key_surface_credentials_selectable_codex_update
BEFORE UPDATE ON api_key_surface_credentials
WHEN NEW.codex_auth_id IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM codex_auths
    WHERE id = NEW.codex_auth_id
      AND status IN ('retiring', 'revoked', 'disabled')
  )
BEGIN
  SELECT RAISE(ABORT, 'credential_not_selectable');
END;

CREATE TRIGGER api_key_surface_credentials_selectable_grok_insert
BEFORE INSERT ON api_key_surface_credentials
WHEN NEW.subscription_account_id IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM subscription_accounts
    WHERE id = NEW.subscription_account_id
      AND status IN ('retiring', 'revoked', 'disabled')
  )
BEGIN
  SELECT RAISE(ABORT, 'credential_not_selectable');
END;

CREATE TRIGGER api_key_surface_credentials_selectable_grok_update
BEFORE UPDATE ON api_key_surface_credentials
WHEN NEW.subscription_account_id IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM subscription_accounts
    WHERE id = NEW.subscription_account_id
      AND status IN ('retiring', 'revoked', 'disabled')
  )
BEGIN
  SELECT RAISE(ABORT, 'credential_not_selectable');
END;
