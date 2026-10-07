import { assertIssuableSurfaceGrants, parseApiKeyScopes } from "./authenticate";
import {
  insertBoundApiKey,
  assertCopiedBindingsUsable,
  type SurfaceCredentialSelection
} from "./bindings";
import { assertIssuanceEntitlement } from "./credits";
import {
  defaultCredentialProbe,
  selectIssuanceDefaults,
  type OrganizationSurface
} from "./credential-defaults";
import { generateApiKey, generateId, hmacSha256Hex, nowIso } from "../crypto";
import { getApiKeyById, getUser, operatorMutationAuditStatement, type OperatorMutationAuditInput } from "../db";
import { keyActorAuthority, assertKeyActorAuthority } from "./key-authority";
import { keyLifecycle, type KeyLifecycle } from "./key-state";
import { HttpError } from "../errors";
import type { ApiKeyRow } from "../types";

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_EXPIRY_DAYS = 90;
const MAX_EXPIRY_DAYS = 365;

export interface KeyActor {
  /** Set only by the explicit delegated namespace, never from a request body. */
  delegatedServiceId?: string;
  sessionEpoch?: number;
  kind: "access" | "admin_secret";
  email: string | null;
  subject: string | null;
  userId: string | null;
  role: "admin" | "user" | null;
  requestId: string | null;
}

export interface PublicApiKey {
  /** Raw stored status remains compatible; lifecycle is the current authentication projection. */
  lifecycle: KeyLifecycle;
  id: string;
  name: string | null;
  key_prefix: string;
  status: string;
  scopes: string[];
  family_id: string | null;
  expires_at: string | null;
  last_used_at: string | null;
  created_at: string;
  revoked_at: string | null;
}

export interface IssuedApiKey extends PublicApiKey {
  token: string;
  user_id: string;
}

export function normalizeKeyName(value: unknown): string {
  if (typeof value !== "string") {
    throw new HttpError(400, "Key name is required", "invalid_request_error", "invalid_key_name");
  }
  const name = value.trim();
  if (name.length < 1 || name.length > 64 || /[\u0000-\u001F\u007F]/.test(name)) {
    throw new HttpError(400, "Key name must be 1-64 characters without control characters", "invalid_request_error", "invalid_key_name");
  }
  return name;
}

export function resolveKeyExpiry(value: string | null | undefined, now: Date): string {
  if (value === undefined || value === null || value.trim() === "") {
    return new Date(now.getTime() + DEFAULT_EXPIRY_DAYS * DAY_MS).toISOString();
  }
  const instant = Date.parse(value);
  if (!Number.isFinite(instant)) {
    throw new HttpError(400, "Choose a valid expiry date and time.", "invalid_request_error", "invalid_expires_at");
  }
  if (instant <= now.getTime()) {
    throw new HttpError(400, "Expiry must be in the future.", "invalid_request_error", "expiry_in_past");
  }
  if (instant > now.getTime() + MAX_EXPIRY_DAYS * DAY_MS) {
    throw new HttpError(400, "Expiry cannot be more than 365 days from issuance.", "invalid_request_error", "expiry_too_far");
  }
  return value;
}

export function publicApiKey(row: Omit<ApiKeyRow, "key_hash">, now = new Date(), ownerStatus?: string | null): PublicApiKey {
  return {
    lifecycle: keyLifecycle(row, ownerStatus, now.getTime()),
    id: row.id,
    name: row.name ?? null,
    key_prefix: row.key_prefix,
    status: row.status,
    scopes: parseApiKeyScopes(row.scopes),
    family_id: row.family_id ?? null,
    expires_at: row.expires_at,
    last_used_at: row.last_used_at,
    created_at: row.created_at,
    revoked_at: row.revoked_at
  };
}

export async function listMemberKeys(env: Env, userId: string, now = new Date()): Promise<PublicApiKey[]> {
  const result = await env.DB.prepare(
    `SELECT k.id, k.user_id, k.key_prefix, k.status, k.scopes, k.name, k.family_id, k.expires_at,
            k.last_used_at, k.created_at, k.revoked_at, u.status AS owner_status
     FROM api_keys AS k JOIN users AS u ON u.id = k.user_id
     WHERE k.user_id = ?
     ORDER BY k.created_at, k.id`
  ).bind(userId).all<Omit<ApiKeyRow, "key_hash"> & { owner_status: string }>();
  return (result.results ?? []).map(row => publicApiKey(row, now, row.owner_status));
}

export async function issueMemberKey(
  env: Env,
  actor: KeyActor,
  userId: string,
  input: { name: unknown; surfaces: readonly string[]; expires_at?: string | null },
  now = new Date(),
  issuanceId?: string,
  submissionFingerprint?: string
): Promise<IssuedApiKey> {
  const grants = memberSurfaces(input.surfaces);
  const selections = await selectIssuanceDefaults(env, grants, defaultCredentialProbe(env), now);
  return commitIssuedKey(env, actor, {
    user_id: userId,
    name: normalizeKeyName(input.name),
    scopes: grants,
    expires_at: resolveKeyExpiry(input.expires_at, now),
    selections,
    action: "key.create",
    key_id: issuanceId,
    meta: submissionFingerprint ? { member_submission_fingerprint: submissionFingerprint } : undefined
  }, now);
}

export async function replaceMemberKey(
  env: Env,
  actor: KeyActor,
  userId: string,
  keyId: string,
  expiresAt: string | null | undefined,
  now = new Date(),
  issuanceId?: string,
  submissionFingerprint?: string
): Promise<{ replacement: IssuedApiKey; previous: PublicApiKey; old_key_remains_active: boolean }> {
  const existing = await ownedKey(env, userId, keyId);
  if (existing.status !== "active") {
    throw new HttpError(409, "Only an active key can be replaced", "invalid_request_error", "key_not_active");
  }
  const replacement = await commitReplacement(env, actor, existing, expiresAt, now, issuanceId, submissionFingerprint);
  const previous = publicApiKey(existing, now, "active");
  return { replacement, previous, old_key_remains_active: previous.lifecycle.state === "active" };
}

export async function renameMemberKey(
  env: Env,
  actor: KeyActor,
  userId: string,
  keyId: string,
  name: unknown,
  now = new Date()
): Promise<PublicApiKey> {
  const existing = await ownedKey(env, userId, keyId);
  const nextName = normalizeKeyName(name);
  const guard = keyActorAuthority(actor, userId);
  const results = await env.DB.batch([
    env.DB.prepare(`UPDATE api_keys SET name = ? WHERE id = ? AND user_id = ? AND ${guard.sql}`).bind(nextName, existing.id, userId, ...guard.values),
    auditStatement(env, actor, "key.rename", existing.id, {
      user_id: userId,
      key_prefix: existing.key_prefix,
      name: nextName
    }, now, true)
  ]);
  if (changed(results[0]) !== 1) {
    await assertKeyActorAuthority(env, actor, userId);
    throw new HttpError(409, "Key name was not changed.", "invalid_request_error", "key_rename_rejected");
  }
  // The committed UPDATE owns only name. A concurrent last-used touch (or a
  // later rename) must not turn this acknowledged transaction into a rejection.
  return publicApiKey({ ...existing, name: nextName }, now);
}

export async function revokeMemberKey(
  env: Env,
  actor: KeyActor,
  userId: string,
  keyId: string,
  now = new Date()
): Promise<{ id: string; revoked: true; already_revoked: boolean; key_prefix: string }> {
  const existing = await ownedKey(env, userId, keyId);
  return revokeKey(env, actor, existing, now);
}

export async function revokeAllMemberKeys(
  env: Env,
  actor: KeyActor,
  userId: string,
  now = new Date()
): Promise<{ revoked: number }> {
  const at = nowIso(now);
  const guard = keyActorAuthority(actor, userId);
  const results = await env.DB.batch([
    env.DB.prepare(
      `UPDATE api_keys SET status = 'revoked', revoked_at = ? WHERE user_id = ? AND status != 'revoked' AND ${guard.sql}`
    ).bind(at, userId, ...guard.values),
    auditStatement(env, actor, "key.revoke_all", userId, { user_id: userId }, now, true)
  ]);
  const revoked = changed(results[0]);
  if (revoked === 0) await assertKeyActorAuthority(env, actor, userId);
  return { revoked };
}

export async function commitIssuedKey(
  env: Env,
  actor: KeyActor,
  input: {
    user_id: string;
    key_id?: string;
    name: string | null;
    scopes: string[];
    expires_at: string | null;
    family_id?: string;
    selections?: readonly SurfaceCredentialSelection[];
    copy_bindings_from_api_key_id?: string;
    action: "key.create" | "key.replace.create";
    meta?: Record<string, string | number | boolean | null>;
  },
  now = new Date()
): Promise<IssuedApiKey> {
  const user = await getUser(env, input.user_id);
  if (!user) throw new HttpError(404, "User not found", "invalid_request_error", "user_not_found");
  if (user.status !== "active") throw new HttpError(403, "User is not active", "authentication_error", "user_inactive");
  const grants = assertIssuableSurfaceGrants(input.scopes);
  await assertIssuanceEntitlement(env, input.user_id, grants, now);
  if (input.copy_bindings_from_api_key_id) {
    await assertCopiedBindingsUsable(env, input.copy_bindings_from_api_key_id, grants);
  }
  const { plaintext, prefix } = generateApiKey();
  const row = await insertBoundApiKey(env, {
    user_id: input.user_id,
    key_id: input.key_id,
    actor,
    key_prefix: prefix,
    key_hash: await hmacSha256Hex(env.API_KEY_HASH_PEPPER, plaintext),
    scopes: grants,
    name: input.name,
    family_id: input.family_id,
    expires_at: input.expires_at,
    selections: input.selections,
    copy_bindings_from_api_key_id: input.copy_bindings_from_api_key_id,
    audit: (keyId) => auditStatement(env, actor, input.action, keyId, {
      user_id: input.user_id,
      key_prefix: prefix,
      scopes: grants.join(","),
      expires_at: input.expires_at,
      ...(input.meta ?? {})
    }, now, true)
  }, now);
  return { ...publicApiKey(row, now, "active"), token: plaintext, user_id: row.user_id, scopes: grants };
}

export async function commitReplacement(
  env: Env,
  actor: KeyActor,
  existing: ApiKeyRow,
  expiresAt: string | null | undefined,
  now = new Date(),
  issuanceId?: string,
  submissionFingerprint?: string
): Promise<IssuedApiKey> {
  const grants = assertIssuableSurfaceGrants(parseApiKeyScopes(existing.scopes));
  return commitIssuedKey(env, actor, {
    user_id: existing.user_id,
    name: existing.name ?? null,
    scopes: grants,
    expires_at: resolveKeyExpiry(expiresAt, now),
    family_id: existing.family_id,
    copy_bindings_from_api_key_id: existing.id,
    key_id: issuanceId,
    action: "key.replace.create",
    meta: {
      ...(submissionFingerprint ? {member_submission_fingerprint: submissionFingerprint} : {}),
      previous_key_id: existing.id,
      previous_key_prefix: existing.key_prefix,
      old_key_remains_active: keyLifecycle(existing, "active", now.getTime()).state === "active"
    }
  }, now);
}

export async function revokeKey(
  env: Env,
  actor: KeyActor,
  existing: ApiKeyRow,
  now = new Date()
): Promise<{ id: string; revoked: true; already_revoked: boolean; key_prefix: string }> {
  const at = nowIso(now);
  const guard = keyActorAuthority(actor, existing.user_id);
  const results = await env.DB.batch([
    env.DB.prepare(
      `UPDATE api_keys SET status = 'revoked', revoked_at = ? WHERE id = ? AND user_id = ? AND status != 'revoked' AND ${guard.sql}`
    ).bind(at, existing.id, existing.user_id, ...guard.values),
    auditStatement(env, actor, "key.revoke", existing.id, {
      user_id: existing.user_id,
      key_prefix: existing.key_prefix,
      previous_status: existing.status,
      already_revoked: false
    }, now, true)
  ]);
  if (changed(results[0]) === 1) {
    return { id: existing.id, revoked: true, already_revoked: false, key_prefix: existing.key_prefix };
  }
  await assertKeyActorAuthority(env, actor, existing.user_id);
  const current = await getApiKeyById(env, existing.id);
  if (!current || current.user_id !== existing.user_id) {
    throw new HttpError(404, "API key not found", "invalid_request_error", "key_not_found");
  }
  if (current.status !== "revoked") {
    throw new HttpError(409, "Key revocation was rejected.", "invalid_request_error", "key_revoke_rejected");
  }
  return { id: current.id, revoked: true, already_revoked: true, key_prefix: current.key_prefix };
}

export function memberSurfaces(values: readonly string[]): OrganizationSurface[] {
  if (values.length === 0) {
    throw new HttpError(400, "Choose at least one surface.", "invalid_request_error", "missing_surface_grants");
  }
  return assertIssuableSurfaceGrants(values.map((value) => {
    if (value === "codex" || value === "grok" || value === "xai") return `surface:${value}:production`;
    return value;
  })) as OrganizationSurface[];
}

async function ownedKey(env: Env, userId: string, keyId: string): Promise<ApiKeyRow> {
  const key = await getApiKeyById(env, keyId);
  if (!key || key.user_id !== userId) {
    throw new HttpError(404, "API key not found", "invalid_request_error", "key_not_found");
  }
  return key;
}

function auditStatement(
  env: Env,
  actor: KeyActor,
  action: string,
  targetId: string,
  meta: Record<string, string | number | boolean | null>,
  now: Date,
  countChanges = false
): D1PreparedStatement {
  const input: OperatorMutationAuditInput = {
    actor_kind: actor.kind,
    actor_email: actor.email,
    actor_subject: actor.subject,
    actor_user_id: actor.userId,
    actor_role: actor.role,
    action,
    target_type: "api_key",
    target_id: targetId,
    result: "ok",
    request_id: actor.requestId,
    meta
  };
  if (!countChanges) return operatorMutationAuditStatement(env, input, now);
  const at = nowIso(now);
  return env.DB.prepare(
    `INSERT INTO operator_mutation_audit (
      id, at, actor_kind, actor_email, actor_subject, actor_user_id, actor_role,
      action, target_type, target_id, result, request_id, meta, created_at
    )
    SELECT ?, ?, ?, ?, ?, ?, CASE WHEN ? = 'access' THEN (SELECT role FROM users WHERE id = ?) ELSE ? END, ?, 'api_key', ?, 'ok', ?, json_set(?, '$.changed', changes()), ?
    WHERE changes() > 0`
  ).bind(
    generateId("oma"),
    at,
    actor.kind,
    actor.email,
    actor.subject,
    actor.userId,
    actor.kind,
    actor.userId,
    actor.role,
    action,
    targetId,
    actor.requestId,
    JSON.stringify(meta),
    at
  );
}

function changed(result: unknown): number {
  if (!result || typeof result !== "object" || !("meta" in result)) return 0;
  const changes = (result as { meta?: { changes?: number } }).meta?.changes;
  return typeof changes === "number" ? changes : 0;
}
