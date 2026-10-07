-- Preserve provider-reported cost with explicit measurement coverage
-- and exact execution-plan attribution. Historical rows did not retain enough
-- evidence to reconstruct their plan or measurement counts, so backfill them
-- as unknown instead of inventing coverage.

ALTER TABLE request_audit
ADD COLUMN provider_cost_usd_ticks INTEGER
CHECK (provider_cost_usd_ticks IS NULL OR provider_cost_usd_ticks >= 0);

CREATE TABLE usage_daily_provisional_billing (
  user_id TEXT NOT NULL,
  day TEXT NOT NULL,
  route_profile_id TEXT NOT NULL,
  response_model TEXT NOT NULL DEFAULT 'N/A',
  requests INTEGER NOT NULL DEFAULT 0 CHECK (requests >= 0),
  ok_requests INTEGER NOT NULL DEFAULT 0 CHECK (ok_requests >= 0),
  error_requests INTEGER NOT NULL DEFAULT 0 CHECK (error_requests >= 0),
  input_tokens INTEGER NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
  cached_input_tokens INTEGER NOT NULL DEFAULT 0 CHECK (cached_input_tokens >= 0),
  output_tokens INTEGER NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
  reasoning_tokens INTEGER NOT NULL DEFAULT 0 CHECK (reasoning_tokens >= 0),
  total_tokens INTEGER NOT NULL DEFAULT 0 CHECK (total_tokens >= 0),
  token_measurements INTEGER NOT NULL DEFAULT 0 CHECK (token_measurements >= 0),
  provider_cost_usd_ticks INTEGER NOT NULL DEFAULT 0 CHECK (provider_cost_usd_ticks >= 0),
  cost_measurements INTEGER NOT NULL DEFAULT 0 CHECK (cost_measurements >= 0),
  first_seen_at TEXT,
  last_seen_at TEXT NOT NULL,
  PRIMARY KEY (user_id, day, route_profile_id, response_model),
  FOREIGN KEY (user_id) REFERENCES users(id)
);

INSERT INTO usage_daily_provisional_billing
  (user_id, day, route_profile_id, response_model, requests, ok_requests,
   error_requests, input_tokens, cached_input_tokens, output_tokens,
   reasoning_tokens, total_tokens, token_measurements,
   provider_cost_usd_ticks, cost_measurements, first_seen_at, last_seen_at)
SELECT
  user_id, day, 'N/A', response_model, requests, ok_requests,
  error_requests, input_tokens, cached_input_tokens, output_tokens,
  reasoning_tokens, total_tokens, 0, 0, 0, first_seen_at, last_seen_at
FROM usage_daily;

DROP TABLE usage_daily;
ALTER TABLE usage_daily_provisional_billing RENAME TO usage_daily;

CREATE INDEX idx_usage_daily_day_plan_model
  ON usage_daily(day, route_profile_id, response_model);
CREATE INDEX idx_usage_daily_user_plan_last_seen
  ON usage_daily(user_id, route_profile_id, last_seen_at);
CREATE INDEX idx_usage_daily_user_last_seen
  ON usage_daily(user_id, last_seen_at);

DROP TRIGGER video_jobs_usage_after_insert;
DROP TRIGGER video_jobs_usage_after_terminal;

ALTER TABLE video_jobs
ADD COLUMN route_profile_id TEXT NOT NULL DEFAULT 'N/A';

UPDATE video_jobs
SET route_profile_id = CASE capability
  WHEN 'video_generation' THEN 'grok.production.videos_generations'
  WHEN 'video_edit' THEN 'grok.production.videos_edits'
  WHEN 'video_extension' THEN 'grok.production.videos_extensions'
  ELSE 'N/A'
END;

CREATE TABLE media_usage_daily_provisional_billing (
  user_id TEXT NOT NULL,
  day TEXT NOT NULL,
  route_profile_id TEXT NOT NULL,
  capability TEXT NOT NULL,
  started_jobs INTEGER NOT NULL DEFAULT 0 CHECK (started_jobs >= 0),
  completed_jobs INTEGER NOT NULL DEFAULT 0 CHECK (completed_jobs >= 0),
  failed_jobs INTEGER NOT NULL DEFAULT 0 CHECK (failed_jobs >= 0),
  expired_jobs INTEGER NOT NULL DEFAULT 0 CHECK (expired_jobs >= 0),
  outputs INTEGER NOT NULL DEFAULT 0 CHECK (outputs >= 0),
  video_seconds REAL NOT NULL DEFAULT 0 CHECK (video_seconds >= 0),
  output_measurements INTEGER NOT NULL DEFAULT 0 CHECK (output_measurements >= 0),
  duration_measurements INTEGER NOT NULL DEFAULT 0 CHECK (duration_measurements >= 0),
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  provider_cost_usd_ticks INTEGER NOT NULL DEFAULT 0 CHECK (provider_cost_usd_ticks >= 0),
  cost_measurements INTEGER NOT NULL DEFAULT 0 CHECK (cost_measurements >= 0),
  PRIMARY KEY (user_id, day, route_profile_id, capability),
  FOREIGN KEY (user_id) REFERENCES users(id)
);

INSERT INTO media_usage_daily_provisional_billing
  (user_id, day, route_profile_id, capability, started_jobs, completed_jobs,
   failed_jobs, expired_jobs, outputs, video_seconds, output_measurements,
   duration_measurements, first_seen_at, last_seen_at,
   provider_cost_usd_ticks, cost_measurements)
SELECT
  user_id, day, 'N/A', capability, started_jobs, completed_jobs,
  failed_jobs, expired_jobs, outputs, video_seconds, output_measurements,
  duration_measurements, first_seen_at, last_seen_at,
  provider_cost_usd_ticks, cost_measurements
FROM media_usage_daily;

DROP TABLE media_usage_daily;
ALTER TABLE media_usage_daily_provisional_billing RENAME TO media_usage_daily;

CREATE INDEX idx_media_usage_daily_day_plan_capability
  ON media_usage_daily(day, route_profile_id, capability);
CREATE INDEX idx_media_usage_daily_user_plan_last_seen
  ON media_usage_daily(user_id, route_profile_id, last_seen_at);

CREATE TRIGGER video_jobs_usage_after_insert
AFTER INSERT ON video_jobs
BEGIN
  INSERT INTO media_usage_daily
    (user_id, day, route_profile_id, capability, started_jobs, completed_jobs,
     failed_jobs, expired_jobs, outputs, video_seconds, output_measurements,
     duration_measurements, provider_cost_usd_ticks, cost_measurements,
     first_seen_at, last_seen_at)
  VALUES
    (NEW.user_id, substr(NEW.created_at, 1, 10), NEW.route_profile_id,
     NEW.capability, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0,
     NEW.created_at, NEW.created_at)
  ON CONFLICT(user_id, day, route_profile_id, capability) DO UPDATE SET
    started_jobs = media_usage_daily.started_jobs + 1,
    first_seen_at = MIN(media_usage_daily.first_seen_at, excluded.first_seen_at),
    last_seen_at = MAX(media_usage_daily.last_seen_at, excluded.last_seen_at);
END;

CREATE TRIGGER video_jobs_usage_after_terminal
AFTER UPDATE OF usage_finalized_at ON video_jobs
WHEN OLD.usage_finalized_at IS NULL AND NEW.usage_finalized_at IS NOT NULL
BEGIN
  INSERT INTO media_usage_daily
    (user_id, day, route_profile_id, capability, started_jobs, completed_jobs,
     failed_jobs, expired_jobs, outputs, video_seconds, output_measurements,
     duration_measurements, provider_cost_usd_ticks, cost_measurements,
     first_seen_at, last_seen_at)
  VALUES
    (NEW.user_id, substr(NEW.usage_finalized_at, 1, 10), NEW.route_profile_id,
     NEW.capability,
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
  ON CONFLICT(user_id, day, route_profile_id, capability) DO UPDATE SET
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
