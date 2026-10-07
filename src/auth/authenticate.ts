import { findEndUserAuthByKeyPrefix, touchApiKey } from "../db";
import { HttpError } from "../errors";
import { hmacSha256Hex, keyPrefix, parseIsoMillis, timingSafeEqualHex, timingSafeEqualString } from "../crypto";
import { ISSUABLE_SURFACE_GRANTS } from "../plans/execution-plans";
import type { AuthenticatedUser } from "../types";
import { keyIsExpired } from "./key-state";
import { readConsoleSessionPrincipal } from "./console-session";
import type { ConsolePrincipal } from "./principal";

export interface AdminIdentity {
  kind: "admin_secret" | "console";
  email: string | null;
  subject: string | null;
  userId?: string | null;
  role?: "admin" | "user" | null;
  sessionEpoch?: number;
}

export interface EndUserAuthorization {
  /** Exact surface grant required by the resolved Execution Plan. */
  requiredSurfaceGrant: string;
}

const API_KEY_TOUCH_INTERVAL_MS = 5 * 60 * 1000;

export async function requireOperator(request: Request, env: Env): Promise<AdminIdentity> {
  const candidate = bearerToken(request) ?? "";
  if (env.ADMIN_SECRET && candidate && timingSafeEqualString(candidate, env.ADMIN_SECRET)) {
    return { kind: "admin_secret", email: null, subject: null, userId: null, role: null };
  }
  throw new HttpError(403, "Admin authentication required", "authentication_error", "admin_auth_required");
}

export async function verifyConsoleAccess(request: Request, env: Env, now = new Date()): Promise<ConsolePrincipal | null> {
  return readConsoleSessionPrincipal(env, request, now);
}

export async function authenticateEndUser(
  request: Request,
  env: Env,
  ctx: Pick<ExecutionContext, "waitUntil">,
  authorization: EndUserAuthorization,
  now = new Date()
): Promise<AuthenticatedUser> {
  const plaintext = endUserCredential(request);
  if (!plaintext) {
    throw new HttpError(401, "Missing bearer token", "authentication_error", "missing_bearer_token");
  }
  const candidate = await findEndUserAuthByKeyPrefix(env, keyPrefix(plaintext));
  if (!candidate || candidate.apiKey.status !== "active") {
    throw new HttpError(401, "Invalid API key", "authentication_error", "invalid_api_key");
  }

  const actualHash = await hmacSha256Hex(env.API_KEY_HASH_PEPPER, plaintext);
  if (!timingSafeEqualHex(actualHash, candidate.apiKey.key_hash)) {
    throw new HttpError(401, "Invalid API key", "authentication_error", "invalid_api_key");
  }

  if (keyIsExpired(candidate.apiKey, now.getTime())) {
    throw new HttpError(401, "API key expired", "authentication_error", "api_key_expired");
  }

  // Current invariant: surface grants only; no route-profile compatibility bridge.
  if (!authorizeScopes(candidate.apiKey.scopes, authorization.requiredSurfaceGrant).ok) {
    throw new HttpError(403, "API key scope denied", "authentication_error", "scope_denied");
  }

  const user = candidate.user;
  if (!user || user.status !== "active") {
    throw new HttpError(403, "User is not active", "authentication_error", "user_inactive");
  }

  const lastUsedAt = parseIsoMillis(candidate.apiKey.last_used_at);
  const staleBefore = new Date(now.getTime() - API_KEY_TOUCH_INTERVAL_MS);
  if (lastUsedAt === undefined || lastUsedAt < staleBefore.getTime()) {
    ctx.waitUntil(
      touchApiKey(env, candidate.apiKey.id, staleBefore, now).catch(() => {
        console.error(JSON.stringify({ event: "api_key_touch_failed" }));
      })
    );
  }
  return { user, apiKey: candidate.apiKey };
}

export function authorizeScopes(
  rawScopes: string,
  requiredSurfaceGrant: string
): { ok: boolean } {
  const scopes = parseScopes(rawScopes);
  return { ok: scopes.includes(requiredSurfaceGrant) };
}

/** Validate grants for new key issuance — surface+env only, non-empty. */
export function assertIssuableSurfaceGrants(grants: string[]): string[] {
  if (grants.length === 0) {
    throw new HttpError(
      400,
      "Scopes must be a non-empty list of surface:<surface>:<environment> grants",
      "invalid_request_error",
      "missing_surface_grants"
    );
  }
  for (const grant of grants) {
    if (!ISSUABLE_SURFACE_GRANTS.has(grant)) {
      throw new HttpError(
        400,
        `Invalid or non-issuable grant: ${grant}`,
        "invalid_request_error",
        "invalid_surface_grants"
      );
    }
  }
  return grants;
}

function bearerToken(request: Request): string | undefined {
  const header = request.headers.get("Authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1]?.trim() || undefined;
}

function endUserCredential(request: Request): string | undefined {
  return bearerToken(request);
}

function parseScopes(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) {
      return parsed.filter((scope): scope is string => typeof scope === "string");
    }
  } catch {
    return [];
  }
  return [];
}

export function parseApiKeyScopes(raw: string): string[] {
  return parseScopes(raw);
}
