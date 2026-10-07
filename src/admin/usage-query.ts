import { HttpError } from "../errors";

const MAX_USAGE_LIMIT = 1000;
const DAY_MS = 86_400_000;
export const MAX_USAGE_RANGE_DAYS = 3660;
const USAGE_QUERY_PARAMS = new Set(["scope", "day", "from", "to", "user_id", "route_profile_id", "response_model", "limit"]);

interface UsageQueryFilters {
  scope: "all" | null;
  day: string | null;
  from: string | null;
  to: string | null;
  user_id: string | null;
  route_profile_id: string | null;
  response_model: string | null;
  limit: number;
}
interface ParsedUsageQuery {
  mode: "all" | "day" | "range";
  filters: UsageQueryFilters;
}

export function parseUsageQuery(url: URL, options: { defaultAll?: boolean; defaultLimit?: number } = {}): ParsedUsageQuery {
  assertKnownUsageQueryParams(url);
  const scope = optionalUsageQueryParam(url, "scope", "invalid_usage_filters");
  const day = optionalDayQueryParam(url, "day");
  const from = optionalDayQueryParam(url, "from");
  const to = optionalDayQueryParam(url, "to");
  const userId = optionalUsageQueryParam(url, "user_id", "invalid_usage_filters");
  const routeProfileId = optionalUsageQueryParam(url, "route_profile_id", "invalid_usage_filters");
  const responseModel = optionalUsageQueryParam(url, "response_model", "invalid_usage_filters");

  if (scope && scope !== "all") {
    throw new HttpError(400, "scope must be all", "invalid_request_error", "invalid_usage_filters");
  }
  if ((from && !to) || (!from && to)) {
    throw new HttpError(400, "from and to must be provided together", "invalid_request_error", "invalid_usage_filters");
  }

  const modeCount = (scope === "all" ? 1 : 0) + (day ? 1 : 0) + (from && to ? 1 : 0);
  if (modeCount !== 1 && !(modeCount === 0 && options.defaultAll)) {
    throw new HttpError(400, "Exactly one usage query mode is required", "invalid_request_error", "invalid_usage_filters");
  }

  const limit = !url.searchParams.has("limit") && options.defaultLimit !== undefined ? options.defaultLimit : requiredUsageLimit(url);
  if (from && to && from > to) {
    throw new HttpError(400, "from must be less than or equal to to", "invalid_request_error", "invalid_usage_range");
  }

  if (from && to && (Date.parse(to) - Date.parse(from)) / DAY_MS + 1 > MAX_USAGE_RANGE_DAYS) {
    throw new HttpError(400, `Usage ranges must not exceed ${MAX_USAGE_RANGE_DAYS} UTC days`, "invalid_request_error", "invalid_usage_range");
  }
  return {
    mode: scope === "all" || modeCount === 0 ? "all" : day ? "day" : "range",
    filters: {
      scope: scope === "all" ? "all" : null,
      day,
      from,
      to,
      user_id: userId,
      route_profile_id: routeProfileId,
      response_model: responseModel,
      limit
    }
  };
}


function assertKnownUsageQueryParams(url: URL): void {
  for (const key of url.searchParams.keys()) {
    if (!USAGE_QUERY_PARAMS.has(key) || url.searchParams.getAll(key).length > 1) {
      throw new HttpError(400, "Unsupported or repeated usage query parameter", "invalid_request_error", "invalid_usage_filters");
    }
  }
}

function optionalUsageQueryParam(url: URL, field: string, emptyCode: string): string | null {
  const values = url.searchParams.getAll(field);
  if (values.length === 0) {
    return null;
  }
  if (values.length > 1) throw new HttpError(400, "Repeated usage query parameter", "invalid_request_error", "invalid_usage_filters");
  const value = values[0].trim();
  if (!value) {
    throw new HttpError(400, `${field} must not be empty`, "invalid_request_error", emptyCode);
  }
  return value;
}

function optionalDayQueryParam(url: URL, field: string): string | null {
  const value = optionalUsageQueryParam(url, field, "invalid_day");
  if (!value) {
    return null;
  }
  if (!isValidUtcDay(value)) {
    throw new HttpError(400, `${field} must be a valid YYYY-MM-DD UTC date`, "invalid_request_error", "invalid_day");
  }
  return value;
}

function isValidUtcDay(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function requiredUsageLimit(url: URL): number {
  const raw = optionalUsageQueryParam(url, "limit", "invalid_limit");
  if (!raw || !/^[1-9]\d*$/.test(raw)) {
    throw new HttpError(400, "limit must be an integer from 1 to 1000", "invalid_request_error", "invalid_limit");
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(parsed) || parsed > MAX_USAGE_LIMIT) {
    throw new HttpError(400, "limit must be an integer from 1 to 1000", "invalid_request_error", "invalid_limit");
  }
  return parsed;
}

export interface UsageTrendRange {
  key: "7d" | "30d";
  from: string;
  to: string;
  days: string[];
  asOf: string;
}

/** Finite page ranges reuse the API's exact UTC date parser before any DB read. */
export function parseUsageTrendRange(url: URL, now: Date): UsageTrendRange {
  if (["scope", "day", "from", "to"].some(field => url.searchParams.has(field))) {
    throw new HttpError(400, "Choose range=7d or range=30d for the usage page; use the usage API for explicit dates.", "invalid_request_error", "invalid_usage_filters");
  }
  const key = url.searchParams.get("range") ?? "7d";
  if (url.searchParams.getAll("range").length > 1 || (key !== "7d" && key !== "30d")) {
    throw new HttpError(400, "Choose range=7d or range=30d", "invalid_request_error", "invalid_usage_range");
  }
  const count = key === "7d" ? 7 : 30;
  const to = now.toISOString().slice(0, 10);
  const from = new Date(Date.parse(`${to}T00:00:00Z`) - (count - 1) * DAY_MS).toISOString().slice(0, 10);
  const validated = parseUsageQuery(new URL(`https://usage.invalid/?from=${from}&to=${to}&limit=100`));
  return { key, from: validated.filters.from!, to: validated.filters.to!, asOf: now.toISOString(),
    days: Array.from({length: count}, (_, index) => new Date(Date.parse(`${from}T00:00:00Z`) + index * DAY_MS).toISOString().slice(0, 10)) };
}
