ALTER TABLE runtime_installations ADD COLUMN credential_header TEXT;

CREATE TABLE runtime_resource_reservations (
  resource TEXT PRIMARY KEY,
  installation_id TEXT NOT NULL REFERENCES runtime_installations(id)
);

INSERT INTO runtime_resource_reservations (resource, installation_id)
SELECT resource, id FROM runtime_installations;

CREATE TRIGGER runtime_reserve_resource_on_create
AFTER INSERT ON runtime_installations
BEGIN
  INSERT INTO runtime_resource_reservations VALUES (NEW.resource, NEW.id);
END;

CREATE TRIGGER runtime_reserve_resource_on_move
AFTER UPDATE OF resource ON runtime_installations
WHEN OLD.resource <> NEW.resource
BEGIN
  INSERT INTO runtime_resource_reservations VALUES (NEW.resource, NEW.id);
END;
