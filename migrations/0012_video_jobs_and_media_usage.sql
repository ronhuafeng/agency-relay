CREATE TABLE media_usage_daily (
  user_id TEXT NOT NULL,
  day TEXT NOT NULL,
  capability TEXT NOT NULL,
  started_jobs INTEGER NOT NULL DEFAULT 0,
  completed_jobs INTEGER NOT NULL DEFAULT 0,
  failed_jobs INTEGER NOT NULL DEFAULT 0,
  expired_jobs INTEGER NOT NULL DEFAULT 0,
  outputs INTEGER NOT NULL DEFAULT 0,
  video_seconds REAL NOT NULL DEFAULT 0,
  output_measurements INTEGER NOT NULL DEFAULT 0,
  duration_measurements INTEGER NOT NULL DEFAULT 0,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  PRIMARY KEY (user_id, day, capability),
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE INDEX idx_media_usage_daily_day_capability
  ON media_usage_daily(day, capability);
CREATE INDEX idx_media_usage_daily_user_last_seen
  ON media_usage_daily(user_id, last_seen_at);

CREATE TABLE video_jobs (
  request_id_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'done', 'failed', 'expired')),
  video_seconds REAL CHECK (video_seconds IS NULL OR video_seconds >= 0),
  outputs INTEGER CHECK (outputs IS NULL OR outputs >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  terminal_at TEXT,
  usage_finalized_at TEXT,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE INDEX idx_video_jobs_user_created
  ON video_jobs(user_id, created_at);
CREATE INDEX idx_video_jobs_updated
  ON video_jobs(updated_at);

CREATE TRIGGER video_jobs_usage_after_insert
AFTER INSERT ON video_jobs
BEGIN
  INSERT INTO media_usage_daily
    (user_id, day, capability, started_jobs, completed_jobs, failed_jobs,
     expired_jobs, outputs, video_seconds, output_measurements,
     duration_measurements, first_seen_at, last_seen_at)
  VALUES
    (NEW.user_id, substr(NEW.created_at, 1, 10), 'video_generation',
     1, 0, 0, 0, 0, 0, 0, 0, NEW.created_at, NEW.created_at)
  ON CONFLICT(user_id, day, capability) DO UPDATE SET
    started_jobs = media_usage_daily.started_jobs + 1,
    first_seen_at = MIN(media_usage_daily.first_seen_at, excluded.first_seen_at),
    last_seen_at = MAX(media_usage_daily.last_seen_at, excluded.last_seen_at);
END;

CREATE TRIGGER video_jobs_usage_after_terminal
AFTER UPDATE OF usage_finalized_at ON video_jobs
WHEN OLD.usage_finalized_at IS NULL AND NEW.usage_finalized_at IS NOT NULL
BEGIN
  INSERT INTO media_usage_daily
    (user_id, day, capability, started_jobs, completed_jobs, failed_jobs,
     expired_jobs, outputs, video_seconds, output_measurements,
     duration_measurements, first_seen_at, last_seen_at)
  VALUES
    (NEW.user_id, substr(NEW.usage_finalized_at, 1, 10), 'video_generation',
     0,
     CASE WHEN NEW.status = 'done' THEN 1 ELSE 0 END,
     CASE WHEN NEW.status = 'failed' THEN 1 ELSE 0 END,
     CASE WHEN NEW.status = 'expired' THEN 1 ELSE 0 END,
     CASE WHEN NEW.status = 'done' THEN COALESCE(NEW.outputs, 0) ELSE 0 END,
     CASE WHEN NEW.status = 'done' THEN COALESCE(NEW.video_seconds, 0) ELSE 0 END,
     CASE WHEN NEW.status = 'done' AND NEW.outputs IS NOT NULL THEN 1 ELSE 0 END,
     CASE WHEN NEW.status = 'done' AND NEW.video_seconds IS NOT NULL THEN 1 ELSE 0 END,
     NEW.usage_finalized_at, NEW.usage_finalized_at)
  ON CONFLICT(user_id, day, capability) DO UPDATE SET
    completed_jobs = media_usage_daily.completed_jobs + excluded.completed_jobs,
    failed_jobs = media_usage_daily.failed_jobs + excluded.failed_jobs,
    expired_jobs = media_usage_daily.expired_jobs + excluded.expired_jobs,
    outputs = media_usage_daily.outputs + excluded.outputs,
    video_seconds = media_usage_daily.video_seconds + excluded.video_seconds,
    output_measurements = media_usage_daily.output_measurements + excluded.output_measurements,
    duration_measurements = media_usage_daily.duration_measurements + excluded.duration_measurements,
    first_seen_at = MIN(media_usage_daily.first_seen_at, excluded.first_seen_at),
    last_seen_at = MAX(media_usage_daily.last_seen_at, excluded.last_seen_at);
END;
