-- Feishu authorize PKCE is not valid for the v3 token endpoint. This app uses its secret.
ALTER TABLE console_login_states DROP COLUMN code_verifier;
