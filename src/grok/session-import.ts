/**
 * Parse Grok / xAI CLI-style session artifacts into storeable subscription material.
 */
import { GROK_OIDC_ISSUER, GROK_OAUTH_DEFAULT_CLIENT_ID } from "./oauth";
import { HttpError } from "../errors";
import type { SubscriptionCredentialMaterial } from "../auth/subscription-accounts";

export interface ParsedGrokSession extends SubscriptionCredentialMaterial {
  oidc_issuer: string;
  oidc_client_id: string;
  import_source: "grok_session" | "access_token_only";
  warnings: string[];
}

export function parseGrokSessionArtifact(content: string, now = new Date()): ParsedGrokSession {
  const trimmed = content.trim();
  if (!trimmed) {
    throw new HttpError(400, "Session content is empty", "invalid_request_error", "empty_session");
  }

  if (!looksLikeJson(trimmed) && !trimmed.includes("\n")) {
    return {
      access_token: trimmed,
      oidc_issuer: GROK_OIDC_ISSUER,
      oidc_client_id: GROK_OAUTH_DEFAULT_CLIENT_ID,
      import_source: "access_token_only",
      warnings: ["Imported as access token only; refresh needs refresh_token + OIDC client"]
    };
  }

  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch {
    throw new HttpError(400, "Could not parse Grok session JSON", "invalid_request_error", "invalid_session_json");
  }
  if (Array.isArray(value)) {
    value = value[0];
  }
  if (!value || typeof value !== "object") {
    throw new HttpError(400, "Session must be a JSON object", "invalid_request_error", "invalid_session_json");
  }
  const raw = value as Record<string, unknown>;
  const tokens = asRecord(raw.tokens) ?? asRecord(raw.credentials) ?? {};
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

  const oidc_client_id = firstString(
    raw.client_id,
    raw.clientId,
    raw.oidc_client_id,
    tokens.client_id
  ) || GROK_OAUTH_DEFAULT_CLIENT_ID;

  const oidc_issuer = firstString(raw.oidc_issuer, raw.issuer, raw.iss) || GROK_OIDC_ISSUER;
  if (oidc_issuer !== GROK_OIDC_ISSUER) {
    throw new HttpError(400, "Grok OIDC issuer is not supported", "invalid_request_error", "unsupported_grok_oidc_issuer");
  }

  let expires_at = firstString(tokens.expires_at, tokens.expiresAt, raw.expires_at, raw.expiresAt) || undefined;
  if (expires_at) {
    const expMs = Date.parse(expires_at);
    if (Number.isFinite(expMs) && expMs <= now.getTime() - 120_000) {
      throw new HttpError(400, `access_token expired at ${expires_at}`, "invalid_request_error", "access_token_expired");
    }
  }

  if (!refresh_token) {
    warnings.push("No refresh_token in session; automatic refresh unavailable until re-auth");
  }

  return {
    access_token,
    refresh_token,
    id_token: firstString(tokens.id_token, tokens.idToken, raw.id_token) || undefined,
    expires_at,
    email: firstString(raw.email) || undefined,
    account_ref: firstString(raw.account_ref, raw.sub, raw.team_id) || undefined,
    oidc_issuer,
    oidc_client_id,
    import_source: "grok_session",
    warnings
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
