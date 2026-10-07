ALTER TABLE media_usage_daily
ADD COLUMN provider_cost_usd_ticks INTEGER NOT NULL DEFAULT 0
CHECK (provider_cost_usd_ticks >= 0);

ALTER TABLE media_usage_daily
ADD COLUMN cost_measurements INTEGER NOT NULL DEFAULT 0
CHECK (cost_measurements >= 0);
