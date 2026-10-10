import { generateId, nowIso } from "../crypto";
import { readTokenResult } from "./token-result";
import { HttpError } from "../errors";
import type { SurfaceCredentialSelection } from "./bindings";
import { PROVIDER_RELAY_PROFILES } from "../plans/execution-plans";
import { serviceAdminAuthorityBindings, serviceAdminAuthoritySql } from "./service-accounts";

export const PROVIDER_RESOURCE_BOUNDARY =
  "Changing the upstream account does not move provider-owned files, responses, jobs, or histories.";

export const XAI_SHARED_TEAM_BOUNDARY =
  "The xAI surface delegates the bound provider team's capabilities. It does not isolate those provider resources.";

const USABLE_STATUSES = ["active", "degraded"] as const;
const CODEX_REPLACEMENT_STATUSES = ["active"] as const;

/** Metadata eligibility, distinct from a live provider or encrypted-token probe. */
export function defaultCredentialMetadataUsable(status: string | null): boolean {
  return status !== null && (USABLE_STATUSES as readonly string[]).includes(status);
}
/** Replacement copies a usable production binding; token expiry may be refreshable. */
export function replacementCredentialMetadataUsable(surface: OrganizationSurface, account: {
  status: string; kind?: string; capability_source?: string; environment?: string;
} | null): boolean {
  if (!account || account.environment !== "production") return false;
  const codex = surface === "surface:codex:production";
  const statuses: readonly string[] = codex ? CODEX_REPLACEMENT_STATUSES : USABLE_STATUSES;
  return statuses.includes(account.status) && (codex ? account.kind === "shared" : account.capability_source === "grok");
}

/** The same metadata policy at the replacement's atomic SQL boundary. */
export function replacementCredentialMetadataSql(kind: CredentialKind, alias: string): string {
  const statuses = kind === "codex" ? CODEX_REPLACEMENT_STATUSES : USABLE_STATUSES;
  return `${alias}.environment = 'production'
    AND ${alias}.${kind === "codex" ? "kind = 'shared'" : "capability_source = 'grok'"}
    AND ${alias}.status IN (${statuses.map(status => `'${status}'`).join(",")})`;
}

export interface CredentialActor {
  sessionEpoch?: number;
  kind: "access" | "admin_secret";
  email: string | null;
  subject: string | null;
  userId: string | null;
  role: "admin" | "user" | null;
  requestId: string | null;
}

export function credentialActor(input: {
  actor: {
    kind: "admin_secret" | "console";
    email: string | null;
    subject: string | null;
    userId?: string | null;
    role?: "admin" | "user" | null;
    sessionEpoch?: number;
  };
  requestId: string | null;
}): CredentialActor {
  return {
    kind: input.actor.kind === "console" ? "access" : "admin_secret",
    email: input.actor.email,
    subject: input.actor.subject,
    userId: input.actor.userId ?? null,
    role: input.actor.role === "admin" || input.actor.role === "user" ? input.actor.role : null,
    requestId: input.requestId,
    sessionEpoch: input.actor.sessionEpoch
  };
}

export type CredentialKind = "codex" | "grok";
export type OrganizationSurface = SurfaceCredentialSelection["surface_grant"];

export interface ServiceAvailability {
  surface: "codex" | "grok" | "xai";
  available: boolean;
}

export interface RetirementPreview {
  account_id: string;
  kind: CredentialKind;
  status: string;
  live_keys: Array<{ id: string; key_prefix: string; family_id: string; surface_grant: string }>;
  default_surfaces: OrganizationSurface[];
  compatible_replacements: Array<{ id: string; label: string }>;
  provider_resources_not_migrated: string;
  shared_provider_authority?: string;
}

const SURFACES: OrganizationSurface[] = [
  PROVIDER_RELAY_PROFILES.codex.surfaceGrant,
  PROVIDER_RELAY_PROFILES.grok.surfaceGrant,
  PROVIDER_RELAY_PROFILES.xai.surfaceGrant
];

export async function readServiceAvailability(env: Env, probe: UsabilityProbe, now = new Date()): Promise<ServiceAvailability[]> {
  const selected = await readDefaultRows(env);
  const availability: ServiceAvailability[] = [];
  for (const surface of SURFACES) {
    const row = selected.find((candidate) => candidate.surface_grant === surface);
    availability.push({
      surface: surfaceId(surface),
      available: row ? await rowUsable(env, row, probe, now) : false
    });
  }
  return availability;
}

export async function readAdminCredentialDefaults(env: Env, probe: UsabilityProbe, now = new Date()) {
  const selected = await readDefaultRows(env);
  return Promise.all(SURFACES.map(async (surface) => {
    const row = selected.find((candidate) => candidate.surface_grant === surface);
    const accountId = row ? accountIdOf(row) : null;
    return {
      surface_grant: surface,
      credential_account_id: accountId,
      available: row ? await rowUsable(env, row, probe, now) : false,
      ...(surface === "surface:xai:production" ? { shared_provider_authority: XAI_SHARED_TEAM_BOUNDARY } : {}),
      provider_resources_not_migrated: PROVIDER_RESOURCE_BOUNDARY
    };
  }));
}

export async function commitCredentialDefault(
  env: Env,
  actor: CredentialActor,
  input: { surface_grant: OrganizationSurface; credential_account_id: string },
  now = new Date()
): Promise<void> {
  const at = nowIso(now);
  const changed = await audited(env, actor, {
    statement: (authority) => input.surface_grant === "surface:codex:production"
      ? `INSERT INTO organization_surface_credential_defaults (
           surface_grant, codex_auth_id, subscription_account_id, created_at, updated_at
         )
         SELECT ?, id, NULL, ?, ?
         FROM codex_auths
         WHERE id = ? AND kind = 'shared' AND environment = 'production'
           AND status IN ('active', 'degraded') AND ${authority}
         ON CONFLICT(surface_grant) DO UPDATE SET
           codex_auth_id = excluded.codex_auth_id,
           subscription_account_id = NULL,
           updated_at = excluded.updated_at`
      : `INSERT INTO organization_surface_credential_defaults (
           surface_grant, codex_auth_id, subscription_account_id, created_at, updated_at
         )
         SELECT ?, NULL, id, ?, ?
         FROM subscription_accounts
         WHERE id = ? AND capability_source = 'grok' AND environment = 'production'
           AND status IN ('active', 'degraded') AND ${authority}
         ON CONFLICT(surface_grant) DO UPDATE SET
           codex_auth_id = NULL,
           subscription_account_id = excluded.subscription_account_id,
           updated_at = excluded.updated_at`,
    bindings: [input.surface_grant, at, at, input.credential_account_id],
    action: "credential_default.set",
    targetId: input.surface_grant,
    meta: {
      surface_grant: input.surface_grant,
      credential_account_id: input.credential_account_id
    }
  }, at);
  if (!changed) {
    throw new HttpError(409, "The credential default is not a usable production account.", "invalid_request_error", "credential_default_unavailable");
  }
}

export async function selectIssuanceDefaults(
  env: Env,
  surfaces: readonly OrganizationSurface[],
  probe: UsabilityProbe,
  now = new Date()
): Promise<SurfaceCredentialSelection[]> {
  const selected = await readDefaultRows(env);
  const selections: SurfaceCredentialSelection[] = [];
  for (const surface of surfaces) {
    const row = selected.find((candidate) => candidate.surface_grant === surface);
    if (!row || !await rowUsable(env, row, probe, now)) {
      throw new HttpError(503, "A service needed for a new key is unavailable.", "server_error", "credential_default_unavailable");
    }
    const accountId = accountIdOf(row);
    if (!accountId) {
      throw new HttpError(503, "A service needed for a new key is unavailable.", "server_error", "credential_default_unavailable");
    }
    selections.push({ surface_grant: surface, credential_account_id: accountId });
  }
  return selections;
}

export async function previewCredentialRetirement(env: Env, kind: CredentialKind, accountId: string): Promise<RetirementPreview> {
  const account = await requireAccount(env, kind, accountId);
  const liveKeys = await liveBindings(env, kind, accountId);
  const defaults = (await readDefaultRows(env))
    .filter((row) => (kind === "codex" ? row.codex_auth_id : row.subscription_account_id) === accountId)
    .map((row) => row.surface_grant);
  const replacements = await compatibleReplacements(env, kind, accountId);
  const xai = kind === "grok" && (defaults.includes("surface:xai:production") || liveKeys.some((key) => key.surface_grant === "surface:xai:production"));
  return {
    account_id: accountId,
    kind,
    status: account.status,
    live_keys: liveKeys,
    default_surfaces: defaults,
    compatible_replacements: replacements,
    provider_resources_not_migrated: PROVIDER_RESOURCE_BOUNDARY,
    ...(xai ? { shared_provider_authority: XAI_SHARED_TEAM_BOUNDARY } : {})
  };
}

export async function migrateCredentialBindings(
  env: Env,
  actor: CredentialActor,
  input: {
    kind: CredentialKind;
    account_id: string;
    replacement_account_id: string;
    key_ids: readonly string[];
    default_surfaces: readonly OrganizationSurface[];
  },
  now = new Date()
): Promise<{ migrated_bindings: number; migrated_defaults: number }> {
  if (input.key_ids.length === 0 && input.default_surfaces.length === 0) {
    throw new HttpError(400, "Name the bindings or defaults to move.", "invalid_request_error", "retirement_target_required");
  }
  await requireAccount(env, input.kind, input.account_id);
  await assertReplacement(env, input.kind, input.replacement_account_id);
  const at = nowIso(now);
  const accountColumn = input.kind === "codex" ? "codex_auth_id" : "subscription_account_id";
  const table = input.kind === "codex" ? "codex_auths" : "subscription_accounts";
  // Every write has its own committing predicate. A zero-row first UPDATE does
  // not roll back valid later statements in a D1 batch.
  const eligible = `EXISTS (SELECT 1 FROM ${table}
    WHERE id = ? AND ${migrationReplacementSql(input.kind)})
    AND EXISTS (SELECT 1 FROM ${table} WHERE id = ? AND status NOT IN ('revoked', 'disabled'))
    AND ${serviceAdminAuthoritySql}`;
  const eligibilityBindings = [input.replacement_account_id, input.account_id, ...serviceAdminAuthorityBindings(env, actor)];
  const statements: D1PreparedStatement[] = [
    env.DB.prepare(`${statusSql(input.kind, "retiring")} AND ${eligible}`).bind(at, input.account_id, ...eligibilityBindings),
    auditStatement(env, actor, {
      action: "credential.retire",
      targetId: input.account_id,
      meta: { kind: input.kind, replacement_account_id: input.replacement_account_id }
    }, at, true)
  ];
  if (input.key_ids.length > 0) {
    const keyPlaceholders = input.key_ids.map(() => "?").join(", ");
    statements.push(env.DB.prepare(
      `UPDATE api_key_surface_credentials
       SET ${accountColumn} = ?, updated_at = ?
       WHERE ${accountColumn} = ?
         AND api_key_id IN (${keyPlaceholders}) AND ${eligible}`
    ).bind(input.replacement_account_id, at, input.account_id, ...input.key_ids, ...eligibilityBindings));
    statements.push(auditStatement(env, actor, {
      action: "credential.migrate_bindings",
      targetId: input.account_id,
      meta: { kind: input.kind, replacement_account_id: input.replacement_account_id }
    }, at, true, true));
  }
  if (input.default_surfaces.length > 0) {
    const surfacePlaceholders = input.default_surfaces.map(() => "?").join(", ");
    statements.push(env.DB.prepare(
      `UPDATE organization_surface_credential_defaults
       SET ${accountColumn} = ?, updated_at = ?
       WHERE ${accountColumn} = ?
         AND surface_grant IN (${surfacePlaceholders}) AND ${eligible}`
    ).bind(input.replacement_account_id, at, input.account_id, ...input.default_surfaces, ...eligibilityBindings));
    statements.push(auditStatement(env, actor, {
      action: "credential.migrate_defaults",
      targetId: input.account_id,
      meta: { kind: input.kind, replacement_account_id: input.replacement_account_id }
    }, at, true, true));
  }
  const results = await env.DB.batch(statements);
  const statusChanged = changed(results[0]);
  let cursor = 2;
  const migratedBindings = input.key_ids.length > 0 ? changed(results[cursor]) : 0;
  if (input.key_ids.length > 0) cursor += 2;
  const migratedDefaults = input.default_surfaces.length > 0 ? changed(results[cursor]) : 0;
  if (statusChanged + migratedBindings + migratedDefaults === 0) {
    await assertCredentialAdmin(env, actor);
    throw new HttpError(409, "Nothing was migrated.", "invalid_request_error", "retirement_unchanged");
  }
  return { migrated_bindings: migratedBindings, migrated_defaults: migratedDefaults };
}

export async function disconnectCredential(
  env: Env,
  actor: CredentialActor,
  input: { kind: CredentialKind; account_id: string; force?: boolean },
  cleanup: () => Promise<void>,
  now = new Date()
): Promise<{ completion: "complete" | "partial"; d1_status: "revoked"; token_cleanup: "cleared" | "failed"; recovery?: "retry_cleanup"; live_bindings: number }> {
  if (input.force && actor.kind !== "admin_secret") {
    throw new HttpError(403, "Admin authentication required", "authentication_error", "admin_auth_required");
  }
  const live = await liveBindings(env, input.kind, input.account_id);
  if (!input.force && live.length > 0) {
    throw new HttpError(409, "Disconnect is blocked while live keys still use this account.", "invalid_request_error", "credential_disconnect_blocked");
  }
  const at = nowIso(now);
  const bindingGuard = input.force ? "" : `AND NOT EXISTS (SELECT 1 ${liveBindingRowsSql(input.kind)})`;
  const changedStatus = await audited(env, actor, {
    statement: (authority) => `${statusSql(input.kind, "revoked")} ${bindingGuard} AND ${authority}`,
    bindings: [at, input.account_id, ...(input.force ? [] : [input.account_id])],
    action: input.force ? "credential.force_disconnect" : "credential.disconnect",
    targetId: input.account_id,
    meta: {
      kind: input.kind,
      live_bindings: live.length,
      force: input.force === true
    }
  }, at);
  if (!changedStatus) {
    const account = await requireAccount(env, input.kind, input.account_id);
    if (account.status !== "revoked") {
      if (!input.force && (await liveBindings(env, input.kind, input.account_id)).length > 0) {
        throw new HttpError(409, "Disconnect is blocked while live keys still use this account.", "invalid_request_error", "credential_disconnect_blocked");
      }
      throw new HttpError(409, "The account was not disconnected.", "invalid_request_error", "credential_disconnect_rejected");
    }
  }
  await assertCredentialAdmin(env, actor);
  return finishCleanup(cleanup, live.length);
}

export async function retryCredentialCleanup(
  env: Env,
  actor: CredentialActor,
  input: { kind: CredentialKind; account_id: string },
  cleanup: () => Promise<void>,
  now = new Date()
): Promise<{ completion: "complete" | "partial"; d1_status: string; token_cleanup: "cleared" | "failed" }> {
  const account = await requireAccount(env, input.kind, input.account_id);
  if (account.status !== "revoked") {
    throw new HttpError(409, "Cleanup can only continue an account that is already disconnected.", "invalid_request_error", "credential_cleanup_not_ready");
  }
  const at = nowIso(now);
  // TokenAuthority is a separate store: authorize immediately before starting
  // cleanup and record its actual outcome, without claiming a cross-store batch.
  await assertCredentialAdmin(env, actor);
  try {
    await cleanup();
  } catch {
    await insertAudit(env, actor, {
      action: "credential.cleanup_retry",
      targetId: input.account_id,
      result: "error",
      meta: { kind: input.kind, token_cleanup: "failed" }
    }, at);
    return { completion: "partial", d1_status: account.status, token_cleanup: "failed" };
  }
  await insertAudit(env, actor, {
    action: "credential.cleanup_retry",
    targetId: input.account_id,
    meta: { kind: input.kind, token_cleanup: "cleared" }
  }, at);
  const after = await requireAccount(env, input.kind, input.account_id);
  return { completion: "complete", d1_status: after.status, token_cleanup: "cleared" };
}

export function defaultCredentialProbe(env: Env): UsabilityProbe {
  return async (_env, kind, accountId) => {
    if (kind === "codex") {
      readTokenResult(await env.TOKEN_AUTHORITY.get(env.TOKEN_AUTHORITY.idFromName(accountId)).getFreshAccessToken());
      return;
    }
    readTokenResult(await env.TOKEN_AUTHORITY.get(env.TOKEN_AUTHORITY.idFromName(`subscription:${accountId}`)).getFreshSubscriptionCredential());
  };
}

type UsabilityProbe = (env: Env, kind: CredentialKind, accountId: string) => Promise<void>;

interface DefaultRow {
  surface_grant: OrganizationSurface;
  codex_auth_id: string | null;
  subscription_account_id: string | null;
  codex_status: string | null;
  grok_status: string | null;
}

async function readDefaultRows(env: Env): Promise<DefaultRow[]> {
  const result = await env.DB.prepare(
    `SELECT d.surface_grant, d.codex_auth_id, d.subscription_account_id,
            c.status AS codex_status, s.status AS grok_status
     FROM organization_surface_credential_defaults AS d
     LEFT JOIN codex_auths AS c ON c.id = d.codex_auth_id
     LEFT JOIN subscription_accounts AS s ON s.id = d.subscription_account_id`
  ).all<DefaultRow>();
  return result.results ?? [];
}

async function rowUsable(env: Env, row: DefaultRow, probe: UsabilityProbe, _now: Date): Promise<boolean> {
  const kind: CredentialKind = row.surface_grant === "surface:codex:production" ? "codex" : "grok";
  const status = kind === "codex" ? row.codex_status : row.grok_status;
  const accountId = accountIdOf(row);
  if (!accountId || !defaultCredentialMetadataUsable(status)) return false;
  try {
    await probe(env, kind, accountId);
    return true;
  } catch {
    return false;
  }
}

function accountIdOf(row: { codex_auth_id: string | null; subscription_account_id: string | null }): string | null {
  return row.codex_auth_id ?? row.subscription_account_id;
}

function surfaceId(surface: OrganizationSurface): ServiceAvailability["surface"] {
  if (surface.startsWith("surface:codex:")) return "codex";
  if (surface.startsWith("surface:grok:")) return "grok";
  return "xai";
}

function statusSql(kind: CredentialKind, status: "retiring" | "revoked"): string {
  const table = kind === "codex" ? "codex_auths" : "subscription_accounts";
  const blocked = status === "retiring" ? "'retiring', 'revoked', 'disabled'" : "'revoked', 'disabled'";
  return `UPDATE ${table}
    SET status = '${status}', updated_at = ?
    WHERE id = ? AND status NOT IN (${blocked})`;
}

async function requireAccount(env: Env, kind: CredentialKind, accountId: string): Promise<{ id: string; status: string }> {
  const table = kind === "codex" ? "codex_auths" : "subscription_accounts";
  const row = await env.DB.prepare(`SELECT id, status FROM ${table} WHERE id = ?`).bind(accountId).first<{ id: string; status: string }>();
  if (!row) throw new HttpError(404, "Credential account not found", "invalid_request_error", "credential_account_not_found");
  return row;
}

async function assertReplacement(env: Env, kind: CredentialKind, accountId: string): Promise<void> {
  await requireAccount(env, kind, accountId);
  const table = kind === "codex" ? "codex_auths" : "subscription_accounts";
  const row = await env.DB.prepare(`SELECT id FROM ${table} WHERE id = ? AND ${migrationReplacementSql(kind)}`)
    .bind(accountId).first();
  if (!row) {
    throw new HttpError(409, "The replacement account is not usable.", "invalid_request_error", "credential_replacement_unusable");
  }
}

function migrationReplacementSql(kind: CredentialKind): string {
  return `environment = 'production' AND ${kind === "codex" ? "kind = 'shared'" : "capability_source = 'grok'"}
    AND status IN ('active', 'degraded')`;
}

async function compatibleReplacements(env: Env, kind: CredentialKind, accountId: string): Promise<Array<{ id: string; label: string }>> {
  const sql = kind === "codex"
    ? `SELECT id, label FROM codex_auths
       WHERE id <> ? AND kind = 'shared' AND environment = 'production' AND status IN ('active', 'degraded')
       ORDER BY id`
    : `SELECT id, label FROM subscription_accounts
       WHERE id <> ? AND capability_source = 'grok' AND environment = 'production' AND status IN ('active', 'degraded')
       ORDER BY id`;
  const result = await env.DB.prepare(sql).bind(accountId).all<{ id: string; label: string }>();
  return result.results ?? [];
}

function liveBindingRowsSql(kind: CredentialKind): string {
  const column = kind === "codex" ? "b.codex_auth_id" : "b.subscription_account_id";
  return `FROM api_key_surface_credentials AS b
     JOIN api_keys AS ak ON ak.id = b.api_key_id
     WHERE ak.status = 'active' AND ${column} = ?`;
}

async function liveBindings(env: Env, kind: CredentialKind, accountId: string): Promise<RetirementPreview["live_keys"]> {
  const result = await env.DB.prepare(
    `SELECT ak.id, ak.key_prefix, ak.family_id, b.surface_grant
     ${liveBindingRowsSql(kind)}
     ORDER BY ak.id, b.surface_grant`
  ).bind(accountId).all<RetirementPreview["live_keys"][number]>();
  return result.results ?? [];
}

async function audited(
  env: Env,
  actor: CredentialActor,
  input: { statement: (authority: string) => string; bindings: unknown[]; action: string; targetId: string; meta: Record<string, string | number | boolean | null> },
  at: string
): Promise<boolean> {
  const results = await env.DB.batch([
    env.DB.prepare(input.statement(serviceAdminAuthoritySql)).bind(...input.bindings, ...serviceAdminAuthorityBindings(env, actor)),
    auditStatement(env, actor, input, at, true)
  ]);
  const committed = changed(results[1]) === 1;
  if (!committed) await assertCredentialAdmin(env, actor);
  return committed;
}

async function assertCredentialAdmin(env: Env, actor: CredentialActor): Promise<void> {
  const current = await env.DB.prepare(`SELECT 1 AS authorized WHERE ${serviceAdminAuthoritySql}`)
    .bind(...serviceAdminAuthorityBindings(env, actor)).first();
  if (!current) throw new HttpError(403, "Admin authentication required", "authentication_error", "admin_required");
}

async function insertAudit(
  env: Env,
  actor: CredentialActor,
  input: { action: string; targetId: string; meta: Record<string, string | number | boolean | null>; result?: "ok" | "error" },
  at: string
): Promise<void> {
  await auditStatement(env, actor, input, at, false).run();
}

function auditStatement(
  env: Env,
  actor: CredentialActor,
  input: { action: string; targetId: string; meta: Record<string, string | number | boolean | null>; result?: "ok" | "error" },
  at: string,
  gated: boolean,
  recordChanged = false
): D1PreparedStatement {
  const result = input.result ?? "ok";
  const metaSql = gated && recordChanged ? "json_set(?, '$.changed', changes())" : "?";
  const sql = gated
    ? `INSERT INTO operator_mutation_audit (
         id, at, actor_kind, actor_email, actor_subject, actor_user_id, actor_role,
         action, target_type, target_id, result, request_id, meta, created_at
       )
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, 'credential', ?, ?, ?, ${metaSql}, ?
       WHERE changes() > 0`
    : `INSERT INTO operator_mutation_audit (
         id, at, actor_kind, actor_email, actor_subject, actor_user_id, actor_role,
         action, target_type, target_id, result, request_id, meta, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'credential', ?, ?, ?, ?, ?)`;
  return env.DB.prepare(sql).bind(
    generateId("oma"),
    at,
    actor.kind,
    actor.email,
    actor.subject,
    actor.userId,
    actor.role,
    input.action,
    input.targetId,
    result,
    actor.requestId,
    JSON.stringify(input.meta),
    at
  );
}

async function finishCleanup(cleanup: () => Promise<void>, liveBindingsCount: number) {
  try {
    await cleanup();
    return { completion: "complete" as const, d1_status: "revoked" as const, token_cleanup: "cleared" as const, live_bindings: liveBindingsCount };
  } catch {
    return {
      completion: "partial" as const,
      d1_status: "revoked" as const,
      token_cleanup: "failed" as const,
      recovery: "retry_cleanup" as const,
      live_bindings: liveBindingsCount
    };
  }
}

function changed(result: unknown): number {
  if (!result || typeof result !== "object" || !("meta" in result)) return 0;
  const changes = (result as { meta?: { changes?: number } }).meta?.changes;
  return typeof changes === "number" ? changes : 0;
}
