import { type AdminIdentity } from "../auth/authenticate";
import { userRole, userStatus } from "../auth/principal";
import { setUserStatus, setUserRole, changeUserEmail, type OperatorMutationContext } from "./operator-mutations";
import { getUser } from "../auth/access-store";
import { type SurfaceCredentialSelection } from "../auth/bindings";
import { firstString, isConfirmValue, isRecord } from "../records";
import { HttpError, adminRouteNotFound, requiredTrimmedString } from "../errors";
import { type AppDependencies, type RequestContext } from "../types";
import { type CodexAuthRow } from "../codex/types";
import { listSurfaceCreditStates, XAI_SHARED_PROVIDER_AUTHORITY } from "../auth/credits";

export type JsonObject = Record<string, unknown>;

export async function commitLifecycle(
  operator: OperatorMutationContext,
  userId: string,
  action: string,
  body: JsonObject
): Promise<unknown> {
  if (action === "role") {
    return setUserRole(operator, userId, userRole(requiredTrimmedString(body, "role")));
  }
  if (action === "status") {
    return setUserStatus(operator, userId, userStatus(requiredTrimmedString(body, "status")));
  }
  if (action === "email") return changeUserEmail(operator, userId, requiredTrimmedString(body, "email"));
  throw adminRouteNotFound();
}

export function ownerInput(body: JsonObject): {owner_user_id:string|null;expected_revision:number} {
  // A missing/unsuccessful native select is not an explicit removal. JSON null
  // is the operator removal value; the native form has a deliberate removal option.
  let owner: unknown;
  if (Object.hasOwn(body, "owner_selection") && !Object.hasOwn(body, "owner_user_id")) {
    // Tagged native choices cannot collide with an opaque human ID.
    const choice = body.owner_selection;
    owner = choice === "remove" ? null : typeof choice === "string" && choice.startsWith("user:") ? choice.slice(5) : undefined;
  } else if (!Object.hasOwn(body, "owner_selection") && Object.hasOwn(body, "owner_user_id")) owner = body.owner_user_id;
  if (owner !== null && (typeof owner !== "string" || !owner.trim())) {
    throw new HttpError(400, "Choose an active owner or explicitly remove the assignment.", "invalid_request_error", "invalid_service_owner_selection");
  }
  const revision = typeof body.expected_revision === "string" && /^\d+$/.test(body.expected_revision) ? Number(body.expected_revision) : body.expected_revision;
  if (typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 0) throw new HttpError(400,"Reopen the owner form","invalid_request_error","invalid_service_owner_revision");
  return {owner_user_id:owner === null ? null : (owner as string).trim(),expected_revision:revision};
}

export function publicService(user: NonNullable<Awaited<ReturnType<typeof getUser>>>) {
  return { id: user.id, account_kind: user.account_kind, display_name: user.display_name,
    status: user.status, role: user.role, login_capable: user.login_capable,
    created_at: user.created_at, updated_at: user.updated_at };
}

export function publicCreditState(state: Awaited<ReturnType<typeof listSurfaceCreditStates>>[number]) {
  return state.surface_grant === "surface:xai:production"
    ? { ...state, shared_provider_authority: XAI_SHARED_PROVIDER_AUTHORITY }
    : state;
}

export async function optionalOAuthStartBody(request: Request): Promise<JsonObject> {
  try {
    return await readJsonObject(request);
  } catch {
    return {};
  }
}

export async function readJsonObject(request: Request): Promise<JsonObject> {
  let parsed: unknown;
  try {
    parsed = await request.json();
  } catch {
    throw new HttpError(400, "Request body must be valid JSON", "invalid_request_error", "invalid_json");
  }
  if (!isRecord(parsed)) {
    throw new HttpError(400, "Request body must be a JSON object", "invalid_request_error", "invalid_json_object");
  }
  return parsed as JsonObject;
}

export function publicCodexAuth(row: CodexAuthRow | null) {
  if (!row) {
    return null;
  }
  return {
    id: row.id,
    kind: row.kind,
    label: row.label,
    environment: row.environment,
    upstream_email: row.upstream_email,
    upstream_account_id: row.upstream_account_id,
    status: row.status,
    admission_state: row.admission_state,
    expires_at: row.expires_at,
    last_refresh_at: row.last_refresh_at,
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}

export function stringField(body: JsonObject, field: string): string | undefined {
  return firstString(body[field]) || undefined;
}

export function nullableStringField(body: JsonObject, field: string): string | null | undefined {
  if (!(field in body)) {
    return undefined;
  }
  const value = body[field];
  if (value === null) {
    return null;
  }
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }
  return undefined;
}

export function creditPolicyField(body: JsonObject): { mode: "limited" | "unlimited" | "disabled"; monthly_allowance: number | null } {
  const mode = body.mode;
  if (mode === "unlimited" || mode === "disabled") {
    return { mode, monthly_allowance: null };
  }
  if (mode !== undefined && mode !== "limited") {
    throw new HttpError(400, "Credit policy mode must be limited, unlimited, or disabled.", "invalid_request_error", "invalid_credit_policy");
  }
  return { mode: "limited", monthly_allowance: requiredNonNegativeIntegerField(body, "monthly_allowance") };
}

export function requiredNonNegativeIntegerField(body: JsonObject, field: string): number {
  const value = body[field];
  const parsed = typeof value === "number"
    ? value
    : typeof value === "string" && /^\d+$/.test(value.trim()) ? Number(value.trim()) : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new HttpError(
      400,
      `${field} must be a non-negative safe integer`,
      "invalid_request_error",
      `invalid_${field}`
    );
  }
  return parsed;
}

export function stringArrayField(body: JsonObject, field: string): string[] | undefined {
  const value = body[field];
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) {
    throw new HttpError(400, `${field} must be an array of strings`, "invalid_request_error", `invalid_${field}`);
  }
  return value.map((item) => item.trim());
}

export function credentialBindingsField(body: JsonObject): SurfaceCredentialSelection[] {
  const value = body.credential_bindings;
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new HttpError(400, "credential_bindings must be an array", "invalid_request_error", "invalid_credential_bindings");
  }
  return value.map((item) => {
    if (!isRecord(item)) {
      throw new HttpError(400, "credential_bindings contains an invalid item", "invalid_request_error", "invalid_credential_bindings");
    }
    const object = item as JsonObject;
    const surfaceGrant = requiredTrimmedString(object, "surface_grant");
    if (surfaceGrant !== "surface:codex:production"
      && surfaceGrant !== "surface:grok:production"
      && surfaceGrant !== "surface:xai:production") {
      throw new HttpError(400, "credential_bindings contains an invalid Surface Grant", "invalid_request_error", "invalid_credential_bindings");
    }
    return {
      surface_grant: surfaceGrant,
      credential_account_id: requiredTrimmedString(object, "credential_account_id")
    } as SurfaceCredentialSelection;
  });
}

function isConfirmed(body: JsonObject): boolean {
  return isConfirmValue(body.confirm);
}

export function requireConfirmation(body: JsonObject, action: string): void {
  if (!isConfirmed(body)) {
    throw new HttpError(400, `${action} requires confirm=1`, "invalid_request_error", "confirm_required");
  }
}

export function operatorMutationContext(
  env: Env,
  deps: AppDependencies,
  actor: AdminIdentity,
  requestContext: RequestContext
): OperatorMutationContext {
  return {
    env,
    deps,
    actor,
    requestId: requestContext.requestId,
    now: deps.now()
  };
}

export function hasQueryParams(url: URL): boolean {
  return Array.from(url.searchParams.keys()).length > 0;
}

export function codexTokenAuthority(env: Env, authId: string) {
  return env.TOKEN_AUTHORITY.get(env.TOKEN_AUTHORITY.idFromName(authId));
}
