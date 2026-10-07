// Wire fixtures pinned to openai/codex@1bbdb32789e1f79932df44941236ea3658f6e965:
// backend-client/src/types.rs and codex-backend-openapi-models/src/models/*.rs.
export const CODEX_USAGE_RESPONSE = {
  plan_type: "business",
  rate_limit: {
    allowed: true,
    limit_reached: false,
    primary_window: {
      used_percent: 25,
      limit_window_seconds: 18_000,
      reset_after_seconds: 900,
      reset_at: 1_780_000_000
    },
    secondary_window: {
      used_percent: 40,
      limit_window_seconds: 604_800,
      reset_after_seconds: 86_400,
      reset_at: 1_780_086_400
    }
  },
  credits: {
    has_credits: true,
    unlimited: false,
    balance: "42.50",
    approx_local_messages: [{ model: "gpt-5", messages: 12 }],
    approx_cloud_messages: [{ model: "gpt-5", messages: 8 }]
  },
  spend_control: {
    reached: false,
    individual_limit: {
      source: "workspace",
      limit: "100.00",
      used: "40.00",
      remaining: "60.00",
      used_percent: 40,
      remaining_percent: 60,
      reset_after_seconds: 604_800,
      reset_at: 1_780_604_800
    }
  },
  additional_rate_limits: [{
    limit_name: "Code review",
    metered_feature: "codex_review",
    rate_limit: {
      allowed: true,
      limit_reached: false,
      primary_window: {
        used_percent: 10,
        limit_window_seconds: 86_400,
        reset_after_seconds: 3_600,
        reset_at: 1_780_003_600
      }
    }
  }],
  rate_limit_reached_type: { type: "workspace_member_usage_limit_reached" },
  rate_limit_reset_credits: { available_count: 2 }
};

export const CODEX_PROFILE_RESPONSE = {
  stats: {
    lifetime_tokens: 1_234_567,
    peak_daily_tokens: 45_678,
    longest_running_turn_sec: 321,
    current_streak_days: 7,
    longest_streak_days: 19,
    daily_usage_buckets: [
      { start_date: "2026-07-14", tokens: 12_345 },
      { start_date: "2026-07-15", tokens: 23_456 }
    ]
  }
};

export const CODEX_RESET_CREDITS_RESPONSE = {
  available_count: 2,
  credits: [{
    id: "RateLimitResetCredit_1",
    reset_type: "codexRateLimits",
    status: "available",
    granted_at: "2026-07-15T00:00:00Z",
    expires_at: "2026-08-15T00:00:00Z",
    title: "Full reset",
    description: "Weekly + 5 hr"
  }]
};

export function codexAccountResponses(): Map<string, unknown> {
  return new Map<string, unknown>([
    ["/account/usage", CODEX_USAGE_RESPONSE],
    ["/account/profile", CODEX_PROFILE_RESPONSE],
    ["/account/rate-limit-reset-credits", CODEX_RESET_CREDITS_RESPONSE]
  ]);
}
