/**
 * Parse Grok / xAI CLI-style session artifacts into storeable subscription material.
 */
import { GROK_OIDC_ISSUER, GROK_OAUTH_DEFAULT_CLIENT_ID, assertSupportedGrokOidcIssuer } from "./oauth";
import { asRecord, firstString, looksLikeJson } from "../records";
import { HttpError, rejectExpiredAccessToken, requireSessionAccessToken, requireSessionText, sessionExpiry, sessionRecord, sessionRefreshToken, warnMissingSessionRefreshToken } from "../errors";
import type { SubscriptionCredentialMaterial } from "../auth/subscription-accounts";

export interface ParsedGrokSession extends SubscriptionCredentialMaterial {
  oidc_issuer: string;
  oidc_client_id: string;
  import_source: "grok_session" | "access_token_only";
  warnings: string[];
}

export function parseGrokSessionArtifact(content: string, now = new Date()): ParsedGrokSession {
  const trimmed = requireSessionText(content);

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
  const raw = sessionRecord(value);
  const tokens = asRecord(raw.tokens) ?? asRecord(raw.credentials) ?? {};
  const warnings: string[] = [];
  const access_token = requireSessionAccessToken(raw, tokens);
  const refresh_token = sessionRefreshToken(raw, tokens);

  const oidc_client_id = firstString(
    raw.client_id,
    raw.clientId,
    raw.oidc_client_id,
    tokens.client_id
  ) || GROK_OAUTH_DEFAULT_CLIENT_ID;

  const oidc_issuer = firstString(raw.oidc_issuer, raw.issuer, raw.iss) || GROK_OIDC_ISSUER;
  assertSupportedGrokOidcIssuer(oidc_issuer);

  let expires_at = sessionExpiry(raw, tokens);
  if (expires_at) rejectExpiredAccessToken(expires_at, now);

  warnMissingSessionRefreshToken(warnings, refresh_token);

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


