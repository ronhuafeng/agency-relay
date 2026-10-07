import { generateId, nowIso } from "../crypto";
import { HttpError } from "../errors";
import type { ConsolePrincipal, LifecycleActor } from "./principal";
import { organizationDomain } from "./principal";
import { keyActorAuthority } from "./key-authority";
import { serviceAdminAuthorityBindings, serviceAdminAuthoritySql } from "./service-accounts";

export interface ServiceContext { id: string; display_name: string; status: string }
export interface ServiceOwner { owner_user_id: string | null; owner_email: string | null; owner_status: string | null; revision: number }
const absent = () => new HttpError(404, "Service not found", "invalid_request_error", "service_not_found");
export async function delegatedService(env: Env, principal: ConsolePrincipal, id: string): Promise<ServiceContext> {
  const guard = keyActorAuthority({kind: "access", userId: principal.id, email: principal.email, sessionEpoch: principal.sessionEpoch, role: principal.role, subject: null, requestId: null, delegatedServiceId: id}, id);
  const service = await env.DB.prepare(`SELECT id, display_name, status FROM users WHERE id = ? AND account_kind = 'service' AND ${guard.sql}`)
    .bind(id, ...guard.values).first<ServiceContext>();
  if (!service) throw absent();
  return service;
}
export async function listDelegatedServices(env: Env, principal: ConsolePrincipal): Promise<ServiceContext[]> {
  // This is the assigned service list, even for admins; independent admin access
  // remains available from People without dumping the organization into /me.
  const result = await env.DB.prepare(`SELECT service.id, service.display_name, service.status FROM service_account_owners AS d
    JOIN users AS service ON service.id = d.service_user_id JOIN users AS actor ON actor.id = d.owner_user_id
    WHERE actor.id = ? AND actor.status = 'active' AND actor.account_kind = 'human' AND actor.login_capable = 1
      AND actor.canonical_email = ? AND actor.console_session_epoch = ? AND service.account_kind = 'service'
    ORDER BY service.display_name, service.id`).bind(principal.id, principal.email, principal.sessionEpoch).all<ServiceContext>();
  return result.results ?? [];
}
export async function readServiceOwner(env: Env, id: string): Promise<ServiceOwner> {
  return await env.DB.prepare(`SELECT d.owner_user_id, human.canonical_email AS owner_email, human.status AS owner_status, d.revision
    FROM service_account_owners AS d LEFT JOIN users AS human ON human.id = d.owner_user_id WHERE d.service_user_id = ?`)
    .bind(id).first<ServiceOwner>() ?? {owner_user_id: null, owner_email: null, owner_status: null, revision: 0};
}
/** Optimistic relation version prevents stale admin forms overwriting transfers,
 * including remove/reassign ABA. No service-owned data changes in this batch. */
export async function commitServiceOwner(env: Env, actor: LifecycleActor, id: string,
  input: {owner_user_id: string | null; expected_revision: number}, now = new Date()): Promise<ServiceOwner> {
  if (!Number.isSafeInteger(input.expected_revision) || input.expected_revision < 0) throw new HttpError(400, "Reopen the owner form.", "invalid_request_error", "invalid_service_owner_revision");
  const previous = await readServiceOwner(env,id);
  // Bind the audit snapshot to the reviewed version. The committing predicate
  // below then rejects any intervening transfer, including a guessed next version.
  if (previous.revision !== input.expected_revision) throw new HttpError(409, "Owner assignment was not changed. Review current administrator, service, owner and revision.", "invalid_request_error", "service_owner_changed");
  const at = nowIso(now);
  const results = await env.DB.batch([
    env.DB.prepare(`INSERT INTO service_account_owners (service_user_id, owner_user_id, revision, updated_at)
      SELECT ?, ?, ? + 1, ? WHERE EXISTS (SELECT 1 FROM users WHERE id = ? AND account_kind = 'service')
        AND COALESCE((SELECT revision FROM service_account_owners WHERE service_user_id = ?), 0) = ?
        AND (? IS NULL OR EXISTS (SELECT 1 FROM users AS human WHERE human.id = ?
          AND human.account_kind = 'human' AND human.status = 'active' AND human.login_capable = 1
          AND substr(human.canonical_email, instr(human.canonical_email, '@') + 1) = ?))
        AND ${serviceAdminAuthoritySql}
      ON CONFLICT(service_user_id) DO UPDATE SET owner_user_id = excluded.owner_user_id,
        revision = excluded.revision, updated_at = excluded.updated_at`)
      .bind(id, input.owner_user_id, input.expected_revision, at, id, id, input.expected_revision,
        input.owner_user_id, input.owner_user_id, organizationDomain(env) ?? "", ...serviceAdminAuthorityBindings(env, actor)),
    env.DB.prepare(`INSERT INTO operator_mutation_audit (id,at,actor_kind,actor_email,actor_subject,actor_user_id,actor_role,action,target_type,target_id,result,request_id,meta,created_at)
      SELECT ?,?,?,?,?,?,?,'service.owner.change','user',?,'ok',?,?,? WHERE changes() = 1`)
      .bind(generateId("oma"), at, actor.kind, actor.email, actor.subject, actor.userId, actor.role, id, actor.requestId,
        JSON.stringify({previous_owner_user_id:previous.owner_user_id,owner_user_id: input.owner_user_id, previous_revision: input.expected_revision, revision: input.expected_revision + 1, credentials_unchanged: true}), at)
  ]);
  if (results[1]?.meta.changes !== 1) throw new HttpError(409, "Owner assignment was not changed. Review current administrator, service, owner and revision.", "invalid_request_error", "service_owner_changed");
  return {owner_user_id: input.owner_user_id, owner_email: null, owner_status: null, revision: input.expected_revision + 1};
}
