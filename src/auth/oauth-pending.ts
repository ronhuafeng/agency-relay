import { parseOAuthCallback } from "../crypto";
import { HttpError } from "../errors";

export async function insertOAuthPendingSession(
  env: Env,
  row: {
    id: string;
    provider: "codex" | "grok";
    state: string;
    codeVerifier: string;
    redirectUri: string;
    credentialAccountId: string;
    createdAt: string;
    expiresAt: string;
  }
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO oauth_pending_sessions
       (id, provider, state, code_verifier, redirect_uri,
        credential_account_id, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    row.id,
    row.provider,
    row.state,
    row.codeVerifier,
    row.redirectUri,
    row.credentialAccountId,
    row.createdAt,
    row.expiresAt
  ).run();
}

export async function deleteOAuthPendingSession(env: Env, id: string): Promise<void> {
  await env.DB.prepare("DELETE FROM oauth_pending_sessions WHERE id = ?").bind(id).run();
}

export async function requireOAuthPendingSession(
  env: Env,
  provider: "codex" | "grok",
  input: {
    session_id?: string | null;
    state?: string | null;
    code?: string | null;
    callback_url?: string | null;
  },
  accountId: string,
  now: Date
): Promise<{ id: string; code: string; redirect_uri: string; code_verifier: string }> {
  const fromCallback = parseOAuthCallback(input.callback_url);
  const code = (input.code ?? fromCallback.code)?.trim();
  const state = (input.state ?? fromCallback.state)?.trim();
  if (!code || !state) {
    throw new HttpError(400, "OAuth code and state are required (or pass callback_url)", "invalid_request_error", "missing_oauth_code");
  }
  const pending = await env.DB.prepare(
    `SELECT id, code_verifier, redirect_uri, credential_account_id, expires_at
     FROM oauth_pending_sessions WHERE provider = ? AND state = ? LIMIT 1`
  ).bind(provider, state).first<{
    id: string;
    code_verifier: string;
    redirect_uri: string;
    credential_account_id: string | null;
    expires_at: string;
  }>();
  if (!pending) {
    throw new HttpError(400, "OAuth session not found or expired", "invalid_request_error", "oauth_session_not_found");
  }
  if (Date.parse(pending.expires_at) <= now.getTime()) {
    await deleteOAuthPendingSession(env, pending.id);
    throw new HttpError(400, "OAuth session expired; start again", "invalid_request_error", "oauth_session_expired");
  }
  if (input.session_id && input.session_id !== pending.id) {
    throw new HttpError(400, "OAuth session_id does not match state", "invalid_request_error", "oauth_session_mismatch");
  }
  if (pending.credential_account_id !== accountId) {
    throw new HttpError(400, "OAuth session belongs to another Credential Account", "invalid_request_error", "oauth_account_mismatch");
  }
  return { id: pending.id, code, redirect_uri: pending.redirect_uri, code_verifier: pending.code_verifier };
}
