-- Apply before the Worker. Existing non-login owners remain unresolved; this
-- migration never guesses which old accounts are projects and never edits rights.
ALTER TABLE users ADD COLUMN account_kind TEXT NOT NULL DEFAULT 'legacy_unresolved'
  CHECK (account_kind IN ('human', 'service', 'legacy_unresolved'));
ALTER TABLE users ADD COLUMN display_name TEXT;
UPDATE users SET account_kind = 'human' WHERE login_capable = 1;

-- Service names are labels, never mailbox identities or console authority.
CREATE TRIGGER users_service_identity_insert BEFORE INSERT ON users
WHEN NEW.account_kind = 'service' AND (
  NEW.login_capable <> 0 OR NEW.email IS NOT NULL OR NEW.canonical_email IS NOT NULL
  OR NEW.role <> 'user' OR NEW.display_name IS NULL
  OR length(trim(NEW.display_name)) NOT BETWEEN 1 AND 64
)
BEGIN SELECT RAISE(ABORT, 'invalid_service_identity'); END;
CREATE TRIGGER users_service_identity_update BEFORE UPDATE ON users
WHEN (OLD.account_kind = 'human' AND NEW.account_kind = 'service') OR
  (OLD.account_kind = 'service' AND NEW.account_kind <> 'service') OR
  (NEW.account_kind = 'service' AND (
    NEW.login_capable <> 0 OR NEW.email IS NOT NULL OR NEW.canonical_email IS NOT NULL
    OR NEW.role <> 'user' OR NEW.display_name IS NULL
    OR length(trim(NEW.display_name)) NOT BETWEEN 1 AND 64
  ))
BEGIN SELECT RAISE(ABORT, 'invalid_service_identity'); END;

-- During migration-before-Worker rollout, the previous Worker still writes
-- explicit human login capability without knowing account_kind. Preserve that
-- contract for INSERT/JIT and explicit email remediation, changing kind only.
-- A mailbox alone, a non-login row, or a service is never inferred to be human.
CREATE TRIGGER users_legacy_human_insert AFTER INSERT ON users
WHEN NEW.account_kind = 'legacy_unresolved' AND NEW.login_capable = 1
  AND NEW.canonical_email IS NOT NULL AND NEW.email = NEW.canonical_email
BEGIN
  UPDATE users SET account_kind = 'human' WHERE id = NEW.id;
END;
CREATE TRIGGER users_legacy_human_identity_update
AFTER UPDATE OF email, canonical_email, login_capable ON users
WHEN NEW.account_kind = 'legacy_unresolved' AND NEW.login_capable = 1
  AND NEW.canonical_email IS NOT NULL AND NEW.email = NEW.canonical_email
BEGIN
  UPDATE users SET account_kind = 'human' WHERE id = NEW.id;
END;
