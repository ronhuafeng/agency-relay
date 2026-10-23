import { firstString } from "./records";
import type { ErrorBody } from "./types";

export class HttpError extends Error {
  readonly status: number;
  readonly type: string;
  readonly code?: string;
  readonly headers?: Headers;
  readonly body?: unknown;

  constructor(status: number, message: string, type = "invalid_request_error", code?: string, options: { headers?: Headers; body?: unknown } = {}) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.type = type;
    this.code = code;
    this.headers = options.headers;
    this.body = options.body;
  }
}

export function userInactive(): HttpError {
  return new HttpError(403, "User is not active", "authentication_error", "user_inactive");
}

export function keyNotActive(): HttpError {
  return new HttpError(409, "Only an active key can be replaced", "invalid_request_error", "key_not_active");
}

export function jsonObjectRequired(): HttpError {
  return new HttpError(400, "JSON object required", "invalid_request_error", "invalid_json");
}

export function userNotFound(): HttpError {
  return new HttpError(404, "User not found", "invalid_request_error", "user_not_found");
}

export function serviceNotFound(): HttpError {
  return new HttpError(404, "Service not found", "invalid_request_error", "service_not_found");
}

export function keyNotFound(): HttpError {
  return new HttpError(404, "API key not found", "invalid_request_error", "key_not_found");
}

export function subscriptionNotFound(): HttpError {
  return new HttpError(404, "Subscription Account not found", "invalid_request_error", "subscription_not_found");
}

export function codexAuthNotFound(): HttpError {
  return new HttpError(404, "ChatGPT Credential Account not found", "invalid_request_error", "codex_auth_not_found");
}

export function adminRouteNotFound(): HttpError {
  return new HttpError(404, "Admin route not found", "invalid_request_error", "not_found");
}

export function methodNotAllowed(): HttpError {
  return new HttpError(405, "Method not allowed", "invalid_request_error", "method_not_allowed");
}

export function emailConflict(): HttpError {
  return new HttpError(409, "That email already belongs to another account.", "invalid_request_error", "email_conflict");
}

export function adminRequired(): HttpError {
  return new HttpError(403, "Admin authentication required", "authentication_error", "admin_required");
}

export function adminAuthRequired(): HttpError {
  return new HttpError(403, "Admin authentication required", "authentication_error", "admin_auth_required");
}

export function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("Content-Type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(body), { ...init, headers });
}

export function errorResponse(error: unknown, requestId?: string): Response {
  const httpError = normalizeError(error);
  const rid = requestId ?? crypto.randomUUID();
  const headers = new Headers(httpError.headers);
  if (!headers.has("x-request-id")) {
    headers.set("x-request-id", rid);
  }
  if (httpError.body !== undefined) {
    return jsonResponse(httpError.body, { status: httpError.status, headers });
  }
  const body: ErrorBody = {
    error: {
      message: httpError.message,
      type: httpError.type,
      code: httpError.code,
      request_id: rid
    }
  };
  return jsonResponse(body, { status: httpError.status, headers });
}

const PUBLIC_INTERNAL_MESSAGE = "An internal error occurred";
const PUBLIC_INTERNAL_CODE = "internal_error";

export function publicInternalError(): HttpError {
  return new HttpError(500, PUBLIC_INTERNAL_MESSAGE, "server_error", PUBLIC_INTERNAL_CODE);
}

export function routeNotFound(): HttpError {
  return new HttpError(404, "Route not found", "invalid_request_error", "not_found");
}

export function invalidConsoleReturn(): HttpError {
  return new HttpError(400, "Invalid console return target", "invalid_request_error", "invalid_console_return");
}

export function invalidApiKey(): HttpError {
  return new HttpError(401, "Invalid API key", "authentication_error", "invalid_api_key");
}

/**
 * Map unknown failures to a stable public HttpError.
 * Raw exception strings, stack traces, and configuration details stay out of client bodies.
 */
export function errorCause(error: Error | null): Error | null {
  return error && "cause" in error && error.cause instanceof Error ? error.cause : null;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "unknown";
}

export function requiredTrimmedString(body: Record<string, unknown>, field: string): string {
  const value = body[field];
  if (typeof value !== "string" || !value.trim()) {
    throw new HttpError(400, `${field} is required`, "invalid_request_error", `missing_${field}`);
  }
  return value.trim();
}

const ACCESS_TOKEN_CLOCK_SKEW_MS = 120_000;

export function rejectExpiredAccessToken(expiresAt: string, now: Date): void {
  const expMs = Date.parse(expiresAt);
  if (Number.isFinite(expMs) && expMs <= now.getTime() - ACCESS_TOKEN_CLOCK_SKEW_MS) {
    throw new HttpError(400, `access_token expired at ${expiresAt}`, "invalid_request_error", "access_token_expired");
  }
}

export function requireSessionText(content: string): string {
  const trimmed = content.trim();
  if (!trimmed) {
    throw new HttpError(400, "Session content is empty", "invalid_request_error", "empty_session");
  }
  return trimmed;
}

export function sessionRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object") {
    throw new HttpError(400, "Session must be a JSON object", "invalid_request_error", "invalid_session_json");
  }
  return value as Record<string, unknown>;
}

export function requireSessionAccessToken(raw: Record<string, unknown>, tokens: Record<string, unknown>): string {
  const accessToken = firstString(tokens.access_token, tokens.accessToken, raw.access_token, raw.accessToken, raw.token);
  if (!accessToken) {
    throw new HttpError(400, "Session missing access_token", "invalid_request_error", "missing_access_token");
  }
  return accessToken;
}

export function sessionRefreshToken(raw: Record<string, unknown>, tokens: Record<string, unknown>): string | undefined {
  return firstString(tokens.refresh_token, tokens.refreshToken, raw.refresh_token, raw.refreshToken) || undefined;
}

export function warnMissingSessionRefreshToken(warnings: string[], refreshToken: string | undefined): void {
  if (!refreshToken) warnings.push("No refresh_token in session; automatic refresh unavailable until re-auth");
}

export function sessionExpiry(raw: Record<string, unknown>, tokens: Record<string, unknown>): string | undefined {
  return firstString(tokens.expires_at, tokens.expiresAt, raw.expires_at, raw.expiresAt) || undefined;
}

export function normalizeError(error: unknown): HttpError {
  if (error instanceof HttpError) {
    return error;
  }
  if (error instanceof Error) {
    console.error(JSON.stringify({
      event: "internal_error_redacted",
      error_name: error.name,
      // message logged server-side only; never returned to clients for unknown failures
      error_message: error.message.slice(0, 500)
    }));
    return publicInternalError();
  }
  console.error(JSON.stringify({
    event: "internal_error_redacted",
    error_name: "unknown"
  }));
  return publicInternalError();
}
