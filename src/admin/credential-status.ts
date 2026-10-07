import { HttpError, jsonResponse } from "../errors";
import { consoleCookieToken } from "../auth/console-session";
import { hmacSha256Hex } from "../crypto";
import { credentialEvents } from "./credential-notifications";
import { operatorHintForState, projectStoredState, humanStatusLabel, statusToneForState } from "./auth-management";

export async function credentialStatusResponse(env: Env, actorId: string, now: Date): Promise<Response> {
  const result = await env.DB.prepare(`
    SELECT 'codex:' || id AS key, status, expires_at, last_refresh_at FROM codex_auths
    UNION ALL SELECT 'grok:' || id AS key, status, expires_at, last_refresh_at FROM subscription_accounts
    ORDER BY key LIMIT 1001
  `).all<{ key: string; status: string; expires_at: string | null; last_refresh_at: string | null }>();
  if (!result.success || result.results.length > 1000) throw new HttpError(503, "Credential status unavailable", "server_error", "credential_status_unavailable");
  const accounts = result.results.map(row => {
    const state = projectStoredState(row.status, row.expires_at, now.getTime());
    return { key: row.key, state, statusLabel: humanStatusLabel(state), tone: statusToneForState(state), hint: operatorHintForState(state), expiresAt: row.expires_at, lastRefreshAt: row.last_refresh_at };
  });
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(accounts)));
  const revision = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
  return jsonResponse({ actorId, accounts, revision }, { headers: { "Cache-Control": "no-store" } });
}

export async function credentialEventsResponse(request: Request, env: Env): Promise<Response> {
  if (request.headers.get("Origin") !== new URL(request.url).origin || request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
    throw new HttpError(403, "Same-origin WebSocket required", "authentication_error", "credential_events_denied");
  }
  const token = consoleCookieToken(request);
  if (!token) throw new HttpError(403, "Console session required", "authentication_error", "admin_auth_required");
  if (!env.CREDENTIAL_EVENTS) throw new HttpError(503, "Notifications unavailable", "server_error", "credential_events_unavailable");
  const sessionHash = await hmacSha256Hex(env.API_KEY_HASH_PEPPER, token);
  return credentialEvents(env).fetch(new Request("https://credential-events.internal/", {
    headers: { Upgrade: "websocket", "X-Mini-Session-Hash": sessionHash }
  }));
}
