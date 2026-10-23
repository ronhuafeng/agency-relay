import { CODEX_SHARED_PRODUCTION_SQL, d1ChangeCount, OPERATOR_MUTATION_AUDIT_COLUMNS } from "../db";
import { generateId, nowIso } from "../crypto";
import { HttpError, codexAuthNotFound } from "../errors";
import { notifyCredentialChange } from "../admin/credential-notifications";
import type { CodexAuthRow } from "../types";
import type { CredentialActor } from "./credential-defaults";
import { assertServiceAdmin, serviceAdminAuthorityBindings, serviceAdminAuthoritySql } from "./service-accounts";

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
      WHERE id = ? AND ${CODEX_SHARED_PRODUCTION_SQL} AND ${serviceAdminAuthoritySql}`)
      .bind(admissionState, authId, ...authority),
    env.DB.prepare(`INSERT INTO operator_mutation_audit (${OPERATOR_MUTATION_AUDIT_COLUMNS})
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, 'codex_auth', ?, 'ok', ?, ?, ? WHERE changes() = 1`)
      .bind(generateId("oma"), at, actor.kind, actor.email, actor.subject, actor.userId, actor.role,
        admissionState === "paused" ? "credential.codex_pause" : "credential.codex_resume", authId,
        actor.requestId, JSON.stringify({ admission_state: admissionState }), at),
    env.DB.prepare(`SELECT * FROM codex_auths
      WHERE id = ? AND ${CODEX_SHARED_PRODUCTION_SQL} AND ${serviceAdminAuthoritySql}`)
      .bind(authId, ...authority)
  ]);
  if (d1ChangeCount(results[0]) !== 1 || d1ChangeCount(results[1]) !== 1) {
    await assertServiceAdmin(env, actor);
    throw codexAuthNotFound();
  }
  const auth = results[2]?.results?.[0] as CodexAuthRow | undefined;
  if (!auth || auth.admission_state !== admissionState) {
    throw new HttpError(503, "Read the account's current admission state before retrying.", "server_error", "credential_admission_unconfirmed");
  }
  await notifyCredentialChange(env);
  return auth;
}
