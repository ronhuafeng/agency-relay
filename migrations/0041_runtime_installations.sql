-- Runtime metadata only. Provider credentials, keys and ledgers are unchanged.
CREATE TABLE runtime_installations (
  id TEXT PRIMARY KEY,
  resource TEXT NOT NULL UNIQUE,
  profile TEXT NOT NULL,
  profile_revision INTEGER NOT NULL,
  label TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('disabled', 'enabled', 'retired')),
  revision INTEGER NOT NULL CHECK (revision > 0),
  authority_revision INTEGER NOT NULL CHECK (authority_revision > 0),
  credential_ref TEXT,
  credential_revision INTEGER,
  operation_id TEXT,
  phase TEXT NOT NULL DEFAULT 'ready' CHECK (phase IN ('ready', 'writing', 'cleaning')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK ((credential_ref IS NULL) = (credential_revision IS NULL))
);

CREATE TABLE runtime_installation_access (
  installation_id TEXT NOT NULL REFERENCES runtime_installations(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  revision INTEGER NOT NULL CHECK (revision > 0),
  state TEXT NOT NULL CHECK (state IN ('granted', 'revoked')),
  expires_at TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (installation_id, user_id)
);

-- A real invariant, not a compatibility writer. The same committing user
-- disable invalidates only Runtime access; re-enable cannot revive consent.
CREATE TRIGGER runtime_access_on_human_disable
AFTER UPDATE OF status ON users
WHEN OLD.account_kind = 'human' AND OLD.status = 'active' AND NEW.status = 'disabled'
BEGIN
  UPDATE runtime_installation_access SET revision = revision + 1, updated_at = NEW.updated_at
  WHERE user_id = NEW.id;
END;
