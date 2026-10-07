import { fetchCodexAccountResource } from "./adapter";
import type { CodexAccountEgressPath } from "./adapter";
import type { AppDependencies, FreshAccessToken } from "../types";

// Protocol baseline: openai/codex@1bbdb32789e1f79932df44941236ea3658f6e965.
// Sources: backend-client/src/client.rs, backend-client/src/client/rate_limit_resets.rs,
// backend-client/src/types.rs, and codex-backend-openapi-models/src/models/*.rs.

const DAILY_USAGE_DISPLAY_LIMIT = 366;
const RESET_CREDIT_DISPLAY_LIMIT = 100;
const ADDITIONAL_RATE_LIMIT_DISPLAY_LIMIT = 50;
const ACCOUNT_RESOURCE_TIMEOUT_MS = 5_000;

export type CodexAccountRead<T> =
  | { status: "available"; data: T }
  | { status: "unavailable" };

export interface CodexAccountSnapshot {
  usage: CodexAccountRead<CodexUsage>;
  profile: CodexAccountRead<CodexTokenActivity>;
  resetCredits: CodexAccountRead<CodexResetCredits>;
}

export interface CodexUsage {
  planType: string | null;
  rateLimit: CodexRateLimit | null;
  credits: CodexCredits | null;
  spendControl: CodexSpendControl | null;
  additionalRateLimits: CodexAdditionalRateLimit[];
  rateLimitReachedType: string | null;
  resetCreditAvailableCount: number | null;
}

export interface CodexRateLimit {
  allowed: boolean | null;
  limitReached: boolean | null;
  primaryWindow: CodexRateLimitWindow | null;
  secondaryWindow: CodexRateLimitWindow | null;
}

export interface CodexRateLimitWindow {
  usedPercent: number | null;
  windowSeconds: number | null;
  resetAfterSeconds: number | null;
  resetsAt: number | null;
}

export interface CodexCredits {
  hasCredits: boolean | null;
  unlimited: boolean | null;
  balance: string | null;
  approxLocalMessagesReported: number | undefined;
  approxCloudMessagesReported: number | undefined;
}

export interface CodexSpendControl {
  reached: boolean | null;
  individualLimit: CodexSpendControlLimit | null;
}

export interface CodexSpendControlLimit {
  source: string | null;
  limit: string | null;
  used: string | null;
  remaining: string | null;
  usedPercent: number | null;
  remainingPercent: number | null;
  resetAfterSeconds: number | null;
  resetsAt: number | null;
}

export interface CodexAdditionalRateLimit {
  name: string;
  meteredFeature: string;
  rateLimit: CodexRateLimit | null;
}

export interface CodexTokenActivity {
  lifetimeTokens: number | null;
  peakDailyTokens: number | null;
  longestRunningTurnSeconds: number | null;
  currentStreakDays: number | null;
  longestStreakDays: number | null;
  dailyUsage: CodexDailyTokenUsage[];
}

export interface CodexDailyTokenUsage {
  date: string;
  tokens: number;
}

export interface CodexResetCredits {
  availableCount: number;
  credits: CodexResetCredit[];
}

export interface CodexResetCredit {
  id: string;
  resetType: string;
  status: string;
  grantedAt: string;
  expiresAt: string | null;
  title: string | null;
  description: string | null;
}

export async function readCodexAccountSnapshot(
  env: Env,
  deps: AppDependencies,
  freshToken: FreshAccessToken,
  signal?: AbortSignal
): Promise<CodexAccountSnapshot> {
  const [usage, profile, resetCredits] = await Promise.all([
    readResource(env, deps, freshToken, "/account/usage", parseUsage, signal),
    readResource(env, deps, freshToken, "/account/profile", parseTokenActivity, signal),
    readResource(
      env,
      deps,
      freshToken,
      "/account/rate-limit-reset-credits",
      parseResetCredits,
      signal
    )
  ]);
  return { usage, profile, resetCredits };
}

export function unavailableCodexAccountSnapshot(): CodexAccountSnapshot {
  return {
    usage: { status: "unavailable" },
    profile: { status: "unavailable" },
    resetCredits: { status: "unavailable" }
  };
}

async function readResource<T>(
  env: Env,
  deps: AppDependencies,
  freshToken: FreshAccessToken,
  path: CodexAccountEgressPath,
  parse: (value: unknown) => T | null,
  signal?: AbortSignal
): Promise<CodexAccountRead<T>> {
  try {
    const resourceSignal = signal
      ? AbortSignal.any([signal, AbortSignal.timeout(ACCOUNT_RESOURCE_TIMEOUT_MS)])
      : AbortSignal.timeout(ACCOUNT_RESOURCE_TIMEOUT_MS);
    const response = await fetchCodexAccountResource(env, deps, freshToken, path, resourceSignal);
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      return { status: "unavailable" };
    }
    const parsed = parse(await response.json());
    return parsed === null
      ? { status: "unavailable" }
      : { status: "available", data: parsed };
  } catch {
    return { status: "unavailable" };
  }
}

function parseUsage(value: unknown): CodexUsage | null {
  const object = record(value);
  const planType = stringValue(object?.plan_type);
  if (!object || planType === null) {
    return null;
  }
  const reachedType = record(object.rate_limit_reached_type);
  const resetCredits = record(object.rate_limit_reset_credits);
  return {
    planType,
    rateLimit: parseRateLimit(object.rate_limit),
    credits: parseCredits(object.credits),
    spendControl: parseSpendControl(object.spend_control),
    additionalRateLimits: arrayValue(object.additional_rate_limits)
      .slice(0, ADDITIONAL_RATE_LIMIT_DISPLAY_LIMIT)
      .map(parseAdditionalRateLimit)
      .filter((entry): entry is CodexAdditionalRateLimit => entry !== null),
    rateLimitReachedType: stringValue(reachedType?.type) ?? stringValue(object.rate_limit_reached_type),
    resetCreditAvailableCount: numberValue(resetCredits?.available_count)
  };
}

function parseRateLimit(value: unknown): CodexRateLimit | null {
  const object = record(value);
  if (!object) {
    return null;
  }
  return {
    allowed: booleanValue(object.allowed),
    limitReached: booleanValue(object.limit_reached),
    primaryWindow: parseRateLimitWindow(object.primary_window),
    secondaryWindow: parseRateLimitWindow(object.secondary_window)
  };
}

function parseRateLimitWindow(value: unknown): CodexRateLimitWindow | null {
  const object = record(value);
  if (!object) {
    return null;
  }
  return {
    usedPercent: numberValue(object.used_percent),
    windowSeconds: numberValue(object.limit_window_seconds),
    resetAfterSeconds: numberValue(object.reset_after_seconds),
    resetsAt: numberValue(object.reset_at)
  };
}

function parseCredits(value: unknown): CodexCredits | null {
  const object = record(value);
  if (!object) {
    return null;
  }
  return {
    hasCredits: booleanValue(object.has_credits),
    unlimited: booleanValue(object.unlimited),
    balance: stringValue(object.balance),
    approxLocalMessagesReported: optionalArrayCount(object.approx_local_messages),
    approxCloudMessagesReported: optionalArrayCount(object.approx_cloud_messages)
  };
}

function parseSpendControl(value: unknown): CodexSpendControl | null {
  const object = record(value);
  if (!object) {
    return null;
  }
  return {
    reached: booleanValue(object.reached),
    individualLimit: parseSpendControlLimit(object.individual_limit)
  };
}

function parseSpendControlLimit(value: unknown): CodexSpendControlLimit | null {
  const object = record(value);
  if (!object) {
    return null;
  }
  return {
    source: stringValue(object.source),
    limit: stringValue(object.limit),
    used: stringValue(object.used),
    remaining: stringValue(object.remaining),
    usedPercent: numberValue(object.used_percent),
    remainingPercent: numberValue(object.remaining_percent),
    resetAfterSeconds: numberValue(object.reset_after_seconds),
    resetsAt: numberValue(object.reset_at)
  };
}

function parseAdditionalRateLimit(value: unknown): CodexAdditionalRateLimit | null {
  const object = record(value);
  const name = stringValue(object?.limit_name);
  const meteredFeature = stringValue(object?.metered_feature);
  if (!object || name === null || meteredFeature === null) {
    return null;
  }
  return {
    name,
    meteredFeature,
    rateLimit: parseRateLimit(object.rate_limit)
  };
}

function parseTokenActivity(value: unknown): CodexTokenActivity | null {
  const stats = record(record(value)?.stats);
  if (!stats) {
    return null;
  }
  const dailyUsage = arrayValue(stats.daily_usage_buckets)
    .slice(0, DAILY_USAGE_DISPLAY_LIMIT)
    .map((bucket): CodexDailyTokenUsage | null => {
      const object = record(bucket);
      const date = stringValue(object?.start_date);
      const tokens = numberValue(object?.tokens);
      return object && date !== null && tokens !== null ? { date, tokens } : null;
    })
    .filter((entry): entry is CodexDailyTokenUsage => entry !== null);
  return {
    lifetimeTokens: numberValue(stats.lifetime_tokens),
    peakDailyTokens: numberValue(stats.peak_daily_tokens),
    longestRunningTurnSeconds: numberValue(stats.longest_running_turn_sec),
    currentStreakDays: numberValue(stats.current_streak_days),
    longestStreakDays: numberValue(stats.longest_streak_days),
    dailyUsage
  };
}

function parseResetCredits(value: unknown): CodexResetCredits | null {
  const object = record(value);
  const availableCount = numberValue(object?.available_count);
  if (!object || availableCount === null || !Array.isArray(object.credits)) {
    return null;
  }
  const credits = object.credits
    .slice(0, RESET_CREDIT_DISPLAY_LIMIT)
    .map((credit): CodexResetCredit | null => {
      const details = record(credit);
      const id = stringValue(details?.id);
      const resetType = stringValue(details?.reset_type);
      const status = stringValue(details?.status);
      const grantedAt = stringValue(details?.granted_at);
      if (!details || id === null || resetType === null || status === null || grantedAt === null) {
        return null;
      }
      return {
        id,
        resetType,
        status,
        grantedAt,
        expiresAt: stringValue(details.expires_at),
        title: stringValue(details.title),
        description: stringValue(details.description)
      };
    })
    .filter((entry): entry is CodexResetCredit => entry !== null);
  return { availableCount, credits };
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function optionalArrayCount(value: unknown): number | undefined {
  return Array.isArray(value) ? value.length : undefined;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function booleanValue(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}
