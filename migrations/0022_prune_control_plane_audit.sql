-- Move historical operator actions to the canonical audit, then remove the
-- unused refresh-event timeline. System refresh state remains projected in
-- subscription_accounts; refresh failures use Worker structured logs.
INSERT INTO operator_mutation_audit (
  id,
  at,
  actor_kind,
  actor_email,
  actor_subject,
  action,
  target_type,
  target_id,
  result,
  request_id,
  meta,
  created_at
)
SELECT
  id,
  created_at,
  CASE actor WHEN 'admin' THEN 'admin_secret' ELSE 'access' END,
  CASE actor WHEN 'admin' THEN NULL ELSE actor END,
  NULL,
  CASE action
    WHEN 'account_created' THEN 'subscription.grok_create'
    WHEN 'credential_imported' THEN 'credential.grok_import'
    WHEN 'credential_storage_purged' THEN 'credential.grok_storage_purge'
    WHEN 'refresh_succeeded' THEN 'credential.grok_refresh'
    WHEN 'test_succeeded' THEN 'credential.grok_test'
    WHEN 'credential_revoked' THEN 'credential.grok_logout'
    ELSE action
  END,
  target_type,
  target_id,
  'ok',
  NULL,
  NULL,
  created_at
FROM control_plane_audit
WHERE actor <> 'system:token_authority';

DROP INDEX IF EXISTS idx_control_plane_audit_created;
DROP TABLE control_plane_audit;
