import { generateId, nowIso } from "../crypto";
import { HttpError } from "../errors";
import { getUser } from "../db";
import { isOrganizationLoginUser, organizationDomain, type LifecycleActor } from "./principal";
import type { UserRow } from "../types";

export function normalizeServiceName(value: unknown): string {
  if (typeof value !== "string") throw invalidName();
  const name = value.trim();
  if (!name || [...name].length > 64 || /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(name)) throw invalidName();
  return name;
}
function invalidName(): HttpError {
  return new HttpError(400, "Enter a service name of 1–64 characters without control characters.", "invalid_request_error", "invalid_service_name");
}

// Same committing human authority as member lifecycle. Operator bearer identity is
// represented by the absence of a user ID; no owner/creator delegation is implied.
export const serviceAdminAuthoritySql = `(? IS NULL OR EXISTS (
  SELECT 1 FROM users AS actor WHERE actor.id = ? AND actor.account_kind = 'human'
    AND actor.role = 'admin' AND actor.status = 'active' AND actor.login_capable = 1
    AND actor.canonical_email = ? AND actor.console_session_epoch = ?
    AND substr(actor.canonical_email, instr(actor.canonical_email, '@') + 1) = ?
))`;
export function serviceAdminAuthorityBindings(env: Env, actor: LifecycleActor): unknown[] {
  if (actor.kind !== "admin_secret" && (!actor.userId || !isOrganizationLoginUser(env, { account_kind: "human", canonical_email: actor.email, login_capable: 1 }))) throw new HttpError(403, "Admin authentication required", "authentication_error", "admin_required");
  return [actor.kind === "admin_secret" ? null : actor.userId, actor.userId, actor.email, actor.sessionEpoch ?? 0, organizationDomain(env) ?? ""];
}
function audit(env: Env, actor: LifecycleActor, id: string, action: string, meta: Record<string, unknown>, at: string, changes: number): D1PreparedStatement {
  return env.DB.prepare(`INSERT INTO operator_mutation_audit (
    id, at, actor_kind, actor_email, actor_subject, actor_user_id, actor_role,
    action, target_type, target_id, result, request_id, meta, created_at
  ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, 'user', ?, 'ok', ?, ?, ? WHERE changes() = ?`)
    .bind(generateId("oma"), at, actor.kind, actor.email, actor.subject, actor.userId,
      actor.role, action, id, actor.requestId, JSON.stringify(meta), at, changes);
}
async function rejected(env: Env, actor: LifecycleActor): Promise<never> {
  if (actor.userId) {
    const user = await env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(actor.userId)
      .first<UserRow & { console_session_epoch: number }>();
    if (!user || user.role !== "admin" || user.status !== "active" || !isOrganizationLoginUser(env, user)
      || user.canonical_email !== actor.email || user.console_session_epoch !== (actor.sessionEpoch ?? 0)) {
      throw new HttpError(403, "Admin authentication required", "authentication_error", "admin_required");
    }
  }
  throw new HttpError(409, "The account changed. Review its current identity before trying again.", "invalid_request_error", "service_identity_changed");
}

/** Creation alone initializes Disabled. Classification never calls this path. */
export async function commitServiceAccount(env: Env, actor: LifecycleActor, displayName: unknown, now = new Date()): Promise<UserRow> {
  const name = normalizeServiceName(displayName);
  const id = generateId("usr");
  const at = nowIso(now);
  const results = await env.DB.batch([
    env.DB.prepare(`INSERT INTO users (id, email, canonical_email, role, status, login_capable, account_kind, display_name, created_at, updated_at)
      SELECT ?, NULL, NULL, 'user', 'active', 0, 'service', ?, ?, ? WHERE ${serviceAdminAuthoritySql}`)
      .bind(id, name, at, at, ...serviceAdminAuthorityBindings(env, actor)),
    // All three rows are one statement. If identity insertion was rejected, no
    // policy or success audit can commit. An exception rolls back the whole batch.
    env.DB.prepare(`INSERT INTO user_surface_credit_modes (user_id, surface_grant, mode, created_at, updated_at)
      SELECT ?, value, 'disabled', ?, ? FROM json_each(?) WHERE changes() = 1`)
      .bind(id, at, at, JSON.stringify(["surface:codex:production", "surface:grok:production", "surface:xai:production"])),
    audit(env, actor, id, "service.create", { account_kind: "service", display_name: name, policy: "disabled" }, at, 3)
  ]);
  if (results[2]?.meta.changes !== 1) return rejected(env, actor);
  return { id, email: null, canonical_email: null, role: "user", status: "active", login_capable: 0,
    account_kind: "service", display_name: name, created_at: at, updated_at: at };
}

export async function commitServiceName(env: Env, actor: LifecycleActor, id: string, displayName: unknown, now = new Date()): Promise<UserRow> {
  const name = normalizeServiceName(displayName);
  const at = nowIso(now);
  const results = await env.DB.batch([
    env.DB.prepare(`UPDATE users SET display_name = ?, updated_at = ? WHERE id = ? AND account_kind = 'service' AND ${serviceAdminAuthoritySql}`)
      .bind(name, at, id, ...serviceAdminAuthorityBindings(env, actor)),
    audit(env, actor, id, "service.rename", { display_name: name }, at, 1)
  ]);
  if (results[1]?.meta.changes !== 1) return rejected(env, actor);
  return (await getUser(env, id))!;
}

/** Explicit, reviewed legacy classification changes metadata only. The source
 * identity and review version must still match at commit; no human conversion. */
export async function commitLegacyServiceClassification(env: Env, actor: LifecycleActor, id: string,
  input: { display_name: unknown; expected_updated_at: string }, now = new Date()): Promise<UserRow> {
  const name = normalizeServiceName(input.display_name);
  const current = await env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(id)
    .first<UserRow & { console_session_epoch: number }>();
  if (!current) throw new HttpError(404, "User not found", "invalid_request_error", "user_not_found");
  if (current.account_kind !== "legacy_unresolved" || current.login_capable !== 0 || current.role !== "user"
    || current.email !== null || current.canonical_email !== null || current.updated_at !== input.expected_updated_at) return rejected(env, actor);
  const at = nowIso(now);
  const results = await env.DB.batch([
    env.DB.prepare(`UPDATE users SET account_kind = 'service', display_name = ?, updated_at = ?, console_session_epoch = console_session_epoch + 1
      WHERE id = ? AND account_kind = 'legacy_unresolved' AND login_capable = 0 AND role = 'user'
        AND email IS NULL AND canonical_email IS NULL AND status = ? AND updated_at = ? AND console_session_epoch = ?
        AND ${serviceAdminAuthoritySql}`)
      .bind(name, at, id, current.status, input.expected_updated_at, current.console_session_epoch, ...serviceAdminAuthorityBindings(env, actor)),
    audit(env, actor, id, "service.classify", { previous_kind: "legacy_unresolved", account_kind: "service", display_name: name }, at, 1)
  ]);
  if (results[1]?.meta.changes !== 1) return rejected(env, actor);
  return (await getUser(env, id))!;
}
