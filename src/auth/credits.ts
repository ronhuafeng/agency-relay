import { isOrganizationLoginUser, organizationDomain } from "./principal";
import { generateId, nowIso } from "../crypto";
import { getUser } from "../db";
import { HttpError } from "../errors";
import { ISSUABLE_SURFACE_GRANTS, type ExecutionPlan } from "../plans/execution-plans";

export const CREDIT_SURFACE_IDS = ["codex", "grok", "xai"] as const;
export type CreditSurfaceId = typeof CREDIT_SURFACE_IDS[number];
export type SurfaceGrant = ExecutionPlan["surfaceGrant"];
export type CreditSource = "personal" | "organization" | "unconfigured";
export type CreditMode = "unlimited" | "limited" | "disabled";
export type ExplicitCreditMode = "unlimited" | "disabled";

export const XAI_SHARED_PROVIDER_AUTHORITY =
  "A positive xAI allowance delegates the bound provider team's capabilities. It does not isolate those provider resources.";

export interface SurfaceCreditPolicyRow {
  user_id: string;
  surface_grant: SurfaceGrant;
  monthly_allowance: number;
  created_at: string;
  updated_at: string;
}

export interface SurfaceCreditState {
  user_id: string;
  surface_grant: SurfaceGrant;
  mode: CreditMode;
  monthly_allowance: number | null;
  source: CreditSource;
  period_start: string;
  reset_at: string;
  consumed_credits: number;
  admitted_attempts: number;
  last_seen_at: string | null;
  remaining_credits: number | null;
}

export interface CreditAuditActor {
  kind: "access" | "admin_secret";
  email: string | null;
  subject: string | null;
  userId: string | null;
  role: "admin" | "user" | null;
  requestId: string | null;
  sessionEpoch?: number;
}

const FINITE_ALLOWANCE = `COALESCE(
  (SELECT monthly_allowance FROM user_surface_credit_policies
    WHERE user_id = ?1 AND surface_grant = ?2),
  (SELECT monthly_allowance FROM organization_surface_credit_defaults
    WHERE surface_grant = ?2)
)`;

const UNLIMITED_MODE = `EXISTS (
  SELECT 1 FROM user_surface_credit_modes
  WHERE user_id = ?1 AND surface_grant = ?2 AND mode = 'unlimited'
)`;

const PERSONAL_MODE = `EXISTS (
  SELECT 1 FROM user_surface_credit_modes
  WHERE user_id = ?1 AND surface_grant = ?2
)`;

/** Positive issuance is allowed for explicit Unlimited or a positive finite cap. */
export function sqlSurfaceEntitled(surfaceExpression: string): string {
  return `(
    EXISTS (
      SELECT 1 FROM user_surface_credit_modes
      WHERE user_id = ? AND surface_grant = ${surfaceExpression} AND mode = 'unlimited'
    )
    OR (
      NOT EXISTS (
        SELECT 1 FROM user_surface_credit_modes
        WHERE user_id = ? AND surface_grant = ${surfaceExpression} AND mode = 'disabled'
      )
      AND COALESCE(
        (SELECT monthly_allowance FROM user_surface_credit_policies
          WHERE user_id = ? AND surface_grant = ${surfaceExpression}),
        (SELECT monthly_allowance FROM organization_surface_credit_defaults
          WHERE surface_grant = ${surfaceExpression})
      ) > 0
    )
  )`;
}

export function surfaceGrantForCreditId(surfaceId: string): SurfaceGrant {
  if (!CREDIT_SURFACE_IDS.includes(surfaceId as CreditSurfaceId)) {
    throw new HttpError(400, "Surface must be codex, grok, or xai", "invalid_request_error", "invalid_surface");
  }
  const grant = `surface:${surfaceId}:production` as SurfaceGrant;
  if (!ISSUABLE_SURFACE_GRANTS.has(grant)) {
    throw new HttpError(400, "Surface is not issuable", "invalid_request_error", "invalid_surface");
  }
  return grant;
}

export async function getSurfaceCreditPolicy(
  env: Env,
  userId: string,
  surfaceGrant: SurfaceGrant
): Promise<SurfaceCreditPolicyRow | null> {
  return env.DB.prepare(
    `SELECT user_id, surface_grant, monthly_allowance, created_at, updated_at
     FROM user_surface_credit_policies
     WHERE user_id = ? AND surface_grant = ?
     LIMIT 1`
  ).bind(userId, surfaceGrant).first<SurfaceCreditPolicyRow>();
}

export async function listSurfaceCreditStates(
  env: Env,
  now: Date,
  userId: string
): Promise<SurfaceCreditState[]> {
  const periodStart = monthlyPeriodStart(now);
  const resetAt = monthlyResetAt(now);
  const result = await env.DB.prepare(
    `WITH surfaces(surface_grant) AS (
       VALUES ('surface:codex:production'), ('surface:grok:production'), ('surface:xai:production')
     )
     SELECT
       surfaces.surface_grant AS surface_grant,
       CASE
         WHEN explicit.mode = 'unlimited' THEN 'unlimited'
         WHEN explicit.mode = 'disabled' THEN 'disabled'
         WHEN personal.user_id IS NOT NULL OR organization.surface_grant IS NOT NULL THEN 'limited'
         ELSE 'disabled'
       END AS mode,
       CASE
         WHEN explicit.user_id IS NOT NULL THEN NULL
         ELSE COALESCE(personal.monthly_allowance, organization.monthly_allowance)
       END AS monthly_allowance,
       CASE
         WHEN explicit.user_id IS NOT NULL OR personal.user_id IS NOT NULL THEN 'personal'
         WHEN organization.surface_grant IS NOT NULL THEN 'organization'
         ELSE 'unconfigured'
       END AS source,
       COALESCE(usage.consumed_credits, 0) AS consumed_credits,
       COALESCE(usage.admitted_attempts, 0) AS admitted_attempts,
       usage.last_seen_at AS last_seen_at
     FROM surfaces
     LEFT JOIN user_surface_credit_modes AS explicit
       ON explicit.user_id = ? AND explicit.surface_grant = surfaces.surface_grant
     LEFT JOIN user_surface_credit_policies AS personal
       ON personal.user_id = ? AND personal.surface_grant = surfaces.surface_grant
     LEFT JOIN organization_surface_credit_defaults AS organization
       ON organization.surface_grant = surfaces.surface_grant
     LEFT JOIN user_surface_credit_usage AS usage
       ON usage.user_id = ?
      AND usage.surface_grant = surfaces.surface_grant
      AND usage.period_start = ?
     ORDER BY surfaces.surface_grant`
  ).bind(userId, userId, userId, periodStart).all<{
    surface_grant: SurfaceGrant;
    mode: CreditMode;
    monthly_allowance: number | null;
    source: CreditSource;
    consumed_credits: number;
    admitted_attempts: number;
    last_seen_at: string | null;
  }>();
  return (result.results ?? []).map((row) => {
    const consumed = finiteAllowance(row.consumed_credits);
    const allowance = row.monthly_allowance === null ? null : finiteAllowance(row.monthly_allowance);
    return {
      user_id: userId,
      surface_grant: row.surface_grant,
      mode: row.mode,
      monthly_allowance: row.mode === "limited" ? allowance : null,
      source: row.source,
      period_start: periodStart,
      reset_at: resetAt,
      consumed_credits: consumed,
      admitted_attempts: finiteAllowance(row.admitted_attempts),
      last_seen_at: row.last_seen_at,
      remaining_credits: row.mode === "limited" && allowance !== null ? Math.max(0, allowance - consumed) : null
    };
  });
}

export async function listOrganizationCreditDefaults(env: Env): Promise<Array<{
  surface_grant: SurfaceGrant;
  monthly_allowance: number;
  shared_provider_authority?: string;
}>> {
  const result = await env.DB.prepare(
    `SELECT surface_grant, monthly_allowance
     FROM organization_surface_credit_defaults
     ORDER BY surface_grant`
  ).all<{ surface_grant: SurfaceGrant; monthly_allowance: number }>();
  return (result.results ?? []).map((row) => withXaiAuthority({
    surface_grant: row.surface_grant,
    monthly_allowance: finiteAllowance(row.monthly_allowance)
  }));
}

export async function commitPersonalCreditPolicy(
  env: Env,
  actor: CreditAuditActor,
  input: {
    user_id: string;
    surface_grant: SurfaceGrant;
    mode?: CreditMode;
    monthly_allowance: number | null;
    previous_mode?: CreditMode | null;
    previous_monthly_allowance: number | null;
  },
  now = new Date()
): Promise<SurfaceCreditState> {
  const mode = input.mode ?? "limited";
  if (mode === "limited") {
    if (input.monthly_allowance === null) {
      throw new HttpError(400, "A limited policy needs a monthly allowance.", "invalid_request_error", "invalid_monthly_allowance");
    }
    assertMonthlyAllowance(input.monthly_allowance);
  } else if (input.monthly_allowance !== null) {
    throw new HttpError(400, "Unlimited and disabled policies do not take a monthly allowance.", "invalid_request_error", "invalid_credit_policy");
  }
  if (!await getUser(env, input.user_id)) {
    throw new HttpError(404, "User not found", "invalid_request_error", "user_not_found");
  }
  const at = nowIso(now);
  const meta = {
    user_id: input.user_id,
    surface_grant: input.surface_grant,
    previous_mode: input.previous_mode ?? null,
    mode,
    previous_monthly_allowance: input.previous_monthly_allowance,
    monthly_allowance: input.monthly_allowance
  };
  if (mode === "limited") {
    await commitCreditMutation(env, actor, {
      prelude: [{
        statement: (authority) => `DELETE FROM user_surface_credit_modes WHERE user_id = ? AND surface_grant = ? AND ${authority}`,
        bindings: [input.user_id, input.surface_grant]
      }],
      statement: (authority) => `INSERT INTO user_surface_credit_policies
           (user_id, surface_grant, monthly_allowance, created_at, updated_at)
         SELECT ?, ?, ?, ?, ? WHERE ${authority}
         ON CONFLICT(user_id, surface_grant) DO UPDATE SET
           monthly_allowance = excluded.monthly_allowance,
           updated_at = excluded.updated_at`,
      bindings: [input.user_id, input.surface_grant, input.monthly_allowance, at, at],
      action: "credit_policy.set",
      targetId: `${input.user_id}:${input.surface_grant}`,
      meta
    }, at);
  } else {
    await commitCreditMutation(env, actor, {
      prelude: [{
        statement: (authority) => `DELETE FROM user_surface_credit_policies WHERE user_id = ? AND surface_grant = ? AND ${authority}`,
        bindings: [input.user_id, input.surface_grant]
      }],
      statement: (authority) => `INSERT INTO user_surface_credit_modes
           (user_id, surface_grant, mode, created_at, updated_at)
         SELECT ?, ?, ?, ?, ? WHERE ${authority}
         ON CONFLICT(user_id, surface_grant) DO UPDATE SET
           mode = excluded.mode,
           updated_at = excluded.updated_at`,
      bindings: [input.user_id, input.surface_grant, mode, at, at],
      action: "credit_policy.set",
      targetId: `${input.user_id}:${input.surface_grant}`,
      meta
    }, at);
  }
  return requireState(await listSurfaceCreditStates(env, now, input.user_id), input.surface_grant);
}

export async function clearPersonalCreditPolicy(
  env: Env,
  actor: CreditAuditActor,
  input: { user_id: string; surface_grant: SurfaceGrant; previous_monthly_allowance: number | null },
  now = new Date()
): Promise<{ deleted: boolean; state: SurfaceCreditState }> {
  if (!await getUser(env, input.user_id)) {
    throw new HttpError(404, "User not found", "invalid_request_error", "user_not_found");
  }
  const at = nowIso(now);
  const removedMode = await commitCreditMutation(env, actor, {
    statement: (authority) => `DELETE FROM user_surface_credit_modes WHERE user_id = ? AND surface_grant = ? AND ${authority}`,
    bindings: [input.user_id, input.surface_grant],
    action: "credit_policy.delete",
    targetId: `${input.user_id}:${input.surface_grant}`,
    meta: {
      user_id: input.user_id,
      surface_grant: input.surface_grant,
      previous_monthly_allowance: input.previous_monthly_allowance
    }
  }, at);
  const removedPolicy = await commitCreditMutation(env, actor, {
    statement: (authority) => `DELETE FROM user_surface_credit_policies WHERE user_id = ? AND surface_grant = ? AND ${authority}`,
    bindings: [input.user_id, input.surface_grant],
    action: "credit_policy.delete",
    targetId: `${input.user_id}:${input.surface_grant}`,
    meta: {
      user_id: input.user_id,
      surface_grant: input.surface_grant,
      previous_monthly_allowance: input.previous_monthly_allowance
    }
  }, at);
  const deleted = removedMode || removedPolicy;
  return {
    deleted,
    state: requireState(await listSurfaceCreditStates(env, now, input.user_id), input.surface_grant)
  };
}

export interface OrganizationCreditDefaultChange {
  readonly surface_grant: SurfaceGrant;
  readonly monthly_allowance: number;
  readonly expected_monthly_allowance: number;
}

export async function commitOrganizationCreditDefaults(
  env: Env,
  actor: CreditAuditActor,
  input: readonly OrganizationCreditDefaultChange[],
  now = new Date()
): Promise<Array<{ surface_grant: SurfaceGrant; monthly_allowance: number; shared_provider_authority?: string }>> {
  if (!input.length || input.length > CREDIT_SURFACE_IDS.length || new Set(input.map(row => row.surface_grant)).size !== input.length
    || input.some(row => !ISSUABLE_SURFACE_GRANTS.has(row.surface_grant))) {
    throw new HttpError(400, "Provide distinct supported organization defaults.", "invalid_request_error", "invalid_credit_defaults");
  }
  for (const row of input) { assertMonthlyAllowance(row.monthly_allowance); assertMonthlyAllowance(row.expected_monthly_allowance); }
  assertCreditActor(env, actor);
  const at = nowIso(now);
  const requested = JSON.stringify(input.map(row => ({...row, audit_id:generateId("oma")})));
  const results = await env.DB.batch([
    prepareCreditStatement(env, actor, {
      // Materialize the complete pre-update predicate. Re-evaluating it per
      // updated row could otherwise stop after a partial change.
      statement: authority => `WITH requested AS MATERIALIZED (
        SELECT json_extract(value, '$.surface_grant') AS surface_grant,
          json_extract(value, '$.monthly_allowance') AS monthly_allowance,
          json_extract(value, '$.expected_monthly_allowance') AS expected
        FROM json_each(?1)
      ), eligible AS MATERIALIZED (
        SELECT 1 WHERE ${authority} AND (
          SELECT COUNT(*) FROM requested JOIN organization_surface_credit_defaults AS current
          ON current.surface_grant = requested.surface_grant AND current.monthly_allowance = requested.expected
        ) = json_array_length(?1)
      ) UPDATE organization_surface_credit_defaults AS policy
        SET monthly_allowance = (SELECT monthly_allowance FROM requested WHERE requested.surface_grant = policy.surface_grant), updated_at = ?2
        WHERE policy.surface_grant IN (SELECT surface_grant FROM requested) AND EXISTS (SELECT 1 FROM eligible)`,
      bindings:[requested,at]
    }),
    env.DB.prepare(`INSERT INTO operator_mutation_audit (
      id, at, actor_kind, actor_email, actor_subject, actor_user_id, actor_role,
      action, target_type, target_id, result, request_id, meta, created_at
    ) SELECT json_extract(value, '$.audit_id'), ?2, ?3, ?4, ?5, ?6, ?7,
      'credit_default.set', 'surface_credit', json_extract(value, '$.surface_grant'), 'ok', ?8,
      json_object('surface_grant', json_extract(value, '$.surface_grant'),
        'previous_monthly_allowance', json_extract(value, '$.expected_monthly_allowance'),
        'monthly_allowance', json_extract(value, '$.monthly_allowance')), ?2
      FROM json_each(?1) WHERE changes() = json_array_length(?1)`)
      .bind(requested,at,actor.kind,actor.email,actor.subject,actor.userId,actor.role,actor.requestId)
  ]);
  if (changedRows(results[0]) !== input.length || changedRows(results[1]) !== input.length) {
    await assertCurrentCreditAdmin(env, actor);
    throw new HttpError(409, "Organization defaults changed. Read current defaults before saving.", "invalid_request_error", "credit_defaults_changed");
  }
  return input.map(({surface_grant,monthly_allowance}) => withXaiAuthority({surface_grant,monthly_allowance}));
}

export async function assertIssuanceEntitlement(
  env: Env,
  userId: string,
  grants: readonly string[],
  now = new Date()
): Promise<void> {
  const states = await listSurfaceCreditStates(env, now, userId);
  const denied = grants.filter((grant) => {
    const state = states.find((candidate) => candidate.surface_grant === grant);
    return state === undefined || !creditStateEntitlesIssuance(state);
  });
  if (denied.length > 0) {
    throw new HttpError(
      403,
      "Every selected surface needs a positive allowance.",
      "invalid_request_error",
      "surface_not_entitled"
    );
  }
}

export async function consumeSurfaceCredits(
  env: Env,
  input: {
    user_id: string;
    surface_grant: SurfaceGrant;
    plan_id: string;
    credit_charge: number;
  },
  now = new Date()
): Promise<void> {
  if (!Number.isSafeInteger(input.credit_charge) || input.credit_charge < 0) {
    throw new Error(`Invalid Credit Charge for ${input.plan_id}`);
  }
  if (input.credit_charge === 0) {
    const resolved = await readResolvedCredit(env, input.user_id, input.surface_grant);
    if (resolved.mode === "disabled") throw surfaceDisabled();
    return;
  }
  const periodStart = monthlyPeriodStart(now);
  const timestamp = nowIso(now);
  const [admission] = await env.DB.batch([env.DB.prepare(
    `INSERT INTO user_surface_credit_usage
       (user_id, surface_grant, period_start, consumed_credits, admitted_attempts, last_seen_at)
     SELECT ?1, ?2, ?3, ?4, 1, ?5
     WHERE ${UNLIMITED_MODE}
        OR (
          NOT ${PERSONAL_MODE}
          AND (${FINITE_ALLOWANCE}) IS NOT NULL
          AND ?4 <= (${FINITE_ALLOWANCE}) - COALESCE((
            SELECT consumed_credits FROM user_surface_credit_usage
            WHERE user_id = ?1 AND surface_grant = ?2 AND period_start = ?3
          ), 0)
        )
     ON CONFLICT(user_id, surface_grant, period_start) DO UPDATE SET
       consumed_credits = user_surface_credit_usage.consumed_credits + excluded.consumed_credits,
       admitted_attempts = user_surface_credit_usage.admitted_attempts + 1,
       last_seen_at = excluded.last_seen_at
     WHERE ${UNLIMITED_MODE}
        OR user_surface_credit_usage.consumed_credits + excluded.consumed_credits <= (${FINITE_ALLOWANCE})`
  ).bind(
    input.user_id,
    input.surface_grant,
    periodStart,
    input.credit_charge,
    timestamp
  )]);
  if ((admission?.meta.changes ?? 0) > 0) return;
  const resolved = await readResolvedCredit(env, input.user_id, input.surface_grant);
  if (resolved.mode !== "limited" || (resolved.monthly_allowance ?? 0) <= 0) throw surfaceDisabled();
  throw surfaceExhausted(input, now);
}

export async function consumeExecutionPlanCredits(
  env: Env,
  userId: string,
  plan: ExecutionPlan,
  now: Date
): Promise<void> {
  await consumeSurfaceCredits(env, {
    user_id: userId,
    surface_grant: plan.surfaceGrant,
    plan_id: plan.id,
    credit_charge: plan.creditCharge
  }, now);
}

export function monthlyPeriodStart(now: Date): string {
  return `${now.toISOString().slice(0, 7)}-01`;
}

export function monthlyResetAt(now: Date): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString();
}

export function assertMonthlyAllowance(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new HttpError(
      400,
      "monthly_allowance must be a non-negative safe integer",
      "invalid_request_error",
      "invalid_monthly_allowance"
    );
  }
}

async function commitCreditMutation(
  env: Env,
  actor: CreditAuditActor,
  input: {
    statement: (authority: string) => string;
    bindings: unknown[];
    prelude?: Array<{ statement: (authority: string) => string; bindings: unknown[] }>;
    action: string;
    targetId: string;
    meta: Record<string, string | number | null>;
  },
  at: string
): Promise<boolean> {
  assertCreditActor(env, actor);
  const prepare = (step: { statement: (authority: string) => string; bindings: unknown[] }) => prepareCreditStatement(env, actor, step);
  const results = await env.DB.batch([
    ...(input.prelude ?? []).map(prepare),
    prepare(input),
    env.DB.prepare(
      `INSERT INTO operator_mutation_audit (
         id, at, actor_kind, actor_email, actor_subject, actor_user_id, actor_role,
         action, target_type, target_id, result, request_id, meta, created_at
       )
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, 'surface_credit', ?, 'ok', ?, ?, ?
       WHERE changes() = 1`
    ).bind(
      generateId("oma"),
      at,
      actor.kind,
      actor.email,
      actor.subject,
      actor.userId,
      actor.role,
      input.action,
      input.targetId,
      actor.requestId,
      JSON.stringify(input.meta),
      at
    )
  ]);
  const changed = changedRows(results[results.length - 1]) === 1;
  if (!changed) await assertCurrentCreditAdmin(env, actor);
  if (!changed && input.action === "credit_policy.set") throw new HttpError(409, "The policy change was rejected. Review current authority and try again.", "invalid_request_error", "credit_policy_rejected");
  return changed;
}
function assertCreditActor(env: Env, actor: CreditAuditActor): void {
  if (actor.kind !== "admin_secret" && (!actor.userId || !isOrganizationLoginUser(env, {account_kind:"human",login_capable:1,canonical_email:actor.email}))) throw creditAdminRequired();
}
function prepareCreditStatement(env: Env, actor: CreditAuditActor, step: {statement:(authority:string)=>string;bindings:unknown[]}): D1PreparedStatement {
  const snapshot = `?${step.bindings.length + 1}`;
  const authority = actor.kind === "admin_secret" ? "1 = 1" : `EXISTS (
    SELECT 1 FROM users AS actor WHERE actor.id = json_extract(${snapshot}, '$.id')
      AND actor.account_kind = 'human' AND actor.role = 'admin' AND actor.status = 'active'
      AND actor.login_capable = 1 AND actor.canonical_email = json_extract(${snapshot}, '$.email')
      AND actor.console_session_epoch = json_extract(${snapshot}, '$.epoch')
      AND substr(actor.canonical_email, instr(actor.canonical_email, '@') + 1) = json_extract(${snapshot}, '$.domain')
  )`;
  return env.DB.prepare(step.statement(authority)).bind(...step.bindings, ...(actor.kind === "admin_secret" ? [] : [JSON.stringify({id:actor.userId,email:actor.email,epoch:actor.sessionEpoch ?? 0,domain:organizationDomain(env)})]));
}
async function assertCurrentCreditAdmin(env: Env, actor: CreditAuditActor): Promise<void> {
  if (actor.kind === "admin_secret") return;
  const current = await env.DB.prepare("SELECT account_kind, canonical_email, login_capable, role, status, console_session_epoch FROM users WHERE id = ?").bind(actor.userId).first<{account_kind:string;canonical_email:string;login_capable:number;role:string;status:string;console_session_epoch:number}>();
  if (!current || current.role !== "admin" || current.status !== "active" || !isOrganizationLoginUser(env,current) || current.canonical_email !== actor.email || current.console_session_epoch !== (actor.sessionEpoch ?? 0)) throw creditAdminRequired();
}
function creditAdminRequired(): HttpError {
  return new HttpError(403, "Admin authentication required", "authentication_error", "admin_required");
}

function creditStateEntitlesIssuance(state: SurfaceCreditState): boolean {
  return state.mode === "unlimited" || (state.mode === "limited" && (state.monthly_allowance ?? 0) > 0);
}

async function readResolvedCredit(
  env: Env,
  userId: string,
  surfaceGrant: SurfaceGrant
): Promise<{ mode: CreditMode; monthly_allowance: number | null }> {
  const row = await env.DB.prepare(
    `SELECT
       CASE
         WHEN ${UNLIMITED_MODE} THEN 'unlimited'
         WHEN EXISTS (
           SELECT 1 FROM user_surface_credit_modes
           WHERE user_id = ?1 AND surface_grant = ?2 AND mode = 'disabled'
         ) THEN 'disabled'
         WHEN ${FINITE_ALLOWANCE} IS NOT NULL THEN 'limited'
         ELSE 'disabled'
       END AS mode,
       CASE
         WHEN ${PERSONAL_MODE} THEN NULL
         ELSE (${FINITE_ALLOWANCE})
       END AS monthly_allowance`
  ).bind(userId, surfaceGrant).first<{ mode: CreditMode; monthly_allowance: number | null }>();
  if (!row || (row.mode !== "unlimited" && row.mode !== "limited" && row.mode !== "disabled")) {
    throw new HttpError(503, "Allowance is unavailable.", "server_error", "credit_read_unavailable");
  }
  return {
    mode: row.mode,
    monthly_allowance: row.monthly_allowance === null ? null : finiteAllowance(row.monthly_allowance)
  };
}

function finiteAllowance(value: unknown): number {
  const allowance = typeof value === "bigint" ? Number(value) : typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(allowance) || allowance < 0) {
    throw new HttpError(503, "Allowance is unavailable.", "server_error", "credit_configuration_invalid");
  }
  return allowance;
}

function requireState(states: SurfaceCreditState[], surfaceGrant: SurfaceGrant): SurfaceCreditState {
  const state = states.find((candidate) => candidate.surface_grant === surfaceGrant);
  if (!state) {
    throw new HttpError(503, "Allowance is unavailable.", "server_error", "credit_read_unavailable");
  }
  return state;
}

function withXaiAuthority<T extends { surface_grant: SurfaceGrant }>(value: T): T & { shared_provider_authority?: string } {
  return value.surface_grant === "surface:xai:production"
    ? { ...value, shared_provider_authority: XAI_SHARED_PROVIDER_AUTHORITY }
    : value;
}

function surfaceDisabled(): HttpError {
  return new HttpError(403, "This surface is not enabled.", "invalid_request_error", "surface_disabled");
}

function surfaceExhausted(input: { user_id: string; surface_grant: string; plan_id: string; credit_charge: number }, now: Date): HttpError {
  const resetAt = monthlyResetAt(now);
  const retryAfterSeconds = Math.max(1, Math.ceil((Date.parse(resetAt) - now.getTime()) / 1000));
  console.log(JSON.stringify({
    event: "surface_credit_exhausted",
    user_id: input.user_id,
    surface_grant: input.surface_grant,
    plan_id: input.plan_id,
    credit_charge: input.credit_charge,
    reset_at: resetAt
  }));
  return new HttpError(
    429,
    `Surface Credit exhausted; resets at ${resetAt}`,
    "rate_limit_error",
    "surface_credit_exhausted",
    {
      headers: new Headers({
        "Retry-After": String(retryAfterSeconds),
        "X-Mini-Credit-Reset-At": resetAt
      })
    }
  );
}

function changedRows(result: unknown): number {
  if (!result || typeof result !== "object" || !("meta" in result)) return 0;
  const changes = (result as { meta?: { changes?: number } }).meta?.changes;
  return typeof changes === "number" ? changes : 0;
}
