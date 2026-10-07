/**
 * Parse Codex CLI session / auth.json artifacts into storeable Codex tokens.
 * Shape aligned with sub2api ImportCodexSession (tokens.* + top-level fields).
 */
import { HttpError } from "../errors";
import type { CodexToken } from "../types";

const CLOCK_SKEW_MS = 120_000;

export interface ParsedCodexSession {
  access_token: string;
  refresh_token?: string;
  id_token?: string;
  email?: string;
  account_id?: string;
  expires_at?: string;
  warnings: string[];
  import_source: "codex_session" | "access_token_only";
}

export function parseCodexSessionArtifact(content: string, now = new Date()): ParsedCodexSession {
  const trimmed = content.trim();
  if (!trimmed) {
    throw new HttpError(400, "Session content is empty", "invalid_request_error", "empty_session");
  }

  // Bare access token (JWT-ish or opaque)
  if (!looksLikeJson(trimmed) && !trimmed.includes("\n")) {
    return {
      access_token: trimmed,
      warnings: ["Imported as access token only; refresh will require re-auth or session with refresh_token"],
      import_source: "access_token_only"
    };
  }

  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch {
    // Multi-line: take first JSON object line or fail
    const line = trimmed.split("\n").map((part) => part.trim()).find((part) => looksLikeJson(part));
    if (!line) {
      throw new HttpError(400, "Could not parse Codex session JSON", "invalid_request_error", "invalid_session_json");
    }
    try {
      value = JSON.parse(line);
    } catch {
      throw new HttpError(400, "Could not parse Codex session JSON", "invalid_request_error", "invalid_session_json");
    }
  }

  if (Array.isArray(value)) {
    if (value.length === 0) {
      throw new HttpError(400, "Session array is empty", "invalid_request_error", "empty_session");
    }
    value = value[0];
  }
  if (!value || typeof value !== "object") {
    throw new HttpError(400, "Session must be a JSON object", "invalid_request_error", "invalid_session_json");
  }

  const raw = value as Record<string, unknown>;
  const tokens = asRecord(raw.tokens) ?? {};
  const warnings: string[] = [];

  const access_token = firstString(
    tokens.access_token,
    tokens.accessToken,
    raw.access_token,
    raw.accessToken,
    raw.token
  );
  if (!access_token) {
    throw new HttpError(400, "Session missing access_token", "invalid_request_error", "missing_access_token");
  }

  const refresh_token = firstString(
    tokens.refresh_token,
    tokens.refreshToken,
    raw.refresh_token,
    raw.refreshToken
  ) || undefined;
  const id_token = firstString(tokens.id_token, tokens.idToken, raw.id_token, raw.idToken) || undefined;

  if (firstString(raw.session_token, raw.sessionToken)) {
    warnings.push("sessionToken ignored; it is not stored as OAuth refresh_token");
  }

  let expires_at = firstString(
    tokens.expires_at,
    tokens.expiresAt,
    raw.expires_at,
    raw.expiresAt
  ) || undefined;
  if (expires_at) {
    const expMs = Date.parse(expires_at);
    if (Number.isFinite(expMs) && expMs <= now.getTime() - CLOCK_SKEW_MS) {
      throw new HttpError(400, `access_token expired at ${expires_at}`, "invalid_request_error", "access_token_expired");
    }
  }

  const email = firstString(raw.email, asRecord(raw.user)?.email) || undefined;
  const account_id = firstString(
    raw.chatgpt_account_id,
    raw.chatgptAccountId,
    raw.account_id,
    raw.accountId,
    asRecord(raw.account)?.id,
    asRecord(raw.account)?.account_id,
    asRecord(raw.account)?.chatgpt_account_id
  ) || claimsAccountId(id_token) || undefined;

  if (!refresh_token) {
    warnings.push("No refresh_token in session; automatic refresh unavailable until re-auth");
  }

  return {
    access_token,
    refresh_token,
    id_token,
    email: email || claimsEmail(id_token),
    account_id,
    expires_at,
    warnings,
    import_source: "codex_session"
  };
}

export function codexTokenFromParsedSession(
  authId: string,
  parsed: ParsedCodexSession,
  now = new Date()
): CodexToken {
  const defaultExpiry = new Date(now.getTime() + 60 * 60 * 1000).toISOString();
  return {
    auth_id: authId,
    access_token: parsed.access_token,
    refresh_token: parsed.refresh_token,
    id_token: parsed.id_token,
    expires_at: parsed.expires_at ?? defaultExpiry,
    account_id: parsed.account_id,
    email: parsed.email,
    status: "active",
    last_refresh_at: now.toISOString()
  };
}

function looksLikeJson(value: string): boolean {
  const t = value.trim();
  return t.startsWith("{") || t.startsWith("[");
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function firstString(...candidates: unknown[]): string {
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim();
    }
  }
  return "";
}

function claimsEmail(idToken?: string): string | undefined {
  const claims = parseJwtPayload(idToken);
  return typeof claims?.email === "string" ? claims.email : undefined;
}

function claimsAccountId(idToken?: string): string | undefined {
  const claims = parseJwtPayload(idToken);
  if (!claims) {
    return undefined;
  }
  if (typeof claims.account_id === "string") {
    return claims.account_id;
  }
  const openaiAuth = asRecord(claims["https://api.openai.com/auth"]);
  if (typeof openaiAuth?.chatgpt_account_id === "string") {
    return openaiAuth.chatgpt_account_id;
  }
  return undefined;
}

function parseJwtPayload(idToken?: string): Record<string, unknown> | null {
  if (!idToken) {
    return null;
  }
  const parts = idToken.split(".");
  if (parts.length < 2) {
    return null;
  }
  try {
    const json = atob(parts[1].replaceAll("-", "+").replaceAll("_", "/"));
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    return null;
  }
}
