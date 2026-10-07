import { organizationDomain, isOrganizationLoginUser, type ConsolePrincipal } from "./principal";
import { HttpError } from "../errors";
import { base64UrlEncode, hmacSha256Hex, nowIso, parseIsoMillis } from "../crypto";

export const CONSOLE_COOKIE = "__Host-mini-console";
const SESSION_SECONDS = 8 * 60 * 60;

export async function createConsoleSession(env: Env, principal: Pick<ConsolePrincipal, "id" | "email" | "sessionEpoch">, now = new Date()): Promise<string> {
  if (!isOrganizationLoginUser(env, { canonical_email: principal.email, login_capable: 1, account_kind: "human" })) {
    throw new HttpError(403, "The login identity changed. Sign in again.", "authentication_error", "console_identity_changed");
  }
  const token = base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)));
  const expires = new Date(now.getTime() + SESSION_SECONDS * 1000);
  // The identity snapshot comes from verified login resolution. Never upgrade a stale
  // login to a newer epoch after email migration or disable/re-enable.
  const result = await env.DB.prepare(
    `INSERT INTO console_sessions (token_hash, user_id, expires_at, created_at, session_epoch)
     SELECT ?1, id, ?2, ?3, console_session_epoch FROM users
     WHERE id = ?4 AND canonical_email = ?5 AND console_session_epoch = ?6
       AND status = 'active' AND account_kind = 'human' AND login_capable = 1 AND role IN ('admin', 'user')
       AND substr(canonical_email, instr(canonical_email, '@') + 1) = ?7`
  ).bind(await hmacSha256Hex(env.API_KEY_HASH_PEPPER, token), nowIso(expires), nowIso(now),
    principal.id, principal.email, principal.sessionEpoch, organizationDomain(env) ?? "").run();
  if (result.meta.changes !== 1) {
    throw new HttpError(403, "The login identity changed. Sign in again.", "authentication_error", "console_identity_changed");
  }
  return token;
}

export function consoleSessionCookie(token: string, maxAge = SESSION_SECONDS): string {
  return `${CONSOLE_COOKIE}=${token}; HttpOnly; Secure; Path=/; SameSite=Lax; Max-Age=${maxAge}`;
}

export function clearConsoleSessionCookie(): string {
  return `${CONSOLE_COOKIE}=; HttpOnly; Secure; Path=/; SameSite=Lax; Max-Age=0`;
}

export function consoleCookieToken(request: Request): string | null {
  const header = request.headers.get("Cookie") ?? "";
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator === -1) continue;
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (name === CONSOLE_COOKIE && value) return value;
  }
  return null;
}

export async function readConsoleSessionPrincipal(env: Env, request: Request, now = new Date()): Promise<ConsolePrincipal | null> {
  const token = consoleCookieToken(request);
  if (!token) return null;
  const tokenHash = await hmacSha256Hex(env.API_KEY_HASH_PEPPER, token);
  return readConsoleSessionPrincipalByHash(env, tokenHash, now);
}

/** Internal long-lived subscribers recheck the same session without retaining its bearer cookie. */
export async function readConsoleSessionPrincipalByHash(env: Env, tokenHash: string, now = new Date()): Promise<ConsolePrincipal | null> {
  // Session validity and the current principal are one database snapshot. Splitting
  // this into session -> user reads lets a migrated identity accept an old cookie.
  const row = await env.DB.prepare(
    `SELECT u.id, u.canonical_email, u.role, u.console_session_epoch, s.expires_at
     FROM console_sessions AS s JOIN users AS u ON u.id = s.user_id
     WHERE s.token_hash = ? AND s.session_epoch = u.console_session_epoch
       AND u.status = 'active' AND u.account_kind = 'human' AND u.login_capable = 1
       AND substr(u.canonical_email, instr(u.canonical_email, '@') + 1) = ?
       AND u.role IN ('admin', 'user')`
  ).bind(tokenHash, organizationDomain(env) ?? "").first<{ id: string; canonical_email: string; role: "admin" | "user"; console_session_epoch: number; expires_at: string }>();
  const expires = parseIsoMillis(row?.expires_at);
  if (!row || expires === undefined || expires <= now.getTime() || !isOrganizationLoginUser(env, { canonical_email: row.canonical_email, login_capable: 1, account_kind: "human" })) return null;
  return { id: row.id, email: row.canonical_email, role: row.role, status: "active", sessionEpoch: row.console_session_epoch };
}

export async function deleteConsoleSession(env: Env, request: Request): Promise<void> {
  const token = consoleCookieToken(request);
  if (!token) return;
  await env.DB.prepare(`DELETE FROM console_sessions WHERE token_hash = ?`)
    .bind(await hmacSha256Hex(env.API_KEY_HASH_PEPPER, token)).run();
}
