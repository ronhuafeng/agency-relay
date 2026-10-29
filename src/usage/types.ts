export interface UsageSummaryTotals {
  requests: number;
  ok_requests: number;
  error_requests: number;
  input_tokens: number;
  cached_input_tokens: number;
  output_tokens: number;
  reasoning_tokens: number;
  total_tokens: number;
  token_measurements: number;
  provider_cost_usd_ticks: number;
  cost_measurements: number;
  api_equivalent_usd_ticks: number;
  api_equivalent_measurements: number;
}

export interface UsageSummaryRow extends UsageSummaryTotals {
  first_day: string;
  last_day: string;
  user_id: string;
  email: string | null;
  route_profile_id: string;
  response_model: string;
  last_seen_at: string | null;
}

export interface MediaUsageSummaryTotals {
  started_jobs: number;
  completed_jobs: number;
  failed_jobs: number;
  expired_jobs: number;
  outputs: number;
  video_seconds: number;
  output_measurements: number;
  duration_measurements: number;
  provider_cost_usd_ticks: number;
  cost_measurements: number;
}

export interface MediaUsageSummaryRow extends MediaUsageSummaryTotals {
  first_day: string;
  last_day: string;
  user_id: string;
  email: string | null;
  route_profile_id: string;
  capability: "image_generation" | "image_edit" | "video_generation" | "video_edit" | "video_extension";
  last_seen_at: string | null;
}

export interface MediaUsageSummaryResult {
  totals: MediaUsageSummaryTotals;
  rows: MediaUsageSummaryRow[];
}

export interface UsageSummaryResult {
  totals: UsageSummaryTotals;
  rows: UsageSummaryRow[];
  usersWithUsage: number;
  latestUsageAt: string | null;
}

/** Daily projections retain exact plan/capability authority; no displayed-row limit. */
export interface UsageDailyPoint extends UsageSummaryTotals { day: string; route_profile_id: string }

export interface MediaUsageDailyPoint extends MediaUsageSummaryTotals {
  day: string;
  route_profile_id: string;
  capability: MediaUsageSummaryRow["capability"];
}

export interface UsageDailyResult { responses: UsageDailyPoint[]; media: MediaUsageDailyPoint[] }

export interface CapturedProviderUsage {
  input_tokens: number | null;
  cached_input_tokens: number | null;
  cache_write_input_tokens?: number | null;
  output_tokens: number | null;
  reasoning_tokens: number | null;
  total_tokens: number | null;
  provider_cost_usd_ticks: number | null;
}

export interface CapturedResponseUsage {
  response_id: string | null;
  model: string | null;
  usage: CapturedProviderUsage | null;
}
