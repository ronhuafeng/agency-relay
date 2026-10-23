/**
 * Parse Codex CLI session / auth.json artifacts into storeable Codex tokens.
 * Shape aligned with sub2api ImportCodexSession (tokens.* + top-level fields).
 */
import { HttpError, rejectExpiredAccessToken, requireSessionAccessToken, requireSessionText, sessionExpiry, sessionRecord, sessionRefreshToken, warnMissingSessionRefreshToken } from "../errors";
import { asRecord, firstString, looksLikeJson } from "../records";
import type { CodexToken } from "../types";

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
  const trimmed = requireSessionText(content);

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
    if (!line) invalidCodexSessionJson();
    try {
      value = JSON.parse(line);
    } catch {
      invalidCodexSessionJson();
    }
  }

  if (Array.isArray(value)) {
    if (value.length === 0) {
      throw new HttpError(400, "Session array is empty", "invalid_request_error", "empty_session");
    }
    value = value[0];
  }
  const raw = sessionRecord(value);
  const tokens = asRecord(raw.tokens) ?? {};
  const warnings: string[] = [];
  const access_token = requireSessionAccessToken(raw, tokens);
  const refresh_token = sessionRefreshToken(raw, tokens);
  const id_token = firstString(tokens.id_token, tokens.idToken, raw.id_token, raw.idToken) || undefined;

  if (firstString(raw.session_token, raw.sessionToken)) {
    warnings.push("sessionToken ignored; it is not stored as OAuth refresh_token");
  }

  let expires_at = sessionExpiry(raw, tokens);
  if (expires_at) rejectExpiredAccessToken(expires_at, now);

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

  warnMissingSessionRefreshToken(warnings, refresh_token);

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

function invalidCodexSessionJson(): never {
  throw new HttpError(400, "Could not parse Codex session JSON", "invalid_request_error", "invalid_session_json");
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
