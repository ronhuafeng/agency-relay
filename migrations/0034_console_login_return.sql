-- Keep the stable console destination server-side; OAuth state remains opaque.
-- Existing in-flight login states retain the role-neutral home destination.
ALTER TABLE console_login_states ADD COLUMN return_path TEXT NOT NULL DEFAULT '/';
