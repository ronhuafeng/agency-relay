-- Route Decision evidence on request_audit (additive, nullable).
ALTER TABLE request_audit ADD COLUMN ingress_profile_id TEXT;
ALTER TABLE request_audit ADD COLUMN client_flow_id TEXT;
ALTER TABLE request_audit ADD COLUMN ingress_protocol TEXT;
ALTER TABLE request_audit ADD COLUMN requested_model TEXT;
ALTER TABLE request_audit ADD COLUMN resolved_model TEXT;
ALTER TABLE request_audit ADD COLUMN capability_source TEXT;
ALTER TABLE request_audit ADD COLUMN subscription_account_id TEXT;
ALTER TABLE request_audit ADD COLUMN adapter_id TEXT;
ALTER TABLE request_audit ADD COLUMN adapter_version TEXT;
ALTER TABLE request_audit ADD COLUMN route_policy_id TEXT;
ALTER TABLE request_audit ADD COLUMN route_policy_version TEXT;
ALTER TABLE request_audit ADD COLUMN egress_profile_id TEXT;
ALTER TABLE request_audit ADD COLUMN conversion_mode TEXT;
