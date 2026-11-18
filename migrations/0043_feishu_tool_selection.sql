ALTER TABLE runtime_installations ADD COLUMN feishu_tools TEXT;

-- Old Feishu consents did not capture the tools and execution identities.
UPDATE runtime_installations
SET revision = revision + 1, authority_revision = authority_revision + 1
WHERE profile = 'lark.doc' AND phase = 'ready';
