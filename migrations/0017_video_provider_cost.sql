ALTER TABLE video_jobs
ADD COLUMN provider_cost_usd_ticks INTEGER
CHECK (provider_cost_usd_ticks IS NULL OR provider_cost_usd_ticks >= 0);

DROP TRIGGER video_jobs_usage_after_insert;
DROP TRIGGER video_jobs_usage_after_terminal;

CREATE TRIGGER video_jobs_usage_after_insert
AFTER INSERT ON video_jobs
BEGIN
  INSERT INTO media_usage_daily
    (user_id, day, capability, started_jobs, completed_jobs, failed_jobs,
     expired_jobs, outputs, video_seconds, output_measurements,
     duration_measurements, first_seen_at, last_seen_at)
  VALUES
    (NEW.user_id, substr(NEW.created_at, 1, 10), NEW.capability,
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
     duration_measurements, provider_cost_usd_ticks, cost_measurements,
     first_seen_at, last_seen_at)
  VALUES
    (NEW.user_id, substr(NEW.usage_finalized_at, 1, 10), NEW.capability,
     0,
     CASE WHEN NEW.status = 'done' THEN 1 ELSE 0 END,
     CASE WHEN NEW.status = 'failed' THEN 1 ELSE 0 END,
     CASE WHEN NEW.status = 'expired' THEN 1 ELSE 0 END,
     CASE WHEN NEW.status = 'done' THEN COALESCE(NEW.outputs, 0) ELSE 0 END,
     CASE WHEN NEW.status = 'done' THEN COALESCE(NEW.video_seconds, 0) ELSE 0 END,
     CASE WHEN NEW.status = 'done' AND NEW.outputs IS NOT NULL THEN 1 ELSE 0 END,
     CASE WHEN NEW.status = 'done' AND NEW.video_seconds IS NOT NULL THEN 1 ELSE 0 END,
     CASE WHEN NEW.status = 'done' THEN COALESCE(NEW.provider_cost_usd_ticks, 0) ELSE 0 END,
     CASE WHEN NEW.status = 'done' AND NEW.provider_cost_usd_ticks IS NOT NULL THEN 1 ELSE 0 END,
     NEW.usage_finalized_at, NEW.usage_finalized_at)
  ON CONFLICT(user_id, day, capability) DO UPDATE SET
    completed_jobs = media_usage_daily.completed_jobs + excluded.completed_jobs,
    failed_jobs = media_usage_daily.failed_jobs + excluded.failed_jobs,
    expired_jobs = media_usage_daily.expired_jobs + excluded.expired_jobs,
    outputs = media_usage_daily.outputs + excluded.outputs,
    video_seconds = media_usage_daily.video_seconds + excluded.video_seconds,
    output_measurements = media_usage_daily.output_measurements + excluded.output_measurements,
    duration_measurements = media_usage_daily.duration_measurements + excluded.duration_measurements,
    provider_cost_usd_ticks = media_usage_daily.provider_cost_usd_ticks + excluded.provider_cost_usd_ticks,
    cost_measurements = media_usage_daily.cost_measurements + excluded.cost_measurements,
    first_seen_at = MIN(media_usage_daily.first_seen_at, excluded.first_seen_at),
    last_seen_at = MAX(media_usage_daily.last_seen_at, excluded.last_seen_at);
END;
