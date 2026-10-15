-- Capture each existing balance only when its first receipted debit commits.
-- Old workers can continue between migration and deployment without a pause.
ALTER TABLE user_surface_credit_usage ADD COLUMN opening_credits INTEGER
  CHECK (opening_credits IS NULL OR (opening_credits >= 0 AND opening_credits <= 9007199254740991));

CREATE TRIGGER credit_opening_immutable
BEFORE UPDATE OF opening_credits ON user_surface_credit_usage
WHEN OLD.opening_credits IS NOT NULL AND NEW.opening_credits IS NOT OLD.opening_credits
BEGIN SELECT RAISE(ABORT, 'credit_opening_immutable'); END;

CREATE TABLE credit_admissions (
  attempt_id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id),
  key_id TEXT,
  surface_grant TEXT NOT NULL,
  period_start TEXT NOT NULL CHECK (length(period_start) = 10 AND substr(period_start, 9, 2) = '01'),
  plan_id TEXT NOT NULL,
  credit_charge INTEGER NOT NULL CHECK (credit_charge > 0 AND credit_charge <= 9007199254740991),
  admitted_at TEXT NOT NULL,
  terminal_confirmed INTEGER NOT NULL DEFAULT 0 CHECK (terminal_confirmed IN (0, 1))
);
CREATE INDEX idx_credit_admissions_scope
  ON credit_admissions(user_id, period_start, surface_grant);

-- Identity and charged amount are facts, not a recalculation from today's Plan.
CREATE TRIGGER credit_admissions_immutable
BEFORE UPDATE ON credit_admissions
WHEN NEW.attempt_id IS NOT OLD.attempt_id OR NEW.user_id IS NOT OLD.user_id
  OR NEW.key_id IS NOT OLD.key_id OR NEW.surface_grant IS NOT OLD.surface_grant
  OR NEW.period_start IS NOT OLD.period_start OR NEW.plan_id IS NOT OLD.plan_id
  OR NEW.credit_charge IS NOT OLD.credit_charge OR NEW.admitted_at IS NOT OLD.admitted_at
  OR NEW.terminal_confirmed < OLD.terminal_confirmed
BEGIN SELECT RAISE(ABORT, 'credit_admission_immutable'); END;

CREATE TRIGGER credit_admissions_confirmation_witness
BEFORE UPDATE OF terminal_confirmed ON credit_admissions
WHEN OLD.terminal_confirmed = 0 AND NEW.terminal_confirmed = 1 AND NOT EXISTS (
  SELECT 1 FROM request_audit WHERE id = NEW.attempt_id
    AND user_id IS NEW.user_id AND key_id IS NEW.key_id AND route_profile_id IS NEW.plan_id
)
BEGIN SELECT RAISE(ABORT, 'credit_terminal_witness_missing'); END;

CREATE TRIGGER credit_admissions_terminal_identity
BEFORE INSERT ON request_audit
WHEN EXISTS (
  SELECT 1 FROM credit_admissions WHERE attempt_id = NEW.id
    AND (user_id IS NOT NEW.user_id OR key_id IS NOT NEW.key_id OR plan_id IS NOT NEW.route_profile_id)
)
BEGIN SELECT RAISE(ABORT, 'credit_terminal_identity_mismatch'); END;

-- This write shares the audit/usage transaction. Retention may remove the audit
-- later, but cannot turn a persisted terminal confirmation back into unknown.
CREATE TRIGGER credit_admissions_terminal_confirm
AFTER INSERT ON request_audit
BEGIN
  UPDATE credit_admissions SET terminal_confirmed = 1 WHERE attempt_id = NEW.id;
END;
