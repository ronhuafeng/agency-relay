import { generateId, nowIso } from "../crypto";

export type OperatorMutationActorKind = "access" | "admin_secret";

export interface OperatorMutationAuditInput {
  actor_kind: OperatorMutationActorKind;
  actor_email?: string | null;
  actor_subject?: string | null;
  actor_user_id?: string | null;
  actor_role?: "admin" | "user" | null;
  action: string;
  target_type: string;
  target_id: string;
  result: "ok" | "error";
  request_id?: string | null;
  /** Secret-free JSON-serializable metadata (no tokens, no key plaintext, no ADMIN_SECRET). */
  meta?: Record<string, unknown> | null;
}

export const OPERATOR_MUTATION_AUDIT_COLUMNS = "id, at, actor_kind, actor_email, actor_subject, actor_user_id, actor_role, action, target_type, target_id, result, request_id, meta, created_at";

export function operatorMutationAuditStatement(
  env: Env,
  input: OperatorMutationAuditInput,
  now = new Date()
): D1PreparedStatement {
  const at = nowIso(now);
  const metaJson = input.meta == null ? null : JSON.stringify(sanitizeMutationMeta(input.meta));
  return env.DB.prepare(
    `INSERT INTO operator_mutation_audit (${OPERATOR_MUTATION_AUDIT_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    generateId("oma"),
    at,
    input.actor_kind,
    input.actor_email ?? null,
    input.actor_subject ?? null,
    input.actor_user_id ?? null,
    input.actor_role ?? null,
    input.action,
    input.target_type,
    input.target_id,
    input.result,
    input.request_id ?? null,
    metaJson,
    at
  );
}

export async function insertOperatorMutationAudit(
  env: Env,
  input: OperatorMutationAuditInput,
  now = new Date()
): Promise<void> {
  await operatorMutationAuditStatement(env, input, now).run();
}

const MUTATION_META_FORBIDDEN_KEYS = new Set([
  "token",
  "api_key",
  "plaintext",
  "access_token",
  "refresh_token",
  "id_token",
  "admin_secret",
  "password",
  "secret",
  "key_hash"
]);

function sanitizeMutationMeta(meta: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(meta)) {
    const lower = key.toLowerCase();
    if (MUTATION_META_FORBIDDEN_KEYS.has(lower) || lower.includes("token") || lower.includes("secret")) {
      continue;
    }
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean" || value === null) {
      out[key] = value;
    } else if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
      out[key] = value;
    }
  }
  return out;
}
