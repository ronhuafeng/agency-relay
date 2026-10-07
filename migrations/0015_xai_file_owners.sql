CREATE TABLE xai_file_owners (
  file_id_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('upload', 'image_output', 'video_output')),
  expires_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE INDEX idx_xai_file_owners_user_created
  ON xai_file_owners(user_id, created_at);

CREATE INDEX idx_xai_file_owners_expiry
  ON xai_file_owners(expires_at)
  WHERE expires_at IS NOT NULL;
