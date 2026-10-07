-- Phase A preparation only. Additive columns and defaults.
-- Does not grant admin, invent emails, merge users, rewrite key secrets
-- or bindings, or change quota admission. Not a production cutover.
-- Requires the same SQLite features already used here: ADD COLUMN and
-- partial unique indexes.

ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'user'
  CHECK (role IN ('admin', 'user'));

ALTER TABLE users ADD COLUMN canonical_email TEXT;

ALTER TABLE users ADD COLUMN login_capable INTEGER NOT NULL DEFAULT 0
  CHECK (
    login_capable IN (0, 1)
    AND (login_capable = 0 OR canonical_email IS NOT NULL)
  );

-- A resolvable login identity is trim + lowercase, one @, no whitespace.
-- Missing and invalid addresses stay non-login. Colliding canonical
-- addresses stay non-login so nobody is silently merged.
UPDATE users
SET canonical_email = lower(trim(email))
WHERE email IS NOT NULL
  AND length(trim(email)) > 0
  AND instr(trim(email), ' ') = 0
  AND instr(trim(email), char(9)) = 0
  AND instr(trim(email), char(10)) = 0
  AND instr(trim(email), char(13)) = 0
  AND length(trim(email)) - length(replace(trim(email), '@', '')) = 1
  AND instr(trim(email), '@') > 1
  AND instr(trim(email), '@') < length(trim(email));

UPDATE users
SET login_capable = 1
WHERE canonical_email IS NOT NULL
  AND canonical_email IN (
    SELECT canonical_email
    FROM users
    WHERE canonical_email IS NOT NULL
    GROUP BY canonical_email
    HAVING COUNT(*) = 1
  );

CREATE UNIQUE INDEX idx_users_login_canonical_email
  ON users(canonical_email)
  WHERE login_capable = 1;

ALTER TABLE api_keys ADD COLUMN name TEXT;

ALTER TABLE api_keys ADD COLUMN family_id TEXT NOT NULL DEFAULT '';

UPDATE api_keys
SET family_id = 'legacy:' || id
WHERE family_id = '';

CREATE TRIGGER api_keys_assign_legacy_family
AFTER INSERT ON api_keys
FOR EACH ROW
WHEN NEW.family_id = ''
BEGIN
  UPDATE api_keys
  SET family_id = 'legacy:' || NEW.id
  WHERE id = NEW.id AND family_id = '';
END;

CREATE TABLE organization_surface_credit_defaults (
  surface_grant TEXT PRIMARY KEY
    CHECK (surface_grant IN (
      'surface:codex:production',
      'surface:grok:production',
      'surface:xai:production'
    )),
  monthly_allowance INTEGER NOT NULL
    CHECK (monthly_allowance >= 0 AND monthly_allowance <= 9007199254740991),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

INSERT INTO organization_surface_credit_defaults (
  surface_grant, monthly_allowance, created_at, updated_at
) VALUES
  ('surface:codex:production', 0, '1970-01-01T00:00:00.000Z', '1970-01-01T00:00:00.000Z'),
  ('surface:grok:production', 0, '1970-01-01T00:00:00.000Z', '1970-01-01T00:00:00.000Z'),
  ('surface:xai:production', 0, '1970-01-01T00:00:00.000Z', '1970-01-01T00:00:00.000Z');

CREATE TABLE organization_surface_credential_defaults (
  surface_grant TEXT PRIMARY KEY
    CHECK (surface_grant IN (
      'surface:codex:production',
      'surface:grok:production',
      'surface:xai:production'
    )),
  codex_auth_id TEXT,
  subscription_account_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (
    (surface_grant = 'surface:codex:production'
      AND codex_auth_id IS NOT NULL
      AND subscription_account_id IS NULL)
    OR
    (surface_grant IN ('surface:grok:production', 'surface:xai:production')
      AND codex_auth_id IS NULL
      AND subscription_account_id IS NOT NULL)
  ),
  FOREIGN KEY (codex_auth_id) REFERENCES codex_auths(id) ON DELETE RESTRICT,
  FOREIGN KEY (subscription_account_id) REFERENCES subscription_accounts(id) ON DELETE RESTRICT
);

ALTER TABLE operator_mutation_audit ADD COLUMN actor_user_id TEXT;

ALTER TABLE operator_mutation_audit ADD COLUMN actor_role TEXT
  CHECK (actor_role IS NULL OR actor_role IN ('admin', 'user'));
