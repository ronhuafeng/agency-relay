import { generateId, nowIso } from "../crypto";
import { HttpError } from "../errors";
import { notifyCredentialChange } from "../admin/credential-notifications";
import type { CodexAuthRow } from "../types";
import type { CredentialActor } from "./credential-defaults";
import { serviceAdminAuthorityBindings, serviceAdminAuthoritySql } from "./service-accounts";

/** Set administrative admission only. Provider writes own credential health.
 * The mutation, success audit and authoritative readback share one D1 batch.
 * Repeated set-state commands are safe; each accepted command is audited.
 */
export async function commitCodexAdmission(
  env: Env,
  actor: CredentialActor,
  authId: string,
  admissionState: CodexAuthRow["admission_state"],
  now = new Date()
): Promise<CodexAuthRow> {
  const authority = serviceAdminAuthorityBindings(env, actor);
  const at = nowIso(now);
  const results = await env.DB.batch([
    env.DB.prepare(`UPDATE codex_auths SET admission_state = ?
      WHERE id = ? AND kind = 'shared' AND environment = 'production' AND ${serviceAdminAuthoritySql}`)
      .bind(admissionState, authId, ...authority),
    env.DB.prepare(`INSERT INTO operator_mutation_audit (
      id, at, actor_kind, actor_email, actor_subject, actor_user_id, actor_role,
      action, target_type, target_id, result, request_id, meta, created_at
    ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, 'codex_auth', ?, 'ok', ?, ?, ? WHERE changes() = 1`)
      .bind(generateId("oma"), at, actor.kind, actor.email, actor.subject, actor.userId, actor.role,
        admissionState === "paused" ? "credential.codex_pause" : "credential.codex_resume", authId,
        actor.requestId, JSON.stringify({ admission_state: admissionState }), at),
    env.DB.prepare(`SELECT * FROM codex_auths
      WHERE id = ? AND kind = 'shared' AND environment = 'production' AND ${serviceAdminAuthoritySql}`)
      .bind(authId, ...authority)
  ]);
  if (results[0]?.meta.changes !== 1 || results[1]?.meta.changes !== 1) {
    const current = await env.DB.prepare(`SELECT 1 AS authorized WHERE ${serviceAdminAuthoritySql}`)
      .bind(...authority).first();
    if (!current) throw new HttpError(403, "Admin authentication required", "authentication_error", "admin_required");
    throw new HttpError(404, "ChatGPT Credential Account not found", "invalid_request_error", "codex_auth_not_found");
  }
  const auth = results[2]?.results?.[0] as CodexAuthRow | undefined;
  if (!auth || auth.admission_state !== admissionState) {
    throw new HttpError(503, "Read the account's current admission state before retrying.", "server_error", "credential_admission_unconfirmed");
  }
  await notifyCredentialChange(env);
  return auth;
}
