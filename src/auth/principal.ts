import { generateId, nowIso } from "../crypto";
import type { UserRow } from "../types";
import { HttpError } from "../errors";

export interface ConsolePrincipal {
  id: string;
  email: string;
  role: "admin" | "user";
  status: "active";
  sessionEpoch: number;
}

export interface ConsoleAccessAudit {
  subject: string | null;
  requestId: string | null;
}

export interface LifecycleActor {
  kind: "access" | "admin_secret";
  email: string | null;
  subject: string | null;
  userId: string | null;
  role: "admin" | "user" | null;
  requestId: string | null;
  sessionEpoch?: number;
}

interface StoredUser {
  id: string;
  email: string | null;
  canonical_email: string | null;
  role: string;
  status: string;
  login_capable: number;
  account_kind: "human" | "service" | "legacy_unresolved";
  console_session_epoch: number;
  created_at: string;
  updated_at: string;
}

const MAILBOX = /^[^\s@]+@[^\s@]+$/;

/**
 * Organization login identity: trim and lowercase only.
 * Plus-tags, dots, and subject claims are not aliases.
 */
export function canonicalMailbox(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const email = value.trim().toLowerCase();
  if (!MAILBOX.test(email) || /[\u0000-\u001f\u007f]/.test(email)) return null;
  return email;
}

export async function resolveConsolePrincipal(
  env: Env,
  email: string,
  now = new Date(),
  audit: ConsoleAccessAudit = { subject: null, requestId: null }
): Promise<ConsolePrincipal> {
  const canonical = canonicalMailbox(email);
  if (!canonical) {
    throw new HttpError(403, "Admin authentication required", "authentication_error", "admin_auth_required");
  }
  const existing = await findLoginUser(env, canonical);
  if (existing) return activePrincipal(existing);
  if (await countCanonical(env, canonical) > 0) {
    throw ambiguousIdentity();
  }
  try {
    await provisionLoginUser(env, canonical, now, audit);
  } catch (error) {
    if (!isUniqueCanonical(error)) throw error;
  }
  const created = await findLoginUser(env, canonical);
  if (created) return activePrincipal(created);
  if (await countCanonical(env, canonical) > 0) throw ambiguousIdentity();
  throw new HttpError(500, "An internal error occurred", "server_error", "internal_error");
}

/** Human provisioning shares the lifecycle authorization/audit commit boundary. */
export async function commitHumanUser(env: Env, actor: LifecycleActor, email: unknown, now = new Date()): Promise<UserRow> {
  const canonical = organizationMailbox(env, email);
  const id = generateId("usr");
  const at = nowIso(now);
  try {
    const committed = await commitLifecycle(env, actor, {
      update: `INSERT INTO users (id, email, canonical_email, role, status, login_capable, account_kind, created_at, updated_at)
        SELECT ?1, ?2, ?2, 'user', 'active', 1, 'human', ?3, ?3
        WHERE NOT EXISTS (SELECT 1 FROM users WHERE canonical_email = ?2)
          AND (?4 IS NULL OR EXISTS (
            SELECT 1 FROM users AS actor WHERE actor.id = ?4 AND actor.role = 'admin'
              AND actor.status = 'active' AND actor.account_kind = 'human' AND actor.login_capable = 1 AND actor.console_session_epoch = ?5
              AND substr(actor.canonical_email, instr(actor.canonical_email, '@') + 1) = ?6
          ))`,
      updateBindings: [id, canonical, at, actor.userId, actor.sessionEpoch ?? 0, organizationDomain(env) ?? ""],
      action: "user.create", meta: { email: canonical, role: "user", status: "active" }
    }, id, at);
    if (!committed) {
      if (actor.userId) {
        const current = await loadUser(env, actor.userId);
        if (!current || current.role !== "admin" || current.status !== "active" || current.login_capable !== 1
          || current.console_session_epoch !== (actor.sessionEpoch ?? 0) || !isOrganizationLoginUser(env, current)) {
          throw new HttpError(403, "Admin authentication required", "authentication_error", "admin_required");
        }
      }
      throw new HttpError(409, "That email already belongs to another account.", "invalid_request_error", "email_conflict");
    }
  } catch (error) {
    if (isUniqueCanonical(error)) throw new HttpError(409, "That email already belongs to another account.", "invalid_request_error", "email_conflict");
    throw error;
  }
  return { id, email: canonical, canonical_email: canonical, role: "user", status: "active", login_capable: 1, account_kind: "human", created_at: at, updated_at: at };
}

export async function commitUserRole(
  env: Env,
  actor: LifecycleActor,
  userId: string,
  role: "admin" | "user",
  now = new Date()
): Promise<{ id: string; role: "admin" | "user"; previous_role: string }> {
  if (role !== "admin" && role !== "user") {
    throw new HttpError(400, "Role must be admin or user", "invalid_request_error", "invalid_role");
  }
  const existing = await requireTarget(env, userId);
  if (role === "admin" && !isOrganizationLoginUser(env, existing)) throw new HttpError(409, "Only an organization-login-capable human can be an administrator.", "invalid_request_error", "human_identity_required");
  const protectsAdmin = existing.role === "admin" && existing.status === "active" && isOrganizationLoginUser(env, existing);
  const candidates = role === "user" && protectsAdmin ? await verifiedAdminCandidates(env) : [];
  const at = nowIso(now);
  const committed = await commitLifecycle(env, actor, {
    update: `UPDATE users
      SET role = ?1, updated_at = ?2
      WHERE id = ?3 AND role = ?6 AND status = ?7 AND console_session_epoch = ?8
        AND (?1 <> 'admin' OR (account_kind = 'human' AND login_capable = 1))
        AND (?4 IS NULL OR EXISTS (
          SELECT 1 FROM users AS actor
          WHERE actor.id = ?4 AND actor.role = 'admin' AND actor.status = 'active'
            AND actor.account_kind = 'human' AND actor.login_capable = 1 AND actor.console_session_epoch = ?5
            AND substr(actor.canonical_email, instr(actor.canonical_email, '@') + 1) = ?9
        ))
        AND (
          ?1 = 'admin'
          OR role <> 'admin'
          OR status <> 'active'
          OR ?10 = 0
          OR EXISTS (
            SELECT 1 FROM users AS other JOIN json_each(?11) AS candidate
              ON other.id = json_extract(candidate.value, '$.id')
              AND other.canonical_email = json_extract(candidate.value, '$.email')
              AND other.console_session_epoch = json_extract(candidate.value, '$.epoch')
            WHERE other.id <> users.id AND other.role = 'admin' AND other.status = 'active'
              AND other.account_kind = 'human' AND other.login_capable = 1
          )
        )`,
    updateBindings: [role, at, userId, actor.userId, actor.sessionEpoch ?? 0, existing.role, existing.status, existing.console_session_epoch, organizationDomain(env) ?? "", protectsAdmin ? 1 : 0, JSON.stringify(candidates)],
    action: role === "admin" ? "user.promote" : "user.demote",
    meta: { previous_role: existing.role, role },
  }, userId, at);
  if (!committed) {
    await rejectLifecycle(env, actor, userId, role === "user" ? "demote" : "promote");
  }
  return { id: userId, role, previous_role: existing.role };
}

export async function commitUserStatus(
  env: Env,
  actor: LifecycleActor,
  userId: string,
  status: "active" | "disabled",
  now = new Date()
): Promise<{ id: string; email: string | null; status: "active" | "disabled"; previous_status: string }> {
  if (status !== "active" && status !== "disabled") {
    throw new HttpError(400, "Status must be active or disabled", "invalid_request_error", "invalid_status");
  }
  const existing = await requireTarget(env, userId);
  const protectsAdmin = existing.role === "admin" && existing.status === "active" && isOrganizationLoginUser(env, existing);
  const candidates = status === "disabled" && protectsAdmin ? await verifiedAdminCandidates(env) : [];
  const at = nowIso(now);
  const committed = await commitLifecycle(env, actor, {
    update: `UPDATE users
      SET status = ?1, updated_at = ?2,
          console_session_epoch = console_session_epoch + CASE WHEN ?1 = 'disabled' THEN 1 ELSE 0 END
      WHERE id = ?3 AND role = ?6 AND status = ?7 AND console_session_epoch = ?8
        AND (?4 IS NULL OR EXISTS (
          SELECT 1 FROM users AS actor
          WHERE actor.id = ?4 AND actor.role = 'admin' AND actor.status = 'active'
            AND actor.account_kind = 'human' AND actor.login_capable = 1 AND actor.console_session_epoch = ?5
            AND substr(actor.canonical_email, instr(actor.canonical_email, '@') + 1) = ?9
        ))
        AND (
          ?1 = 'active'
          OR role <> 'admin'
          OR status <> 'active'
          OR ?10 = 0
          OR EXISTS (
            SELECT 1 FROM users AS other JOIN json_each(?11) AS candidate
              ON other.id = json_extract(candidate.value, '$.id')
              AND other.canonical_email = json_extract(candidate.value, '$.email')
              AND other.console_session_epoch = json_extract(candidate.value, '$.epoch')
            WHERE other.id <> users.id AND other.role = 'admin' AND other.status = 'active'
              AND other.account_kind = 'human' AND other.login_capable = 1
          )
        )`,
    updateBindings: [status, at, userId, actor.userId, actor.sessionEpoch ?? 0, existing.role, existing.status, existing.console_session_epoch, organizationDomain(env) ?? "", protectsAdmin ? 1 : 0, JSON.stringify(candidates)],
    action: status === "active" ? "user.enable" : "user.disable",
    meta: { previous_status: existing.status, status },
  }, userId, at);
  if (!committed) {
    await rejectLifecycle(env, actor, userId, status === "disabled" ? "disable" : "enable");
  }
  return { id: userId, email: existing.canonical_email ?? existing.email, status, previous_status: existing.status };
}

export async function commitUserEmail(
  env: Env,
  actor: LifecycleActor,
  userId: string,
  email: string,
  now = new Date()
): Promise<{ id: string; email: string; previous_email: string | null }> {
  const canonical = organizationMailbox(env, email);
  const existing = await requireTarget(env, userId);
  if (existing.account_kind === "service") throw new HttpError(409, "Service accounts cannot gain a login identity.", "invalid_request_error", "human_identity_required");
  const at = nowIso(now);
  try {
    const committed = await commitLifecycle(env, actor, {
      update: `UPDATE users
        SET email = ?1, canonical_email = ?1, login_capable = 1, account_kind = 'human', updated_at = ?2,
            console_session_epoch = console_session_epoch + 1
        WHERE id = ?3 AND console_session_epoch = ?6 AND account_kind <> 'service'
          AND (?4 IS NULL OR EXISTS (
            SELECT 1 FROM users AS actor
            WHERE actor.id = ?4 AND actor.role = 'admin' AND actor.status = 'active'
            AND actor.account_kind = 'human' AND actor.login_capable = 1 AND actor.console_session_epoch = ?5
            AND substr(actor.canonical_email, instr(actor.canonical_email, '@') + 1) = ?7
          ))
          AND NOT EXISTS (
            SELECT 1 FROM users AS other
            WHERE other.id <> users.id AND other.canonical_email = ?1
          )`,
      updateBindings: [canonical, at, userId, actor.userId, actor.sessionEpoch ?? 0, existing.console_session_epoch, organizationDomain(env) ?? ""],
      action: "user.email",
      meta: { previous_email: existing.canonical_email ?? existing.email, email: canonical },
    }, userId, at);
    if (!committed) await rejectLifecycle(env, actor, userId, "email", canonical);
  } catch (error) {
    if (isUniqueCanonical(error)) {
      throw new HttpError(409, "That email already belongs to another account.", "invalid_request_error", "email_conflict");
    }
    throw error;
  }
  return { id: userId, email: canonical, previous_email: existing.canonical_email ?? existing.email };
}

type LifecycleOp = "promote" | "demote" | "enable" | "disable" | "email";

interface LifecycleStatement {
  update: string;
  updateBindings: unknown[];
  action: string;
  meta: Record<string, string | null>;
}

async function commitLifecycle(
  env: Env,
  actor: LifecycleActor,
  statement: LifecycleStatement,
  userId: string,
  at: string
): Promise<boolean> {
  // changes() belongs to this transaction, so a rejected conditional update cannot insert a success audit.
  const results = await env.DB.batch([
    env.DB.prepare(statement.update).bind(...statement.updateBindings),
    env.DB.prepare(
      `INSERT INTO operator_mutation_audit (
         id, at, actor_kind, actor_email, actor_subject, actor_user_id, actor_role,
         action, target_type, target_id, result, request_id, meta, created_at
       )
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, 'user', ?, 'ok', ?, ?, ?
       WHERE changes() = 1`
    ).bind(
      generateId("oma"),
      at,
      actor.kind,
      actor.email,
      actor.subject,
      actor.userId,
      actor.role,
      statement.action,
      userId,
      actor.requestId,
      JSON.stringify(statement.meta),
      at
    )
  ]);
  return changedRows(results[1]) === 1;
}

async function provisionLoginUser(
  env: Env,
  email: string,
  now: Date,
  audit: ConsoleAccessAudit
): Promise<void> {
  const id = generateId("usr");
  const at = nowIso(now);
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO users (
         id, email, canonical_email, role, status, login_capable, account_kind, created_at, updated_at
       )
       SELECT ?, ?, ?, 'user', 'active', 1, 'human', ?, ?
       WHERE NOT EXISTS (SELECT 1 FROM users WHERE canonical_email = ?)`
    ).bind(id, email, email, at, at, email),
    env.DB.prepare(
      `INSERT INTO operator_mutation_audit (
         id, at, actor_kind, actor_email, actor_subject, actor_user_id, actor_role,
         action, target_type, target_id, result, request_id, meta, created_at
       )
       SELECT ?, ?, 'access', ?, ?, ?, 'user', 'user.jit', 'user', ?, 'ok', ?, ?, ?
       WHERE changes() = 1`
    ).bind(
      generateId("oma"),
      at,
      email,
      audit.subject,
      id,
      id,
      audit.requestId,
      JSON.stringify({ role: "user", status: "active" }),
      at
    )
  ]);
}

async function rejectLifecycle(
  env: Env,
  actor: LifecycleActor,
  userId: string,
  op: LifecycleOp,
  email?: string
): Promise<never> {
  if (actor.userId) {
    const actorRow = await loadUser(env, actor.userId);
    if (!actorRow || actorRow.role !== "admin" || actorRow.status !== "active" || actorRow.login_capable !== 1
      || actorRow.console_session_epoch !== (actor.sessionEpoch ?? 0) || !isOrganizationLoginUser(env, actorRow)) {
      throw new HttpError(403, "Admin authentication required", "authentication_error", "admin_required");
    }
  }
  const target = await loadUser(env, userId);
  if (!target) {
    throw new HttpError(404, "User not found", "invalid_request_error", "user_not_found");
  }
  if ((op === "demote" || op === "disable") && target.role === "admin" && target.status === "active" && isOrganizationLoginUser(env, target)) {
    if (await countActiveAdmins(env) < 2) {
      throw new HttpError(409, "At least one active administrator must remain.", "invalid_request_error", "last_active_admin");
    }
  }
  if (op === "email" && email && await env.DB.prepare("SELECT 1 FROM users WHERE canonical_email = ? AND id <> ? LIMIT 1").bind(email, userId).first()) {
    throw new HttpError(409, "That email already belongs to another account.", "invalid_request_error", "email_conflict");
  }
  throw new HttpError(409, "The account change was rejected.", "invalid_request_error", "lifecycle_rejected");
}

function activePrincipal(user: StoredUser): ConsolePrincipal {
  if (user.account_kind !== "human") throw ambiguousIdentity();
  if (user.status !== "active") {
    throw new HttpError(403, "User is not active", "authentication_error", "user_inactive");
  }
  if (user.role !== "admin" && user.role !== "user") {
    throw new HttpError(403, "Admin authentication required", "authentication_error", "admin_auth_required");
  }
  return {
    id: user.id,
    email: user.canonical_email ?? "",
    role: user.role,
    status: "active",
    sessionEpoch: user.console_session_epoch
  };
}

function ambiguousIdentity(): HttpError {
  return new HttpError(403, "This email cannot be matched to one account.", "authentication_error", "ambiguous_identity");
}

async function requireTarget(env: Env, userId: string): Promise<StoredUser> {
  const user = await loadUser(env, userId);
  if (!user) throw new HttpError(404, "User not found", "invalid_request_error", "user_not_found");
  return user;
}

async function findLoginUser(env: Env, email: string): Promise<StoredUser | null> {
  return env.DB.prepare(
    `SELECT id, email, canonical_email, role, status, login_capable, account_kind, console_session_epoch, created_at, updated_at
     FROM users WHERE canonical_email = ? AND login_capable = 1 AND account_kind = 'human'`
  ).bind(email).first<StoredUser>();
}

async function loadUser(env: Env, id: string): Promise<StoredUser | null> {
  return env.DB.prepare(
    `SELECT id, email, canonical_email, role, status, login_capable, account_kind, console_session_epoch, created_at, updated_at
     FROM users WHERE id = ?`
  ).bind(id).first<StoredUser>();
}

async function countCanonical(env: Env, email: string): Promise<number> {
  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS count FROM users WHERE canonical_email = ?"
  ).bind(email).first<{ count: number }>();
  return Number(row?.count ?? 0);
}

/** Legacy login_capable flags predate the mailbox validator. Validate candidates
 * once with that parser, then require the same mailbox/epoch and live role/status
 * in the committing SQL. A stale snapshot can reject, never remove the last admin. */
async function verifiedAdminCandidates(env: Env): Promise<Array<{ id: string; email: string; epoch: number }>> {
  const rows = await env.DB.prepare(
    "SELECT id, canonical_email, login_capable, account_kind, console_session_epoch FROM users WHERE role = 'admin' AND status = 'active' AND login_capable = 1 AND account_kind = 'human'"
  ).all<{ id: string; canonical_email: string; login_capable: number; account_kind: "human"; console_session_epoch: number }>();
  return rows.results.filter(user => isOrganizationLoginUser(env, user))
    .map(user => ({ id: user.id, email: user.canonical_email, epoch: user.console_session_epoch }));
}

async function countActiveAdmins(env: Env): Promise<number> {
  return (await verifiedAdminCandidates(env)).length;
}

function changedRows(result: unknown): number {
  if (!result || typeof result !== "object" || !("meta" in result)) return 0;
  const changes = (result as { meta?: { changes?: number } }).meta?.changes;
  return typeof changes === "number" ? changes : 0;
}

function isUniqueCanonical(error: unknown): boolean {
  const message = error instanceof Error ? error.message : "";
  return message.includes("UNIQUE constraint failed") && message.includes("canonical_email");
}

export function organizationMailbox(env: Env, value: unknown): string {
  const email = canonicalMailbox(value);
  if (!email) throw new HttpError(400, "Enter a valid organization email address.", "invalid_request_error", "invalid_email");
  const domain = organizationDomain(env);
  if (!domain || email.slice(email.lastIndexOf("@") + 1) !== domain) {
    throw new HttpError(400, "Use an email address in the organization's domain.", "invalid_request_error", "invalid_email_domain");
  }
  return email;
}

export function organizationDomain(env: Env): string | null {
  const domain = env.CONSOLE_EMAIL_DOMAIN?.trim().toLowerCase();
  return domain && /^[a-z0-9.-]+$/.test(domain) && !domain.includes("..") && !domain.startsWith(".") && !domain.endsWith(".") ? domain : null;
}

export function isOrganizationLoginUser(env: Env, user: { login_capable?: number; canonical_email?: string | null; account_kind?: string }): boolean {
  const domain = organizationDomain(env);
  return Boolean(domain && user.account_kind === "human" && user.login_capable === 1 && user.canonical_email
    && canonicalMailbox(user.canonical_email) === user.canonical_email
    && user.canonical_email.slice(user.canonical_email.lastIndexOf("@") + 1) === domain);
}
