import { commitCodexAdmission } from "../auth/account-admission";
import { commitServiceOwner } from "../auth/service-delegation";
/**
 * Canonical operator mutations for ADMIN_SECRET CLI and Access Dashboard.
 * HTTP authentication, confirmation, parsing, and response projection stay in route-admin.ts.
 */
import { keyLifecycle } from "../auth/key-state";
import { commitServiceAccount, commitServiceName, commitLegacyServiceClassification } from "../auth/service-accounts";
import type { AdminIdentity } from "../auth/authenticate";
import {
  commitIssuedKey,
  commitReplacement,
  normalizeKeyName,
  resolveKeyExpiry,
  revokeKey,
  type IssuedApiKey as PolicyIssuedKey
} from "../auth/api-keys";
import { credentialActor, defaultCredentialProbe, disconnectCredential, selectIssuanceDefaults, type OrganizationSurface } from "../auth/credential-defaults";
import { assertIssuableSurfaceGrants, parseApiKeyScopes } from "../auth/authenticate";
import {
  commitHumanUser,
  commitUserEmail,
  commitUserRole,
  commitUserStatus,
  type LifecycleActor
} from "../auth/principal";
import {
  codexTokenFromParsedSession,
  parseCodexSessionArtifact
} from "../codex/session-import";
import {
  beginCodexOAuth,
  completeCodexOAuth
} from "../codex/oauth";
import { nowIso } from "../crypto";
import { readTokenResult } from "../auth/token-result";
import {
  beginGrokOAuth,
  completeGrokOAuth
} from "../grok/oauth";
import {
  listApiKeySurfaceCredentials,
  replaceApiKeySurfaceCredential,
  type SurfaceCredentialSelection
} from "../auth/bindings";
import {
  createUser as insertUser,
  createCodexAuth as insertCodexAuth,
  getCodexAuth,
  getApiKeyById,
  getUser,
  insertOperatorMutationAudit,
  type OperatorMutationAuditInput
} from "../db";
import { HttpError } from "../errors";
import { parseGrokSessionArtifact } from "../grok/session-import";
import {
  createSubscriptionAccount as insertSubscriptionAccount,
  driverFor,
  getSubscriptionAccount,
  updateSubscriptionAccountMetadata,
  type CapabilitySource,
  type SubscriptionAccountRow,
  type SubscriptionEnvironment
} from "../auth/subscription-accounts";
import type { AppDependencies, CodexAuthRow, CodexToken, UserRow } from "../types";
import {
  assertIssuanceEntitlement,
  clearPersonalCreditPolicy,
  commitOrganizationCreditDefaults,
  commitPersonalCreditPolicy,
  getSurfaceCreditPolicy,
  listOrganizationCreditDefaults,
  listSurfaceCreditStates,
  surfaceGrantForCreditId,
  type CreditSurfaceId,
  type SurfaceCreditState
} from "../auth/credits";

export interface OperatorMutationContext {
  env: Env;
  deps: AppDependencies;
  actor: AdminIdentity;
  requestId: string;
  now: Date;
}

const DEFAULT_IMPORTED_TOKEN_TTL_MS = 60 * 60 * 1000;

interface IssuedApiKey {
  id: string;
  key_prefix: string;
  token: string;
  user_id: string;
  status: string;
  scopes: string[];
  expires_at: string | null;
  last_used_at: string | null;
  created_at: string;
  revoked_at: string | null;
}

function actorFields(identity: AdminIdentity): Pick<
  OperatorMutationAuditInput,
  "actor_kind" | "actor_email" | "actor_subject" | "actor_user_id" | "actor_role"
> {
  if (identity.kind === "console") {
    return {
      actor_kind: "access",
      actor_email: identity.email,
      actor_subject: identity.subject,
      actor_user_id: identity.userId ?? null,
      actor_role: identity.role ?? null
    };
  }
  return {
    actor_kind: "admin_secret",
    actor_email: null,
    actor_subject: null,
    actor_user_id: null,
    actor_role: null
  };
}

function lifecycleActor(ctx: OperatorMutationContext): LifecycleActor {
  return {
    kind: ctx.actor.kind === "console" ? "access" : "admin_secret",
    email: ctx.actor.email,
    subject: ctx.actor.subject,
    userId: ctx.actor.userId ?? null,
    role: ctx.actor.role === "admin" || ctx.actor.role === "user" ? ctx.actor.role : null,
    requestId: ctx.requestId,
    sessionEpoch: ctx.actor.sessionEpoch
  };
}

async function auditOk(
  ctx: OperatorMutationContext,
  input: Omit<OperatorMutationAuditInput, "actor_kind" | "actor_email" | "actor_subject" | "result" | "request_id">
): Promise<void> {
  await insertOperatorMutationAudit(ctx.env, {
    ...actorFields(ctx.actor),
    ...input,
    result: "ok",
    request_id: ctx.requestId
  }, ctx.now);
}

async function auditError(
  ctx: OperatorMutationContext,
  input: Omit<OperatorMutationAuditInput, "actor_kind" | "actor_email" | "actor_subject" | "result" | "request_id">
): Promise<void> {
  await insertOperatorMutationAudit(ctx.env, {
    ...actorFields(ctx.actor),
    ...input,
    result: "error",
    request_id: ctx.requestId
  }, ctx.now);
}

export async function createUser(
  ctx: OperatorMutationContext,
  input: { id?: string; email?: string | null }
): Promise<UserRow> {
  const user = await insertUser(ctx.env, input, ctx.now);
  await auditOk(ctx, {
    action: "user.create",
    target_type: "user",
    target_id: user.id,
    meta: { email_set: Boolean(user.email), status: user.status }
  });
  return user;
}

export async function createOrganizationUser(ctx: OperatorMutationContext, email: unknown): Promise<UserRow> {
  return commitHumanUser(ctx.env, lifecycleActor(ctx), email, ctx.now);
}

export async function assignServiceOwner(ctx: OperatorMutationContext, id: string, input: Parameters<typeof commitServiceOwner>[3]) {
  return commitServiceOwner(ctx.env, lifecycleActor(ctx), id, input, ctx.now);
}

export async function createServiceAccount(ctx: OperatorMutationContext, name: unknown): Promise<UserRow> {
  return commitServiceAccount(ctx.env, lifecycleActor(ctx), name, ctx.now);
}
export async function renameServiceAccount(ctx: OperatorMutationContext, id: string, name: unknown): Promise<UserRow> {
  return commitServiceName(ctx.env, lifecycleActor(ctx), id, name, ctx.now);
}
export async function classifyServiceAccount(ctx: OperatorMutationContext, id: string, input: { display_name: unknown; expected_updated_at: string }): Promise<UserRow> {
  return commitLegacyServiceClassification(ctx.env, lifecycleActor(ctx), id, input, ctx.now);
}

export async function issueApiKey(
  ctx: OperatorMutationContext,
  input: {
    user_id: string;
    name: string;
    scopes: string[];
    expires_at?: string | null;
    credential_bindings?: SurfaceCredentialSelection[];
  }
): Promise<IssuedApiKey> {
  const grants = assertIssuableSurfaceGrants(input.scopes);
  const name = normalizeKeyName(input.name);
  const expiresAt = resolveKeyExpiry(input.expires_at, ctx.now);
  const user = await getUser(ctx.env, input.user_id);
  if (!user) throw new HttpError(404, "User not found", "invalid_request_error", "user_not_found");
  await assertIssuanceEntitlement(ctx.env, input.user_id, grants, ctx.now);
  const selections = input.credential_bindings === undefined
    ? await selectIssuanceDefaults(ctx.env, grants as OrganizationSurface[], defaultCredentialProbe(ctx.env), ctx.now)
    : input.credential_bindings;
  if (input.credential_bindings) assertCompleteCredentialSelections(grants, selections);
  const issued = await commitIssuedKey(ctx.env, credentialActor(ctx), {
    user_id: input.user_id,
    name,
    scopes: grants,
    expires_at: expiresAt,
    selections,
    action: "key.create"
  }, ctx.now);
  return toIssuedApiKey(issued);
}

/**
 * Create a replacement without touching the existing key.
 * An expired source stays expired; a live source needs separate revocation.
 */
export async function issueReplacementApiKey(
  ctx: OperatorMutationContext,
  keyId: string,
  expiresAt?: string | null,
): Promise<{
  replacement: IssuedApiKey;
  previous: {
    id: string;
    key_prefix: string;
    last_used_at: string | null;
    status: string;
  };
  old_key_remains_active: boolean;
}> {
  const existing = await getApiKeyById(ctx.env, keyId);
  if (!existing) {
    throw new HttpError(404, "API key not found", "invalid_request_error", "key_not_found");
  }
  if (existing.status !== "active") {
    throw new HttpError(409, "Only an active key can be replaced", "invalid_request_error", "key_not_active");
  }
  const user = await getUser(ctx.env, existing.user_id);
  if (!user) {
    throw new HttpError(404, "User not found", "invalid_request_error", "user_not_found");
  }
  const grants = assertIssuableSurfaceGrants(parseApiKeyScopes(existing.scopes));
  const existingBindings = await listApiKeySurfaceCredentials(ctx.env, existing.id);
  if (existingBindings.length !== grants.length
    || grants.some((grant) => !existingBindings.some((binding) => binding.surface_grant === grant))) {
    throw new HttpError(
      409,
      "Existing key does not have a complete Credential Account binding set",
      "invalid_request_error",
      "incomplete_credential_bindings"
    );
  }
  const replacement = toIssuedApiKey(await commitReplacement(ctx.env, credentialActor(ctx), existing, expiresAt, ctx.now));
  return {
    replacement,
    previous: {
      id: existing.id,
      key_prefix: existing.key_prefix,
      last_used_at: existing.last_used_at,
      status: existing.status
    },
    old_key_remains_active: keyLifecycle(existing, user.status, ctx.now.getTime()).state === "active"
  };
}

export async function setApiKeyCredentialBinding(
  ctx: OperatorMutationContext,
  input: SurfaceCredentialSelection & { api_key_id: string }
) {
  const key = await getApiKeyById(ctx.env, input.api_key_id);
  if (!key) {
    throw new HttpError(404, "API key not found", "invalid_request_error", "key_not_found");
  }
  if (key.status !== "active") {
    throw new HttpError(409, "Only an active key can be rebound", "invalid_request_error", "key_not_active");
  }
  const grants = assertIssuableSurfaceGrants(parseApiKeyScopes(key.scopes));
  if (!grants.includes(input.surface_grant)) {
    throw new HttpError(400, "API key does not grant this Surface", "invalid_request_error", "surface_not_granted");
  }
  return replaceApiKeySurfaceCredential(ctx.env, input, lifecycleActor(ctx), ctx.now);
}

function assertCompleteCredentialSelections(
  grants: readonly string[],
  selections: readonly SurfaceCredentialSelection[]
): void {
  const selected = selections.map((selection) => selection.surface_grant);
  const unique = new Set(selected);
  if (unique.size !== selected.length
    || selected.length !== grants.length
    || grants.some((grant) => !unique.has(grant as SurfaceCredentialSelection["surface_grant"]))) {
    throw new HttpError(
      400,
      "Provide exactly one Credential Account binding for every Surface Grant",
      "invalid_request_error",
      "invalid_credential_bindings"
    );
  }
}

function toIssuedApiKey(issued: PolicyIssuedKey): IssuedApiKey {
  return {
    id: issued.id,
    key_prefix: issued.key_prefix,
    token: issued.token,
    user_id: issued.user_id,
    status: issued.status,
    scopes: issued.scopes,
    expires_at: issued.expires_at,
    last_used_at: issued.last_used_at,
    created_at: issued.created_at,
    revoked_at: issued.revoked_at
  };
}

export async function revokeApiKey(
  ctx: OperatorMutationContext,
  keyId: string
): Promise<{ id: string; revoked: true; already_revoked: boolean; key_prefix: string | null }> {
  const existing = await getApiKeyById(ctx.env, keyId);
  if (!existing) {
    throw new HttpError(404, "API key not found", "invalid_request_error", "key_not_found");
  }
  return revokeKey(ctx.env, credentialActor(ctx), existing, ctx.now);
}

export async function setUserStatus(
  ctx: OperatorMutationContext,
  userId: string,
  status: "active" | "disabled"
): Promise<{ id: string; email: string | null; status: string; previous_status: string }> {
  return commitUserStatus(ctx.env, lifecycleActor(ctx), userId, status, ctx.now);
}

export async function setUserRole(
  ctx: OperatorMutationContext,
  userId: string,
  role: "admin" | "user"
): Promise<{ id: string; role: "admin" | "user"; previous_role: string }> {
  return commitUserRole(ctx.env, lifecycleActor(ctx), userId, role, ctx.now);
}

export async function changeUserEmail(
  ctx: OperatorMutationContext,
  userId: string,
  email: string
): Promise<{ id: string; email: string; previous_email: string | null }> {
  return commitUserEmail(ctx.env, lifecycleActor(ctx), userId, email, ctx.now);
}

export async function setSurfaceCreditPolicy(
  ctx: OperatorMutationContext,
  input: {
    user_id: string;
    surface: CreditSurfaceId;
    mode?: "limited" | "unlimited" | "disabled";
    monthly_allowance?: number | null;
  }
): Promise<SurfaceCreditState> {
  const surfaceGrant = surfaceGrantForCreditId(input.surface);
  const previous = (await listSurfaceCreditStates(ctx.env, ctx.now, input.user_id))
    .find((state) => state.surface_grant === surfaceGrant);
  const mode = input.mode ?? "limited";
  return commitPersonalCreditPolicy(ctx.env, lifecycleActor(ctx), {
    user_id: input.user_id,
    surface_grant: surfaceGrant,
    mode,
    monthly_allowance: mode === "limited" ? input.monthly_allowance ?? null : null,
    previous_mode: previous?.source === "personal" ? previous.mode : null,
    previous_monthly_allowance: previous?.source === "personal" ? previous.monthly_allowance : null
  }, ctx.now);
}

export async function removeSurfaceCreditPolicy(
  ctx: OperatorMutationContext,
  input: { user_id: string; surface: CreditSurfaceId }
): Promise<{ deleted: boolean; state: SurfaceCreditState }> {
  const surfaceGrant = surfaceGrantForCreditId(input.surface);
  const previous = await getSurfaceCreditPolicy(ctx.env, input.user_id, surfaceGrant);
  return clearPersonalCreditPolicy(ctx.env, lifecycleActor(ctx), {
    user_id: input.user_id,
    surface_grant: surfaceGrant,
    previous_monthly_allowance: previous?.monthly_allowance ?? null
  }, ctx.now);
}

export async function setOrganizationCreditDefault(
  ctx: OperatorMutationContext,
  input: { surface: CreditSurfaceId; monthly_allowance: number }
) {
  const surfaceGrant = surfaceGrantForCreditId(input.surface);
  const current = (await listOrganizationCreditDefaults(ctx.env))
    .find((row) => row.surface_grant === surfaceGrant);
  if (!current) throw new HttpError(503, "Organization allowance is unavailable.", "server_error", "credit_default_unavailable");
  return (await commitOrganizationCreditDefaults(ctx.env, lifecycleActor(ctx), [{
    surface_grant: surfaceGrant,
    monthly_allowance: input.monthly_allowance,
    expected_monthly_allowance: current.monthly_allowance
  }], ctx.now))[0];
}

export async function setOrganizationCreditDefaults(ctx: OperatorMutationContext, input: readonly {
  surface: CreditSurfaceId; monthly_allowance: number; expected_monthly_allowance: number;
}[]) {
  return commitOrganizationCreditDefaults(ctx.env, lifecycleActor(ctx), input.map(({surface,...values}) => ({...values,surface_grant:surfaceGrantForCreditId(surface)})), ctx.now);
}

export async function beginCodexCredentialOAuth(
  ctx: OperatorMutationContext,
  authId: string,
  redirectUri?: string | null
): Promise<{ session_id: string; authorize_url: string; redirect_uri: string; expires_at: string }> {
  await requireCodexAuth(ctx, authId);
  const pending = await beginCodexOAuth(ctx.env, {
    credential_account_id: authId,
    redirect_uri: redirectUri
  }, ctx.now);
  await auditOk(ctx, {
    action: "credential.codex_oauth_start",
    target_type: "codex_auth",
    target_id: authId,
    meta: { session_id: pending.id, redirect_uri: pending.redirect_uri }
  });
  return {
    session_id: pending.id,
    authorize_url: pending.authorize_url,
    redirect_uri: pending.redirect_uri,
    expires_at: pending.expires_at
  };
}

export async function createCodexCredentialAccount(
  ctx: OperatorMutationContext,
  input: { label: string }
): Promise<CodexAuthRow> {
  const auth = await insertCodexAuth(ctx.env, input, ctx.now);
  await auditOk(ctx, {
    action: "credential.codex_create",
    target_type: "codex_auth",
    target_id: auth.id,
    meta: { label: auth.label, environment: auth.environment }
  });
  return auth;
}

export interface CodexCredentialImportInput {
  session?: string | null;
  content?: string | null;
  access_token?: string | null;
  refresh_token?: string | null;
  id_token?: string | null;
  expires_at?: string | null;
  account_id?: string | null;
  email?: string | null;
}

export async function importCodexCredential(
  ctx: OperatorMutationContext,
  input: CodexCredentialImportInput,
  authId: string
): Promise<{
  auth: CodexAuthRow;
  diagnostics: {
    auth_id: string;
    expires_at_defaulted: boolean;
    refresh_available: boolean;
    import_source: string;
    warnings: string[];
  };
}> {
  await requireCodexAuth(ctx, authId);
  const sessionBlob = input.session?.trim() || input.content?.trim() || "";
  const expiresAtDefaulted = !sessionBlob && !input.expires_at;
  let token: CodexToken;
  let importSource = "manual_fields";
  let warnings: string[] = [];

  if (sessionBlob) {
    const parsed = parseCodexSessionArtifact(sessionBlob, ctx.now);
    token = codexTokenFromParsedSession(authId, parsed, ctx.now);
    importSource = parsed.import_source;
    warnings = parsed.warnings;
    if (input.email?.trim()) {
      token.email = input.email.trim();
    }
    if (input.account_id?.trim()) {
      token.account_id = input.account_id.trim();
    }
  } else {
    const accessToken = requireNonEmpty(input.access_token, "access_token");
    token = {
      auth_id: authId,
      access_token: accessToken,
      refresh_token: optionalNonEmpty(input.refresh_token),
      id_token: optionalNonEmpty(input.id_token),
      expires_at: optionalNonEmpty(input.expires_at)
        ?? new Date(ctx.now.getTime() + DEFAULT_IMPORTED_TOKEN_TTL_MS).toISOString(),
      account_id: optionalNonEmpty(input.account_id),
      email: optionalNonEmpty(input.email),
      status: "active",
      last_refresh_at: nowIso(ctx.now)
    };
  }

  readTokenResult(await codexTokenAuthority(ctx.env, authId).saveToken(token));
  const auth = await requireCodexAuth(ctx, authId);
  await auditOk(ctx, {
    action: "credential.codex_import",
    target_type: "codex_auth",
    target_id: authId,
    meta: {
      import_source: importSource,
      refresh_available: Boolean(token.refresh_token),
      warning_count: warnings.length
    }
  });
  return {
    auth,
    diagnostics: {
      auth_id: authId,
      expires_at_defaulted: expiresAtDefaulted,
      refresh_available: Boolean(token.refresh_token),
      import_source: importSource,
      warnings
    }
  };
}

export async function completeCodexCredentialOAuth(
  ctx: OperatorMutationContext,
  input: {
    session_id?: string | null;
    state?: string | null;
    code?: string | null;
    callback_url?: string | null;
  },
  authId: string
): Promise<{
  auth_id: string;
  expires_at: string | null;
  refresh_available: boolean;
  email: string | null;
  auth: CodexAuthRow;
}> {
  await requireCodexAuth(ctx, authId);
  const token = await completeCodexOAuth(ctx.env, ctx.deps, input, authId, ctx.now);
  readTokenResult(await codexTokenAuthority(ctx.env, authId).saveToken(token));
  const authRow = await requireCodexAuth(ctx, authId);
  await auditOk(ctx, {
    action: "credential.codex_oauth_complete",
    target_type: "codex_auth",
    target_id: authId,
    meta: {
      refresh_available: Boolean(token.refresh_token),
      expires_at: authRow.expires_at,
      upstream_email_set: Boolean(authRow.upstream_email)
    }
  });
  return {
    auth_id: authId,
    expires_at: authRow.expires_at,
    refresh_available: Boolean(token.refresh_token),
    email: authRow.upstream_email,
    auth: authRow
  };
}

export async function refreshCodexCredential(
  ctx: OperatorMutationContext,
  authId: string
): Promise<{
  auth_id: string;
  refreshed: true;
  refresh_available: boolean;
  auth: CodexAuthRow | null;
  previous_expires_at: string | null;
  expires_at_changed: boolean;
}> {
  const before = await requireCodexAuth(ctx, authId);
  const previousExpiresAt = before?.expires_at ?? null;
  const refreshed = readTokenResult(await codexTokenAuthority(ctx.env, authId).refreshNow());
  const auth = await getCodexAuth(ctx.env, authId);
  await auditOk(ctx, {
    action: "credential.codex_refresh",
    target_type: "codex_auth",
    target_id: authId,
    meta: { refresh_available: refreshed.refresh_available }
  });
  return {
    auth_id: authId,
    refreshed: true,
    refresh_available: refreshed.refresh_available,
    auth,
    previous_expires_at: previousExpiresAt,
    expires_at_changed: previousExpiresAt !== (auth?.expires_at ?? null)
  };
}

export async function setCodexAdmission(ctx: OperatorMutationContext, authId: string, state: CodexAuthRow["admission_state"]): Promise<CodexAuthRow> {
  return commitCodexAdmission(ctx.env, credentialActor(ctx), authId, state, ctx.now);
}

/** Disconnect one ChatGPT Credential Account. Live bindings block this path. */
export async function logoutCodexCredential(
  ctx: OperatorMutationContext,
  authId: string
): Promise<{
  auth_id: string;
  revoked: true;
  completion: "complete" | "partial";
  token_cleanup: "cleared" | "failed";
  recovery?: "retry_cleanup";
}> {
  await requireCodexAuth(ctx, authId);
  const outcome = await disconnectCredential(ctx.env, credentialActor(ctx), {
    kind: "codex",
    account_id: authId
  }, () => codexTokenAuthority(ctx.env, authId).revoke(), ctx.now);
  return {
    auth_id: authId,
    revoked: true,
    completion: outcome.completion,
    token_cleanup: outcome.token_cleanup,
    ...(outcome.recovery ? { recovery: outcome.recovery } : {})
  };
}

export async function createGrokSubscription(
  ctx: OperatorMutationContext,
  input: {
    capability_source: CapabilitySource;
    environment: SubscriptionEnvironment;
    label: string;
    provider_account_ref?: string | null;
  }
): Promise<SubscriptionAccountRow> {
  const account = await insertSubscriptionAccount(ctx.env, input, ctx.now);
  await auditOk(ctx, {
    action: "subscription.grok_create",
    target_type: "subscription_account",
    target_id: account.id,
    meta: {
      capability_source: account.capability_source,
      environment: account.environment,
      status: account.status
    }
  });
  return account;
}

export interface GrokCredentialImportInput {
  session?: string | null;
  content?: string | null;
  access_token?: string | null;
  refresh_token?: string | null;
  id_token?: string | null;
  oidc_issuer?: string | null;
  oidc_client_id?: string | null;
  expires_at?: string | null;
  account_ref?: string | null;
  email?: string | null;
}

export async function importGrokCredential(
  ctx: OperatorMutationContext,
  accountId: string,
  input: GrokCredentialImportInput
): Promise<{
  account: SubscriptionAccountRow;
  diagnostics: {
    refresh_available: boolean;
    secrets_echoed: false;
    import_source: string;
    warnings: string[];
  };
}> {
  const account = await requireGrokSubscriptionAccount(ctx, accountId);
  const sessionBlob = input.session?.trim() || input.content?.trim() || "";
  let material;
  let importSource = "manual_fields";
  let warnings: string[] = [];
  if (sessionBlob) {
    const parsed = parseGrokSessionArtifact(sessionBlob, ctx.now);
    material = parsed;
    importSource = parsed.import_source;
    warnings = parsed.warnings;
  } else {
    material = driverFor(account.capability_source).normalizeImport({
      access_token: input.access_token,
      refresh_token: input.refresh_token,
      id_token: input.id_token,
      oidc_issuer: input.oidc_issuer,
      oidc_client_id: input.oidc_client_id,
      expires_at: input.expires_at,
      account_ref: input.account_ref,
      email: input.email
    });
  }
  await storeGrokMaterial(
    ctx,
    accountId,
    account.capability_source,
    material,
    "credential.grok_import",
    importSource,
    warnings
  );
  return {
    account: (await getSubscriptionAccount(ctx.env, accountId)) ?? account,
    diagnostics: {
      refresh_available: Boolean(material.refresh_token),
      secrets_echoed: false,
      import_source: importSource,
      warnings
    }
  };
}

export async function beginGrokCredentialOAuth(
  ctx: OperatorMutationContext,
  accountId: string,
  redirectUri?: string | null
): Promise<{
  account_id: string;
  session_id: string;
  authorize_url: string;
  redirect_uri: string;
  expires_at: string;
}> {
  const account = await requireGrokSubscriptionAccount(ctx, accountId);
  const pending = await beginGrokOAuth(ctx.env, {
    credential_account_id: accountId,
    redirect_uri: redirectUri
  }, ctx.now);
  await auditOk(ctx, {
    action: "credential.grok_oauth_start",
    target_type: "subscription_account",
    target_id: accountId,
    meta: { session_id: pending.id, redirect_uri: pending.redirect_uri, capability_source: account.capability_source }
  });
  return {
    account_id: accountId,
    session_id: pending.id,
    authorize_url: pending.authorize_url,
    redirect_uri: pending.redirect_uri,
    expires_at: pending.expires_at
  };
}

export async function completeGrokCredentialOAuth(
  ctx: OperatorMutationContext,
  accountId: string,
  input: {
    session_id?: string | null;
    state?: string | null;
    code?: string | null;
    callback_url?: string | null;
  }
): Promise<{
  account_id: string;
  status: string;
  refresh_available: boolean;
  account: SubscriptionAccountRow;
}> {
  const account = await requireGrokSubscriptionAccount(ctx, accountId);
  const material = await completeGrokOAuth(ctx.env, ctx.deps, input, accountId, ctx.now);
  await storeGrokMaterial(ctx, accountId, account.capability_source, material, "credential.grok_oauth_complete", "oauth", []);
  const updated = (await getSubscriptionAccount(ctx.env, accountId)) ?? account;
  return {
    account_id: accountId,
    status: updated.status,
    refresh_available: Boolean(material.refresh_token),
    account: updated
  };
}

async function requireGrokSubscriptionAccount(
  ctx: OperatorMutationContext,
  accountId: string
) {
  const account = await getSubscriptionAccount(ctx.env, accountId);
  if (!account) {
    throw new HttpError(404, "Subscription Account not found", "invalid_request_error", "subscription_not_found");
  }
  if (account.capability_source !== "grok") {
    throw new HttpError(
      400,
      "Subscription credential operations support Grok; use ChatGPT import for Codex",
      "invalid_request_error",
      "invalid_capability_source"
    );
  }
  return account;
}

async function storeGrokMaterial(
  ctx: OperatorMutationContext,
  accountId: string,
  capabilitySource: string,
  material: {
    access_token: string;
    refresh_token?: string;
    id_token?: string;
    oidc_issuer?: string;
    oidc_client_id?: string;
    expires_at?: string;
    account_ref?: string;
    email?: string;
  },
  action: string,
  importSource: string,
  warnings: string[]
): Promise<void> {
  readTokenResult(await subscriptionTokenAuthority(ctx.env, accountId).saveSubscriptionCredential({
    account_id: accountId,
    capability_source: "grok",
    access_token: material.access_token,
    ...(material.refresh_token ? { refresh_token: material.refresh_token } : {}),
    ...(material.id_token ? { id_token: material.id_token } : {}),
    ...(material.oidc_issuer ? { oidc_issuer: material.oidc_issuer } : {}),
    ...(material.oidc_client_id ? { oidc_client_id: material.oidc_client_id } : {}),
    ...(material.expires_at ? { expires_at: material.expires_at } : {}),
    ...(material.account_ref ? { account_ref: material.account_ref } : {}),
    ...(material.email ? { email: material.email } : {}),
    status: "active",
    last_refresh_at: ctx.now.toISOString()
  }));
  await auditOk(ctx, {
    action,
    target_type: "subscription_account",
    target_id: accountId,
    meta: {
      capability_source: capabilitySource,
      refresh_available: Boolean(material.refresh_token),
      import_source: importSource,
      warning_count: warnings.length
    }
  });
}

export async function refreshGrokCredential(
  ctx: OperatorMutationContext,
  accountId: string
): Promise<{
  account_id: string;
  status: string;
  account: SubscriptionAccountRow;
  diagnostics: { account_id: string; refresh_available: boolean };
}> {
  const account = await requireGrokSubscriptionAccount(ctx, accountId);
  const diagnostics = readTokenResult(await subscriptionTokenAuthority(ctx.env, accountId).refreshSubscriptionNow());
  await auditOk(ctx, {
    action: "credential.grok_refresh",
    target_type: "subscription_account",
    target_id: accountId,
    meta: { capability_source: account.capability_source }
  });
  const updated = (await getSubscriptionAccount(ctx.env, accountId)) ?? account;
  return { account_id: accountId, status: updated.status, account: updated, diagnostics };
}

export async function testGrokCredential(
  ctx: OperatorMutationContext,
  accountId: string
): Promise<{
  ok: true;
  kind: "local_credential_check";
  has_access_token: boolean;
  account: SubscriptionAccountRow;
}> {
  const account = await requireGrokSubscriptionAccount(ctx, accountId);
  try {
    const fresh = readTokenResult(await subscriptionTokenAuthority(ctx.env, accountId).getFreshSubscriptionCredential());
    await updateSubscriptionAccountMetadata(ctx.env, accountId, {
      last_test_at: ctx.now.toISOString(),
      last_test_status: "credential_usable"
    }, ctx.now);
    await auditOk(ctx, {
      action: "credential.grok_test",
      target_type: "subscription_account",
      target_id: accountId,
      meta: { capability_source: account.capability_source, outcome: "credential_usable" }
    });
    return {
      ok: true,
      kind: "local_credential_check",
      has_access_token: Boolean(fresh.access_token),
      account: (await getSubscriptionAccount(ctx.env, accountId)) ?? account
    };
  } catch (error) {
    const code = error instanceof HttpError ? error.code ?? "test_failed" : "test_failed";
    await updateSubscriptionAccountMetadata(ctx.env, accountId, {
      last_test_at: ctx.now.toISOString(),
      last_test_status: "error"
    }, ctx.now);
    await auditError(ctx, {
      action: "credential.grok_test",
      target_type: "subscription_account",
      target_id: accountId,
      meta: { capability_source: account.capability_source, failure_code: code }
    });
    throw error;
  }
}

/** Sever subscription credential (Logout). Live bindings block an existing account. */
export async function logoutGrokCredential(
  ctx: OperatorMutationContext,
  accountId: string
): Promise<{
  account_id: string;
  revoked: true;
  d1: "revoked" | "absent";
  storage_cleared?: boolean;
  completion?: "complete" | "partial";
  token_cleanup?: "cleared" | "failed";
  recovery?: "retry_cleanup";
}> {
  const account = await getSubscriptionAccount(ctx.env, accountId);
  if (!account) {
    const cleared = await subscriptionTokenAuthority(ctx.env, accountId).clearSubscriptionStorage();
    await auditOk(ctx, {
      action: "credential.grok_storage_purge",
      target_type: "subscription_account",
      target_id: accountId,
      meta: { d1: "absent", storage_cleared: cleared.cleared }
    });
    return {
      account_id: accountId,
      revoked: true,
      d1: "absent",
      storage_cleared: cleared.cleared
    };
  }
  if (account.capability_source !== "grok") {
    throw new HttpError(
      400,
      "Subscription credential operations support Grok; use ChatGPT import for Codex",
      "invalid_request_error",
      "invalid_capability_source"
    );
  }
  const outcome = await disconnectCredential(ctx.env, credentialActor(ctx), {
    kind: "grok",
    account_id: accountId
  }, () => subscriptionTokenAuthority(ctx.env, accountId).revokeSubscription(), ctx.now);
  return {
    account_id: accountId,
    revoked: true,
    d1: "revoked",
    completion: outcome.completion,
    token_cleanup: outcome.token_cleanup,
    ...(outcome.recovery ? { recovery: outcome.recovery } : {})
  };
}

function requireNonEmpty(value: string | null | undefined, field: string): string {
  const normalized = optionalNonEmpty(value);
  if (!normalized) {
    throw new HttpError(400, `${field} is required`, "invalid_request_error", `missing_${field}`);
  }
  return normalized;
}

function optionalNonEmpty(value: string | null | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized || undefined;
}

async function requireCodexAuth(ctx: OperatorMutationContext, authId: string): Promise<CodexAuthRow> {
  const auth = await getCodexAuth(ctx.env, authId);
  if (!auth) {
    throw new HttpError(404, "ChatGPT Credential Account not found", "invalid_request_error", "codex_auth_not_found");
  }
  return auth;
}

function codexTokenAuthority(env: Env, authId: string) {
  return env.TOKEN_AUTHORITY.get(env.TOKEN_AUTHORITY.idFromName(authId));
}

function subscriptionTokenAuthority(env: Env, accountId: string) {
  return env.TOKEN_AUTHORITY.get(env.TOKEN_AUTHORITY.idFromName(`subscription:${accountId}`));
}
