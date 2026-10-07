import { addSecondsIso, base64UrlDecode, base64UrlEncode, generateId, nowIso } from "../crypto";
import { HttpError } from "../errors";
import type { AppDependencies, CodexToken } from "../types";

/** OpenAI / Codex CLI OAuth (aligned with CRS / sub2api). */
export const CODEX_OAUTH_AUTHORIZE_URL = "https://auth.openai.com/oauth/authorize";
export const CODEX_OAUTH_DEFAULT_REDIRECT_URI = "http://localhost:1455/auth/callback";
export const CODEX_OAUTH_SCOPES = "openid profile email offline_access";
export const CODEX_OAUTH_PENDING_TTL_MS = 30 * 60 * 1000;

interface OAuthTokenResponse {
  access_token?: string;
  refresh_token?: string;
  id_token?: string;
  expires_in?: number;
  account_id?: string;
  email?: string;
}

export interface CodexOAuthPendingSession {
  id: string;
  state: string;
  code_verifier: string;
  redirect_uri: string;
  authorize_url: string;
  expires_at: string;
}

interface JwtClaims {
  email?: string;
  account_id?: string;
  "https://api.openai.com/auth"?: {
    chatgpt_account_id?: string;
  };
}

export async function beginCodexOAuth(
  env: Env,
  options: { credential_account_id: string; redirect_uri?: string | null },
  now = new Date()
): Promise<CodexOAuthPendingSession> {
  const redirectUri = options.redirect_uri?.trim() || CODEX_OAUTH_DEFAULT_REDIRECT_URI;
  const stateBytes = new Uint8Array(32);
  const verifierBytes = new Uint8Array(64);
  crypto.getRandomValues(stateBytes);
  crypto.getRandomValues(verifierBytes);
  // sub2api/OpenAI: verifier as hex of 64 bytes
  const codeVerifier = bytesToHex(verifierBytes);
  const state = bytesToHex(stateBytes);
  const challenge = await pkceChallengeS256(codeVerifier);
  const params = new URLSearchParams({
    response_type: "code",
    client_id: env.CODEX_CLIENT_ID,
    redirect_uri: redirectUri,
    scope: CODEX_OAUTH_SCOPES,
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
    id_token_add_organizations: "true",
    codex_cli_simplified_flow: "true"
  });
  const authorize_url = `${CODEX_OAUTH_AUTHORIZE_URL}?${params.toString()}`;
  const id = generateId("oauth");
  const expires_at = new Date(now.getTime() + CODEX_OAUTH_PENDING_TTL_MS).toISOString();
  await env.DB.prepare(
    `INSERT INTO oauth_pending_sessions
       (id, provider, state, code_verifier, redirect_uri,
        credential_account_id, created_at, expires_at)
     VALUES (?, 'codex', ?, ?, ?, ?, ?, ?)`
  ).bind(id, state, codeVerifier, redirectUri, options.credential_account_id, nowIso(now), expires_at).run();
  return { id, state, code_verifier: codeVerifier, redirect_uri: redirectUri, authorize_url, expires_at };
}

export async function completeCodexOAuth(
  env: Env,
  deps: AppDependencies,
  input: {
    session_id?: string | null;
    state?: string | null;
    code?: string | null;
    callback_url?: string | null;
  },
  authId: string,
  now = new Date()
): Promise<CodexToken> {
  const fromCallback = parseOAuthCallback(input.callback_url);
  const code = (input.code ?? fromCallback.code)?.trim();
  const state = (input.state ?? fromCallback.state)?.trim();
  if (!code || !state) {
    throw new HttpError(400, "OAuth code and state are required (or pass callback_url)", "invalid_request_error", "missing_oauth_code");
  }

  const pending = await env.DB.prepare(
    `SELECT id, state, code_verifier, redirect_uri, credential_account_id, expires_at
     FROM oauth_pending_sessions WHERE provider = 'codex' AND state = ? LIMIT 1`
  ).bind(state).first<{
    id: string;
    state: string;
    code_verifier: string;
    redirect_uri: string;
    credential_account_id: string | null;
    expires_at: string;
  }>();

  if (!pending) {
    throw new HttpError(400, "OAuth session not found or expired", "invalid_request_error", "oauth_session_not_found");
  }
  if (Date.parse(pending.expires_at) <= now.getTime()) {
    await env.DB.prepare("DELETE FROM oauth_pending_sessions WHERE id = ?").bind(pending.id).run();
    throw new HttpError(400, "OAuth session expired; start again", "invalid_request_error", "oauth_session_expired");
  }
  if (input.session_id && input.session_id !== pending.id) {
    throw new HttpError(400, "OAuth session_id does not match state", "invalid_request_error", "oauth_session_mismatch");
  }
  if (pending.credential_account_id !== authId) {
    throw new HttpError(400, "OAuth session belongs to another Credential Account", "invalid_request_error", "oauth_account_mismatch");
  }

  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: env.CODEX_CLIENT_ID,
    code,
    redirect_uri: pending.redirect_uri,
    code_verifier: pending.code_verifier
  });
  const response = await deps.fetch(env.CODEX_OAUTH_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json"
    },
    body
  });
  const raw = await response.text();
  await env.DB.prepare("DELETE FROM oauth_pending_sessions WHERE id = ?").bind(pending.id).run();
  if (!response.ok) {
    throw new HttpError(
      502,
      `Codex OAuth code exchange failed with status ${response.status}: ${trimForError(raw)}`,
      "upstream_error",
      "codex_oauth_exchange_failed"
    );
  }
  return codexTokenFromOAuthResponse(
    authId,
    parseOAuthTokenResponse(raw),
    { auth_id: authId, access_token: "", status: "active" },
    now
  );
}

export async function refreshCodexToken(
  env: Env,
  deps: AppDependencies,
  token: CodexToken,
  now = new Date()
): Promise<CodexToken> {
  if (!token.refresh_token) {
    throw new HttpError(401, "ChatGPT Credential Account does not have a refresh token", "authentication_error", "missing_refresh_token");
  }

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: env.CODEX_CLIENT_ID,
    refresh_token: token.refresh_token,
    scope: "openid profile email"
  });

  const response = await deps.fetch(env.CODEX_OAUTH_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json"
    },
    body
  });

  const raw = await response.text();
  if (!response.ok) {
    const code = refreshErrorCode(raw);
    if (response.status === 401 || (code !== undefined && PERMANENT_REFRESH_ERRORS.includes(code))) {
      throw new HttpError(401, "ChatGPT Credential Account requires administrator reauthorization", "authentication_error", "reauth_required");
    }
    throw new HttpError(502, "Codex token refresh failed", "upstream_error", "codex_token_refresh_failed");
  }

  return codexTokenFromOAuthResponse(token.auth_id, parseOAuthTokenResponse(raw), token, now);
}

export function codexTokenFromOAuthResponse(authId: string, parsed: OAuthTokenResponse, previous: CodexToken, now = new Date()): CodexToken {
  if (!parsed.access_token) {
    throw new HttpError(502, "Codex token response did not include an access token", "upstream_error", "missing_access_token");
  }

  const claims = parseJwtClaims(parsed.id_token ?? previous.id_token);
  const expiresIn = Number.isFinite(parsed.expires_in) && parsed.expires_in && parsed.expires_in > 0 ? parsed.expires_in : undefined;

  return {
    auth_id: authId,
    access_token: parsed.access_token,
    refresh_token: parsed.refresh_token || previous.refresh_token,
    id_token: parsed.id_token || previous.id_token,
    expires_at: expiresIn ? addSecondsIso(expiresIn, now) : previous.expires_at,
    account_id: parsed.account_id ?? claims.account_id ?? previous.account_id,
    email: parsed.email ?? claims.email ?? previous.email,
    status: "active",
    last_refresh_at: nowIso(now)
  };
}

function parseJwtClaims(idToken?: string): { email?: string; account_id?: string } {
  if (!idToken) {
    return {};
  }
  const parts = idToken.split(".");
  if (parts.length < 2) {
    return {};
  }
  try {
    const json = new TextDecoder().decode(base64UrlDecode(parts[1]));
    const claims = JSON.parse(json) as JwtClaims;
    return {
      email: typeof claims.email === "string" ? claims.email : undefined,
      account_id: typeof claims.account_id === "string"
        ? claims.account_id
        : claims["https://api.openai.com/auth"]?.chatgpt_account_id
    };
  } catch {
    return {};
  }
}

function parseOAuthTokenResponse(raw: string): OAuthTokenResponse {
  try {
    return JSON.parse(raw) as OAuthTokenResponse;
  } catch {
    throw new HttpError(502, "Codex token endpoint returned invalid JSON", "upstream_error", "invalid_token_response");
  }
}

const PERMANENT_REFRESH_ERRORS: readonly string[] = [
  "invalid_grant", "refresh_token_reused", "refresh_token_expired", "refresh_token_invalidated"
];

function refreshErrorCode(raw: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && "error" in parsed) {
      const error = parsed.error;
      const code = typeof error === "string" ? error
        : error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : undefined;
      if (code && PERMANENT_REFRESH_ERRORS.includes(code.toLowerCase())) return code.toLowerCase();
      // Preserve legacy OAuth error_description support without disclosing it.
      if ("error_description" in parsed && typeof parsed.error_description === "string") {
        const description = parsed.error_description.toLowerCase();
        return PERMANENT_REFRESH_ERRORS.find(value => description.includes(value));
      }
    }
  } catch {
    const lower = raw.toLowerCase();
    return PERMANENT_REFRESH_ERRORS.find(value => lower.includes(value));
  }
  return undefined;
}

function trimForError(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    return "empty response body";
  }
  return trimmed.length > 500 ? `${trimmed.slice(0, 500)}...` : trimmed;
}

async function pkceChallengeS256(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64UrlEncode(new Uint8Array(digest));
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function parseOAuthCallback(callbackUrl?: string | null): { code?: string; state?: string } {
  if (!callbackUrl?.trim()) {
    return {};
  }
  try {
    const url = new URL(callbackUrl.trim());
    return {
      code: url.searchParams.get("code") ?? undefined,
      state: url.searchParams.get("state") ?? undefined
    };
  } catch {
    // Also accept raw query strings
    try {
      const params = new URLSearchParams(callbackUrl.includes("?") ? callbackUrl.split("?")[1] : callbackUrl);
      return {
        code: params.get("code") ?? undefined,
        state: params.get("state") ?? undefined
      };
    } catch {
      return {};
    }
  }
}
