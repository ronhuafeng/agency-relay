import type { KeyActor } from "./api-keys";
import { HttpError } from "../errors";

/** Current console authority at the same SQL boundary as the key change. */
export function keyActorAuthority(actor: KeyActor, ownerId: string): { sql: string; values: unknown[] } {
  if (actor.kind === "admin_secret") return { sql: "1", values: [] };
  const delegated = actor.delegatedServiceId !== undefined;
  return {
    sql: `EXISTS (SELECT 1 FROM users AS key_actor
      WHERE key_actor.id = ? AND key_actor.status = 'active' AND key_actor.account_kind = 'human'
        AND key_actor.login_capable = 1 AND key_actor.canonical_email = ?
        AND key_actor.console_session_epoch = ?
        AND ${delegated ? `EXISTS (SELECT 1 FROM users AS service
          WHERE service.id = ? AND service.id = ? AND service.account_kind = 'service'
            AND (key_actor.role = 'admin' OR EXISTS (SELECT 1 FROM service_account_owners AS delegation
              WHERE delegation.service_user_id = service.id AND delegation.owner_user_id = key_actor.id)))`
          : `(key_actor.id = ? OR key_actor.role = 'admin')`})`,
    values: [actor.userId, actor.email, actor.sessionEpoch ?? 0, ownerId, ...(delegated ? [actor.delegatedServiceId] : [])]
  };
}
export async function assertKeyActorAuthority(env: Env, actor: KeyActor, ownerId: string): Promise<void> {
  const guard = keyActorAuthority(actor, ownerId);
  const result = await env.DB.prepare(`SELECT ${guard.sql} AS allowed`).bind(...guard.values).first<{allowed: number}>();
  if (result?.allowed !== 1 && actor.delegatedServiceId) throw new HttpError(404, "Service not found", "invalid_request_error", "service_not_found");
  if (result?.allowed !== 1) throw new HttpError(403, "Console authority changed before the key operation.", "authentication_error", "console_identity_changed");
}
