import { HttpError } from "../errors";

export type TokenFailureSource = "input" | "stored" | "provider" | "lifecycle";

export interface TokenAuthorityError {
  source: TokenFailureSource;
  status: 400 | 401 | 409 | 500 | 502;
  code: string;
}

export type TokenResult<T> = { ok: true; value: T } | { ok: false; error: TokenAuthorityError };

const EXPECTED: Record<string, TokenFailureSource> = {
  "400:missing_auth_id": "input",
  "400:missing_account_id": "input",
  "400:missing_access_token": "input",
  "400:invalid_capability_source": "input",
  "401:missing_access_token": "stored",
  "401:missing_codex_auth": "stored",
  "401:missing_subscription_credential": "stored",
  "401:missing_refresh_token": "stored",
  "401:missing_grok_oidc_metadata": "stored",
  "401:reauth_required": "stored",
  "401:codex_auth_inactive": "stored",
  "401:subscription_inactive": "stored",
  "401:invalid_grant": "provider",
  "401:invalid_client": "provider",
  "409:credential_lifecycle_changed": "lifecycle",
  "500:unsupported_token_kid": "stored",
  "502:codex_token_refresh_failed": "provider",
  "502:invalid_token_response": "provider",
  "502:missing_access_token": "provider",
  "502:grok_token_refresh_failed": "provider"
};

const PUBLIC_MESSAGE: Record<string, string> = {
  missing_auth_id: "auth_id is required",
  missing_account_id: "account_id is required",
  missing_access_token: "Credential is missing an access token",
  invalid_capability_source: "capability_source is invalid",
  missing_codex_auth: "Codex auth is not configured",
  missing_subscription_credential: "Subscription credential is not configured",
  missing_refresh_token: "Credential does not have a refresh token",
  missing_grok_oidc_metadata: "Grok OIDC refresh material is incomplete",
  reauth_required: "Credential requires reauthorization",
  codex_auth_inactive: "Codex auth is not active",
  subscription_inactive: "Subscription account is not active",
  invalid_grant: "Credential requires reauthorization",
  invalid_client: "Credential requires reauthorization",
  credential_lifecycle_changed: "Credential changed during refresh",
  unsupported_token_kid: "Unsupported token encryption key version",
  codex_token_refresh_failed: "Codex token refresh failed",
  invalid_token_response: "Codex token response was invalid",
  grok_token_refresh_failed: "Grok token refresh failed"
};

export function tokenResultFromThrown(error: unknown): TokenAuthorityError | null {
  if (!(error instanceof HttpError) || !error.code) return null;
  const source = EXPECTED[`${error.status}:${error.code}`];
  if (!source) return null;
  if (error.status !== 400 && error.status !== 401 && error.status !== 409 && error.status !== 500 && error.status !== 502) {
    return null;
  }
  return { source, status: error.status, code: error.code };
}

export function readTokenResult<T>(result: TokenResult<T>): T {
  if (result.ok) return result.value;
  const code = result.error.code;
  const type = result.error.status === 401 || result.error.status === 409
    ? "authentication_error"
    : result.error.status === 400
      ? "invalid_request_error"
      : result.error.status === 500
        ? "server_error"
        : "upstream_error";
  throw new HttpError(result.error.status, PUBLIC_MESSAGE[code] ?? "Credential request failed", type, code);
}
