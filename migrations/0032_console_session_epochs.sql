-- Invalidate browser authentication without changing API identity or entitlements.
ALTER TABLE users ADD COLUMN console_session_epoch INTEGER NOT NULL DEFAULT 0;
ALTER TABLE console_sessions ADD COLUMN session_epoch INTEGER NOT NULL DEFAULT 0;
-- Old sessions did not capture identity provenance. Require one fresh login at
-- rollout rather than asserting that a pre-upgrade cookie predates no rename.
UPDATE users SET console_session_epoch = 1;
