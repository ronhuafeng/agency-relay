-- Attribute only the historical GPT rows whose exact Execution Plan and
-- measurement coverage were not retained. The synthetic identity proves the
-- Codex surface without claiming ordinary Responses versus compact.
UPDATE usage_daily
SET route_profile_id = 'codex.historical.responses'
WHERE route_profile_id = 'N/A'
  AND response_model GLOB 'gpt-*'
  AND token_measurements = 0
  AND cost_measurements = 0;
