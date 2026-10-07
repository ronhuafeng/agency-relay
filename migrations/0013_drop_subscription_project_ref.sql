-- Antigravity project context is not part of the Grok-only subscription contract.
ALTER TABLE subscription_accounts DROP COLUMN project_ref;
