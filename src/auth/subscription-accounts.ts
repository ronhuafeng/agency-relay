/**
 * Current Subscription Account metadata and credential drivers.
 * D1 holds non-secret current state only; Durable Objects hold encrypted tokens.
 */
import { generateId, nowIso } from "../crypto";
import { HttpError } from "../errors";
import {
  assertSupportedGrokOidcIssuer,
  refreshGrokOidcToken
} from "../grok/oauth";
import type { AppDependencies } from "../types";

/**
 * Product + D1 capability sources.
 * ChatGPT uses codex_auths; subscription credentials are Grok-only.
 * Issuable subscription credentials: Grok only.
 */
export type CapabilitySource = "chatgpt" | "grok";
export type SubscriptionEnvironment = "staging" | "production";
export type SubscriptionAccountStatus =
  | "pending_credential"
  | "active"
  | "reauth_required"
  | "revoked"
  | "disabled"
  | "degraded";

export interface SubscriptionAccountRow {
  id: string;
  capability_source: CapabilitySource;
  environment: SubscriptionEnvironment;
  label: string;
  status: SubscriptionAccountStatus;
  provider_account_ref: string | null;
  expires_at: string | null;
  refresh_available: number;
  last_refresh_at: string | null;
  reauth_required_at: string | null;
  last_success_at: string | null;
  last_failure_at: string | null;
  last_test_at: string | null;
  last_test_status: string | null;
  created_at: string;
  updated_at: string;
}

export interface SubscriptionCredential {
  account_id: string;
  capability_source: CapabilitySource;
  access_token: string;
  refresh_token?: string;
  id_token?: string;
  oidc_issuer?: string;
  oidc_client_id?: string;
  expires_at?: string;
  account_ref?: string;
  email?: string;
  status: SubscriptionAccountStatus;
  last_refresh_at?: string;
}

export interface FreshSubscriptionCredential {
  access_token: string;
  account_ref?: string;
}

export interface SubscriptionCredentialDriver {
  source: CapabilitySource;
  normalizeImport(input: Record<string, unknown>): SubscriptionCredentialMaterial;
  refresh(
    env: Env,
    deps: AppDependencies,
    credential: SubscriptionCredential,
    now: Date
  ): Promise<SubscriptionCredential>;
  classifyRefreshFailure(error: unknown): { permanent: boolean; code: string };
}

export interface SubscriptionCredentialMaterial {
  access_token: string;
  refresh_token?: string;
  id_token?: string;
  oidc_issuer?: string;
  oidc_client_id?: string;
  expires_at?: string;
  account_ref?: string;
  email?: string;
}

const ACTIVE_STATUSES = new Set(["active", "reauth_required", "degraded"]);

export function publicSubscriptionAccount(row: SubscriptionAccountRow) {
  return {
    id: row.id,
    capability_source: row.capability_source,
    environment: row.environment,
    label: row.label,
    status: row.status,
    provider_account_ref: row.provider_account_ref,
    expires_at: row.expires_at,
    refresh_available: row.refresh_available === 1,
    last_refresh_at: row.last_refresh_at,
    reauth_required_at: row.reauth_required_at,
    last_success_at: row.last_success_at,
    last_failure_at: row.last_failure_at,
    last_test_at: row.last_test_at,
    last_test_status: row.last_test_status,
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}

export async function listSubscriptionAccounts(env: Env): Promise<SubscriptionAccountRow[]> {
  const result = await env.DB.prepare(
    `SELECT * FROM subscription_accounts ORDER BY capability_source ASC, environment ASC, created_at ASC`
  ).all<SubscriptionAccountRow>();
  return result.results ?? [];
}

export async function getSubscriptionAccount(env: Env, id: string): Promise<SubscriptionAccountRow | null> {
  return env.DB.prepare(`SELECT * FROM subscription_accounts WHERE id = ?`).bind(id).first<SubscriptionAccountRow>();
}

export async function createSubscriptionAccount(
  env: Env,
  input: {
    capability_source: CapabilitySource;
    environment: SubscriptionEnvironment;
    label: string;
    provider_account_ref?: string | null;
  },
  now = new Date()
): Promise<SubscriptionAccountRow> {
  assertCapabilitySource(input.capability_source);
  assertEnvironment(input.environment);
  // Create without encrypted material as pending — not usable for model traffic until import.
  const id = generateId("sub");
  const ts = nowIso(now);
  await env.DB.prepare(
    `INSERT INTO subscription_accounts (
      id, capability_source, environment, label, status,
      provider_account_ref, expires_at, refresh_available,
      last_refresh_at, reauth_required_at, last_success_at, last_failure_at,
      last_test_at, last_test_status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'pending_credential', ?, NULL, 0, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?)`
  ).bind(
    id,
    input.capability_source,
    input.environment,
    input.label.trim() || `${input.capability_source}-${input.environment}`,
    input.provider_account_ref ?? null,
    ts,
    ts
  ).run();
  const row = await getSubscriptionAccount(env, id);
  if (!row) {
    throw new HttpError(500, "Failed to create Subscription Account", "server_error", "subscription_create_failed");
  }
  return row;
}

export async function readSubscriptionAccountStatus(env: Env, id: string): Promise<string | null> {
  const row = await env.DB.prepare("SELECT status FROM subscription_accounts WHERE id = ?")
    .bind(id)
    .first<{ status: string }>();
  return row?.status ?? null;
}

/** Refresh projection. Administrative terminal status stays authoritative. */
export async function projectSubscriptionRefreshIfMutable(
  env: Env,
  id: string,
  patch: {
    status: SubscriptionAccountStatus;
    provider_account_ref: string | null;
    expires_at: string | null;
    refresh_available: boolean;
    last_refresh_at: string | null;
    reauth_required_at: string | null;
  },
  now = new Date()
): Promise<boolean> {
  const result = await env.DB.prepare(
    `UPDATE subscription_accounts SET
       status = ?,
       provider_account_ref = ?,
       expires_at = ?,
       refresh_available = ?,
       last_refresh_at = ?,
       reauth_required_at = ?,
       updated_at = ?
     WHERE id = ? AND status NOT IN ('revoked', 'disabled', 'retiring')`
  ).bind(
    patch.status,
    patch.provider_account_ref,
    patch.expires_at,
    patch.refresh_available ? 1 : 0,
    patch.last_refresh_at,
    patch.reauth_required_at,
    nowIso(now),
    id
  ).run();
  return (result.meta?.changes ?? 0) > 0;
}

export async function markSubscriptionReauthRequiredIfMutable(env: Env, id: string, now = new Date()): Promise<boolean> {
  const at = nowIso(now);
  const result = await env.DB.prepare(
    `UPDATE subscription_accounts
     SET status = 'reauth_required', reauth_required_at = ?, updated_at = ?
     WHERE id = ? AND status NOT IN ('revoked', 'disabled', 'retiring')`
  ).bind(at, at, id).run();
  return (result.meta?.changes ?? 0) > 0;
}

export async function updateSubscriptionAccountMetadata(
  env: Env,
  id: string,
  patch: Partial<{
    status: SubscriptionAccountStatus;
    provider_account_ref: string | null;
    expires_at: string | null;
    refresh_available: boolean;
    last_refresh_at: string | null;
    reauth_required_at: string | null;
    last_success_at: string | null;
    last_failure_at: string | null;
    last_test_at: string | null;
    last_test_status: string | null;
  }>,
  now = new Date()
): Promise<void> {
  const current = await getSubscriptionAccount(env, id);
  if (!current) {
    throw new HttpError(404, "Subscription Account not found", "invalid_request_error", "subscription_not_found");
  }
  await env.DB.prepare(
    `UPDATE subscription_accounts SET
      status = ?,
      provider_account_ref = ?,
      expires_at = ?,
      refresh_available = ?,
      last_refresh_at = ?,
      reauth_required_at = ?,
      last_success_at = ?,
      last_failure_at = ?,
      last_test_at = ?,
      last_test_status = ?,
      updated_at = ?
     WHERE id = ?`
  ).bind(
    patch.status ?? current.status,
    patch.provider_account_ref !== undefined ? patch.provider_account_ref : current.provider_account_ref,
    patch.expires_at !== undefined ? patch.expires_at : current.expires_at,
    patch.refresh_available !== undefined ? (patch.refresh_available ? 1 : 0) : current.refresh_available,
    patch.last_refresh_at !== undefined ? patch.last_refresh_at : current.last_refresh_at,
    patch.reauth_required_at !== undefined ? patch.reauth_required_at : current.reauth_required_at,
    patch.last_success_at !== undefined ? patch.last_success_at : current.last_success_at,
    patch.last_failure_at !== undefined ? patch.last_failure_at : current.last_failure_at,
    patch.last_test_at !== undefined ? patch.last_test_at : current.last_test_at,
    patch.last_test_status !== undefined ? patch.last_test_status : current.last_test_status,
    nowIso(now),
    id
  ).run();
}

/** Monotonic operational stamp for an actual Provider Attempt. */
export async function stampSubscriptionProviderAttempt(
  env: Env,
  id: string,
  result: "success" | "failure",
  now = new Date()
): Promise<void> {
  const timestamp = nowIso(now);
  const column = result === "success" ? "last_success_at" : "last_failure_at";
  await env.DB.prepare(
    `UPDATE subscription_accounts
     SET ${column} = CASE
           WHEN ${column} IS NULL OR ${column} < ? THEN ?
           ELSE ${column}
         END,
         updated_at = CASE
           WHEN updated_at < ? THEN ?
           ELSE updated_at
         END
     WHERE id = ?`
  ).bind(timestamp, timestamp, timestamp, timestamp, id).run();
}

/** Subscription DO drivers — Grok only (ChatGPT uses codex_auths). */
export function driverFor(source: CapabilitySource): SubscriptionCredentialDriver {
  if (source === "grok") {
    return grokDriver;
  }
  throw new HttpError(
    400,
    "Subscription credentials support grok only; use /admin/codex-auths for Official ChatGPT",
    "invalid_request_error",
    "invalid_capability_source"
  );
}

const grokDriver: SubscriptionCredentialDriver = {
  source: "grok",
  normalizeImport(input) {
    const access_token = requiredString(input, "access_token");
    const refresh_token = optionalString(input, "refresh_token");
    const oidc_issuer = optionalString(input, "oidc_issuer");
    const oidc_client_id = optionalString(input, "oidc_client_id");
    const hasAnyRefreshMaterial = Boolean(refresh_token || oidc_issuer || oidc_client_id);
    const hasCompleteRefreshMaterial = Boolean(refresh_token && oidc_issuer && oidc_client_id);
    if (hasAnyRefreshMaterial && !hasCompleteRefreshMaterial) {
      throw new HttpError(
        400,
        "Grok OIDC refresh requires refresh_token, oidc_issuer, and oidc_client_id",
        "invalid_request_error",
        "incomplete_grok_oidc_refresh_material"
      );
    }
    if (oidc_issuer) {
      assertSupportedGrokOidcIssuer(oidc_issuer);
    }
    return {
      access_token,
      refresh_token,
      oidc_issuer,
      oidc_client_id,
      expires_at: optionalString(input, "expires_at"),
      account_ref: optionalString(input, "account_ref")
    };
  },
  async refresh(_env, deps, credential, now) {
    return refreshGrokOidcToken(deps, credential, now);
  },
  classifyRefreshFailure(error) {
    if (error instanceof HttpError) {
      if (
        error.code === "reauth_required"
        || error.code === "missing_grok_oidc_metadata"
        || error.code === "unsupported_grok_oidc_issuer"
        || error.code === "invalid_grant"
        || error.code === "invalid_client"
      ) {
        return { permanent: true, code: error.code };
      }
    }
    return { permanent: false, code: "grok_token_refresh_failed" };
  }
};

function assertCapabilitySource(value: string): asserts value is CapabilitySource {
  if (value !== "grok") {
    throw new HttpError(
      400,
      "capability_source must be grok (ChatGPT uses /admin/codex-auths)",
      "invalid_request_error",
      "invalid_capability_source"
    );
  }
}

function assertEnvironment(value: string): asserts value is SubscriptionEnvironment {
  if (value !== "staging" && value !== "production") {
    throw new HttpError(400, "environment must be staging or production", "invalid_request_error", "invalid_environment");
  }
}

function requiredString(input: Record<string, unknown>, field: string): string {
  const value = input[field];
  if (typeof value !== "string" || !value.trim()) {
    throw new HttpError(400, `${field} is required`, "invalid_request_error", `missing_${field}`);
  }
  return value.trim();
}

function optionalString(input: Record<string, unknown>, field: string): string | undefined {
  const value = input[field];
  if (typeof value !== "string" || !value.trim()) {
    return undefined;
  }
  return value.trim();
}

export { ACTIVE_STATUSES };
