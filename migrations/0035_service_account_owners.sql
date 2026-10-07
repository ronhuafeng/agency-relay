-- Apply after 0033 and before the delegation Worker. 0034 is reserved for login
-- return state and has no schema dependency on this additive relation.
-- No creator assignment, key rotation, quota migration, or disable cascade.
CREATE TABLE service_account_owners (
  service_user_id TEXT PRIMARY KEY REFERENCES users(id),
  owner_user_id TEXT REFERENCES users(id),
  revision INTEGER NOT NULL CHECK (revision > 0),
  updated_at TEXT NOT NULL
);
CREATE INDEX service_account_owners_by_human ON service_account_owners(owner_user_id);
CREATE TRIGGER service_account_owner_insert BEFORE INSERT ON service_account_owners
WHEN NOT EXISTS (SELECT 1 FROM users WHERE id = NEW.service_user_id AND account_kind = 'service')
  OR (NEW.owner_user_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM users WHERE id = NEW.owner_user_id AND account_kind = 'human'
      AND status = 'active' AND login_capable = 1 AND canonical_email IS NOT NULL))
BEGIN SELECT RAISE(ABORT, 'invalid_service_owner'); END;
CREATE TRIGGER service_account_owner_update BEFORE UPDATE ON service_account_owners
WHEN NEW.service_user_id <> OLD.service_user_id
  OR (NEW.owner_user_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM users WHERE id = NEW.owner_user_id AND account_kind = 'human'
      AND status = 'active' AND login_capable = 1 AND canonical_email IS NOT NULL))
BEGIN SELECT RAISE(ABORT, 'invalid_service_owner'); END;
