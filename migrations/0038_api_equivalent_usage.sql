-- Additive reporting only. Old rows remain unpriced; no inferred backfill.
ALTER TABLE request_audit ADD COLUMN cache_write_input_tokens INTEGER CHECK (cache_write_input_tokens >= 0);
ALTER TABLE request_audit ADD COLUMN api_equivalent_usd_ticks INTEGER CHECK (api_equivalent_usd_ticks >= 0);
ALTER TABLE request_audit ADD COLUMN api_price_version TEXT;
ALTER TABLE usage_daily ADD COLUMN api_equivalent_usd_ticks INTEGER NOT NULL DEFAULT 0 CHECK (api_equivalent_usd_ticks >= 0);
ALTER TABLE usage_daily ADD COLUMN api_equivalent_measurements INTEGER NOT NULL DEFAULT 0 CHECK (api_equivalent_measurements >= 0);
