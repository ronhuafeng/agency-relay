import { addSecondsIso, base64UrlEncode, generateId, nowIso, pkceChallengeS256 } from "../crypto";
import { HttpError } from "../errors";
import { deleteOAuthPendingSession, insertOAuthPendingSession, requireOAuthPendingSession } from "../db";
import type { SubscriptionCredential, SubscriptionCredentialMaterial } from "../auth/subscription-accounts";
import type { AppDependencies } from "../types";

/** xAI / Grok CLI OAuth (aligned with sub2api pkg/xai). */
export const GROK_OIDC_ISSUER = "https://auth.x.ai";
export const GROK_OAUTH_AUTHORIZE_URL = `${GROK_OIDC_ISSUER}/oauth2/authorize`;
export const GROK_OAUTH_TOKEN_URL = `${GROK_OIDC_ISSUER}/oauth2/token`;
export const GROK_OAUTH_DEFAULT_CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";
export const GROK_OAUTH_DEFAULT_REDIRECT_URI = "http://127.0.0.1:56121/callback";
export const GROK_OAUTH_SCOPE = "openid profile email offline_access grok-cli:access api:access";
export const GROK_OAUTH_PENDING_TTL_MS = 30 * 60 * 1000;

interface OidcDiscoveryDocument {
  token_endpoint?: unknown;
}

interface OidcTokenResponse {
  access_token?: unknown;
  refresh_token?: unknown;
  id_token?: unknown;
  expires_in?: unknown;
  error?: unknown;
}

export interface GrokOAuthPendingSession {
  id: string;
  state: string;
  code_verifier: string;
  redirect_uri: string;
  authorize_url: string;
  expires_at: string;
  client_id: string;
}

export function assertSupportedGrokOidcIssuer(issuer: string): void {
  if (issuer !== GROK_OIDC_ISSUER) {
    throw new HttpError(
      400,
      "Grok OIDC issuer is not supported",
      "invalid_request_error",
      "unsupported_grok_oidc_issuer"
    );
  }
}

export async function beginGrokOAuth(
  env: Env,
  options: { credential_account_id: string; redirect_uri?: string | null; client_id?: string | null },
  now = new Date()
): Promise<GrokOAuthPendingSession> {
  const redirectUri = options.redirect_uri?.trim() || GROK_OAUTH_DEFAULT_REDIRECT_URI;
  const clientId = options.client_id?.trim() || GROK_OAUTH_DEFAULT_CLIENT_ID;
  const stateBytes = new Uint8Array(32);
  const verifierBytes = new Uint8Array(32);
  crypto.getRandomValues(stateBytes);
  crypto.getRandomValues(verifierBytes);
  const state = base64UrlEncode(stateBytes);
  const codeVerifier = base64UrlEncode(verifierBytes);
  const challenge = await pkceChallengeS256(codeVerifier);
  const nonceBytes = new Uint8Array(16);
  crypto.getRandomValues(nonceBytes);
  const nonce = base64UrlEncode(nonceBytes);
  const params = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: GROK_OAUTH_SCOPE,
    state,
    nonce,
    code_challenge: challenge,
    code_challenge_method: "S256",
    plan: "generic",
    referrer: "mini-proxy"
  });
  const authorize_url = `${GROK_OAUTH_AUTHORIZE_URL}?${params.toString()}`;
  const id = generateId("oauth");
  const expires_at = new Date(now.getTime() + GROK_OAUTH_PENDING_TTL_MS).toISOString();
  // Store client_id in code_verifier column suffix? Better extend table - for now store as
  // provider=grok and put client_id in a JSON meta via code_verifier prefix is hacky.
  // Reuse redirect_uri field only; client_id is fixed constant unless overridden.
  // Store "client_id|code_verifier" if custom client needed:
  const verifierStored = clientId === GROK_OAUTH_DEFAULT_CLIENT_ID
    ? codeVerifier
    : `cid:${clientId}|${codeVerifier}`;
  await insertOAuthPendingSession(env, {
    id,
    provider: "grok",
    state,
    codeVerifier: verifierStored,
    redirectUri,
    credentialAccountId: options.credential_account_id,
    createdAt: nowIso(now),
    expiresAt: expires_at
  });
  return {
    id,
    state,
    code_verifier: codeVerifier,
    redirect_uri: redirectUri,
    authorize_url,
    expires_at,
    client_id: clientId
  };
}

export async function completeGrokOAuth(
  env: Env,
  deps: AppDependencies,
  input: {
    session_id?: string | null;
    state?: string | null;
    code?: string | null;
    callback_url?: string | null;
  },
  credentialAccountId: string,
  now = new Date()
): Promise<SubscriptionCredentialMaterial & { oidc_issuer: string; oidc_client_id: string }> {
  const pending = await requireOAuthPendingSession(env, "grok", input, credentialAccountId, now);
  let clientId = GROK_OAUTH_DEFAULT_CLIENT_ID;
  let codeVerifier = pending.code_verifier;
  if (codeVerifier.startsWith("cid:")) {
    const pipe = codeVerifier.indexOf("|");
    if (pipe > 0) {
      clientId = codeVerifier.slice(4, pipe);
      codeVerifier = codeVerifier.slice(pipe + 1);
    }
  }

  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: clientId,
    code: pending.code,
    redirect_uri: pending.redirect_uri,
    code_verifier: codeVerifier
  });
  let response: Response;
  try {
    response = await deps.fetch(GROK_OAUTH_TOKEN_URL, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body,
      redirect: "manual"
    });
  } catch {
    throw new HttpError(502, "Grok OAuth code exchange failed", "upstream_error", "grok_oauth_exchange_failed");
  }
  const raw = await response.text();
  await deleteOAuthPendingSession(env, pending.id);
  let parsed: OidcTokenResponse;
  try {
    parsed = JSON.parse(raw) as OidcTokenResponse;
  } catch {
    throw new HttpError(502, "Grok OAuth token response invalid JSON", "upstream_error", "grok_oauth_exchange_failed");
  }
  if (!response.ok || typeof parsed.access_token !== "string" || !parsed.access_token) {
    throw new HttpError(
      502,
      `Grok OAuth code exchange failed with status ${response.status}`,
      "upstream_error",
      "grok_oauth_exchange_failed"
    );
  }
  const expiresIn = typeof parsed.expires_in === "number" && Number.isFinite(parsed.expires_in) && parsed.expires_in > 0
    ? parsed.expires_in
    : undefined;
  return {
    access_token: parsed.access_token,
    refresh_token: typeof parsed.refresh_token === "string" && parsed.refresh_token ? parsed.refresh_token : undefined,
    id_token: typeof parsed.id_token === "string" && parsed.id_token ? parsed.id_token : undefined,
    expires_at: expiresIn ? addSecondsIso(expiresIn, now) : undefined,
    oidc_issuer: GROK_OIDC_ISSUER,
    oidc_client_id: clientId
  };
}

export async function refreshGrokOidcToken(
  deps: AppDependencies,
  credential: SubscriptionCredential,
  now = new Date()
): Promise<SubscriptionCredential> {
  if (!credential.refresh_token || !credential.oidc_issuer || !credential.oidc_client_id) {
    throw new HttpError(
      401,
      "Grok OIDC refresh material is incomplete",
      "authentication_error",
      "missing_grok_oidc_metadata"
    );
  }
  assertSupportedGrokOidcIssuer(credential.oidc_issuer);

  const discoveryUrl = `${GROK_OIDC_ISSUER}/.well-known/openid-configuration`;
  const discovery = await fetchForRefresh(deps, discoveryUrl, {
    method: "GET",
    headers: { Accept: "application/json" },
    redirect: "manual"
  });
  if (!discovery.ok) {
    throw transientRefreshFailure();
  }

  const discoveryBody = await parseJson<OidcDiscoveryDocument>(discovery);
  const tokenEndpoint = validateTokenEndpoint(discoveryBody.token_endpoint);
  const response = await fetchForRefresh(deps, tokenEndpoint, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: credential.refresh_token,
      client_id: credential.oidc_client_id
    }),
    redirect: "manual"
  });
  const parsed = await parseJson<OidcTokenResponse>(response);

  if (parsed.error === "invalid_grant" || parsed.error === "invalid_client") {
    throw new HttpError(
      401,
      "Grok credential requires reauthorization",
      "authentication_error",
      parsed.error
    );
  }
  if (!response.ok) {
    throw transientRefreshFailure();
  }

  if (typeof parsed.access_token !== "string" || !parsed.access_token) {
    throw transientRefreshFailure();
  }
  const rotatedRefreshToken = typeof parsed.refresh_token === "string" && parsed.refresh_token
    ? parsed.refresh_token
    : credential.refresh_token;
  const expiresIn = typeof parsed.expires_in === "number"
    && Number.isFinite(parsed.expires_in)
    && parsed.expires_in > 0
    ? parsed.expires_in
    : undefined;

  return {
    ...credential,
    access_token: parsed.access_token,
    refresh_token: rotatedRefreshToken,
    expires_at: expiresIn ? addSecondsIso(expiresIn, now) : credential.expires_at,
    status: "active",
    last_refresh_at: nowIso(now)
  };
}

async function fetchForRefresh(
  deps: AppDependencies,
  input: string,
  init: RequestInit
): Promise<Response> {
  try {
    return await deps.fetch(input, init);
  } catch {
    throw transientRefreshFailure();
  }
}

async function parseJson<T>(response: Response): Promise<T> {
  try {
    return JSON.parse(await response.text()) as T;
  } catch {
    throw transientRefreshFailure();
  }
}

function validateTokenEndpoint(value: unknown): string {
  if (typeof value !== "string") {
    throw transientRefreshFailure();
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw transientRefreshFailure();
  }
  if (
    url.protocol !== "https:"
    || url.origin !== GROK_OIDC_ISSUER
    || url.username
    || url.password
    || url.hash
  ) {
    throw transientRefreshFailure();
  }
  return url.toString();
}

function transientRefreshFailure(): HttpError {
  return new HttpError(
    502,
    "Grok token refresh failed",
    "upstream_error",
    "grok_token_refresh_failed"
  );
}

