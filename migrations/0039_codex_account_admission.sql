-- Administrative admission is independent from provider credential health.
-- Credential refresh/import/OAuth updates never write this column.
ALTER TABLE codex_auths ADD COLUMN admission_state TEXT NOT NULL DEFAULT 'enabled'
  CHECK (admission_state IN ('enabled', 'paused'));

-- Committing assignment guards close the read/probe-to-write race. Existing
-- bindings and defaults remain intact when their account is paused.
CREATE TRIGGER api_key_surface_credentials_paused_codex_insert
BEFORE INSERT ON api_key_surface_credentials
WHEN EXISTS (SELECT 1 FROM codex_auths WHERE id = NEW.codex_auth_id AND admission_state = 'paused')
BEGIN SELECT RAISE(ABORT, 'credential_not_selectable'); END;

CREATE TRIGGER api_key_surface_credentials_paused_codex_update
BEFORE UPDATE ON api_key_surface_credentials
WHEN EXISTS (SELECT 1 FROM codex_auths WHERE id = NEW.codex_auth_id AND admission_state = 'paused')
BEGIN SELECT RAISE(ABORT, 'credential_not_selectable'); END;

CREATE TRIGGER organization_defaults_paused_codex_insert
BEFORE INSERT ON organization_surface_credential_defaults
WHEN EXISTS (SELECT 1 FROM codex_auths WHERE id = NEW.codex_auth_id AND admission_state = 'paused')
BEGIN SELECT RAISE(ABORT, 'credential_not_selectable'); END;

CREATE TRIGGER organization_defaults_paused_codex_update
BEFORE UPDATE ON organization_surface_credential_defaults
WHEN EXISTS (SELECT 1 FROM codex_auths WHERE id = NEW.codex_auth_id AND admission_state = 'paused')
BEGIN SELECT RAISE(ABORT, 'credential_not_selectable'); END;
