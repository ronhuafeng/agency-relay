-- Explicit Unlimited and disabled policies. Finite caps stay in
-- user_surface_credit_policies, which the deployed Worker treats as a
-- numeric ceiling. Unlimited and disabled rows stay out of that table so
-- preparing them does not turn an old Unlimited account into a finite zero.

CREATE TABLE user_surface_credit_modes (
  user_id TEXT NOT NULL,
  surface_grant TEXT NOT NULL
    CHECK (surface_grant IN (
      'surface:codex:production',
      'surface:grok:production',
      'surface:xai:production'
    )),
  mode TEXT NOT NULL CHECK (mode IN ('unlimited', 'disabled')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, surface_grant),
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TRIGGER user_surface_credit_modes_exclude_policy_insert
BEFORE INSERT ON user_surface_credit_modes
WHEN EXISTS (
  SELECT 1 FROM user_surface_credit_policies
  WHERE user_id = NEW.user_id AND surface_grant = NEW.surface_grant
)
BEGIN
  SELECT RAISE(ABORT, 'credit_mode_conflicts_with_finite_policy');
END;

CREATE TRIGGER user_surface_credit_modes_exclude_policy_update
BEFORE UPDATE ON user_surface_credit_modes
WHEN EXISTS (
  SELECT 1 FROM user_surface_credit_policies
  WHERE user_id = NEW.user_id AND surface_grant = NEW.surface_grant
)
BEGIN
  SELECT RAISE(ABORT, 'credit_mode_conflicts_with_finite_policy');
END;

CREATE TRIGGER user_surface_credit_policies_exclude_mode_insert
BEFORE INSERT ON user_surface_credit_policies
WHEN EXISTS (
  SELECT 1 FROM user_surface_credit_modes
  WHERE user_id = NEW.user_id AND surface_grant = NEW.surface_grant
)
BEGIN
  SELECT RAISE(ABORT, 'finite_policy_conflicts_with_credit_mode');
END;

CREATE TRIGGER user_surface_credit_policies_exclude_mode_update
BEFORE UPDATE ON user_surface_credit_policies
WHEN EXISTS (
  SELECT 1 FROM user_surface_credit_modes
  WHERE user_id = NEW.user_id AND surface_grant = NEW.surface_grant
)
BEGIN
  SELECT RAISE(ABORT, 'finite_policy_conflicts_with_credit_mode');
END;
