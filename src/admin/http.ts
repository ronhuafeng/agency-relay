import { parseUsageQuery, MAX_USAGE_RANGE_DAYS } from "./usage-query";
import { isRuntimeControlPath, runtimeControlResponse } from "../runtime/control";
import { invalidRuntimeOperation } from "../runtime/installations";
import {revokeRuntimeClient,readRuntimeForm,mutateRuntimeInstallation} from "../runtime/console";
import {runtimeMemberHref} from "./ui/pages/runtime";

import { delegatedService, listDelegatedServices, readServiceOwner, type ServiceContext } from "../auth/service-delegation";
import { assertKeyActorAuthority } from "../auth/key-authority";
import { consoleLoginHref, consoleReturnTarget } from "./return-target";
import { memberHref } from "./member-href";
/**
 * Admin CLI + dashboard routing (K3 boundary).
 */
import { isDashboardPageToken } from "./dashboard-page";
import { requireOperator, verifyConsoleAccess, type AdminIdentity } from "../auth/authenticate";
import { routeConsoleLogin } from "../auth/feishu-login";
import { readTokenResult } from "../auth/token-result";
import { clearConsoleSessionCookie } from "../auth/console-session";
import { consoleErrorMessage } from "./ui/messages";
import { credentialStatusResponse, credentialEventsResponse } from "./credential-status";
import { userRole, userStatus, type ConsolePrincipal } from "../auth/principal";
import {
  issueMemberKey,
  listMemberKeys,
  renameMemberKey,
  replaceMemberKey,
  revokeAllMemberKeys,
  revokeMemberKey,
  type PublicApiKey
} from "../auth/api-keys";
import { memberConsoleResponse, memberSecretPage, memberUsageResponse, memberMutationPage } from "./member-console";
import { credentialControlResponse, serviceAvailabilityResponse } from "./credential-control";
import { commitCredentialDefault, credentialActor, migrateCredentialBindings, disconnectCredential, retryCredentialCleanup, type OrganizationSurface } from "../auth/credential-defaults";
import { adminDashboardResponse, dashboardAccountForMutation, dashboardKeyReturnUrl, dashboardPersonReturnUrl, consoleLifecycleOutcome, consoleUnknownOutcome } from "./dashboard";
import { type DashboardMutationFlash } from "./dashboard-data";
import { consoleClientPath, consoleVersionedClientResponse, consoleClientResponse, consoleStylesheetPath, consoleStylesheetResponse, dashboardAppResponse, isDashboardAppPath } from "./app";
import {
  beginCodexCredentialOAuth,
  beginGrokCredentialOAuth,
  completeCodexCredentialOAuth,
  completeGrokCredentialOAuth,
  createCodexCredentialAccount,
  createGrokSubscription,
  createUser,
  createOrganizationUser,
  createServiceAccount,
  assignServiceOwner,
  renameServiceAccount,
  classifyServiceAccount,
  importCodexCredential,
  importGrokCredential,
  issueApiKey,
  issueReplacementApiKey,
  logoutCodexCredential,
  logoutGrokCredential,
  assertGrokCapability,
  refreshCodexCredential,
  setCodexAdmission,
  refreshGrokCredential,
  removeSurfaceCreditPolicy,
  revokeApiKey,
  setSurfaceCreditPolicy,
  setApiKeyCredentialBinding,
  setUserStatus,
  setUserRole,
  setOrganizationCreditDefault,
  setOrganizationCreditDefaults,
  changeUserEmail,
  testGrokCredential,
  type OperatorMutationContext
} from "./operator-mutations";
import { PRODUCT_ACCESS } from "./client-setup";
import { readCodexAccountSnapshot, unavailableCodexAccountSnapshot } from "../codex/account";
import {
  cleanupRequestAudit,
  requestAuditRetentionDays,
  getCodexAuth,
  getUser,
  getApiKeyById,
  listCodexAuths,
  queryMediaUsageSummary,
  queryRequestAttemptState,
  queryUsageSummary
} from "../db";
import {
  listApiKeySurfaceCredentials,
  type SurfaceCredentialSelection
} from "../auth/bindings";
import { assertConsoleBrowserWrite } from "./browser-write";
import { bytesToHex } from "../crypto";
import { firstString, isConfirmValue, isRecord } from "../records";
import { HttpError, adminAuthRequired, adminRequired, adminRouteNotFound, codexAuthNotFound, invalidConsoleReturn, jsonObjectRequired, jsonResponse, methodNotAllowed, requiredTrimmedString, serviceNotFound, subscriptionNotFound, userNotFound } from "../errors";
import {
  CODEX_API_HOSTNAME,
  EXECUTION_PLAN_SET_VERSION,
  isChatgptProductionSlot,
  listExecutionPlans
} from "../plans/execution-plans";
import { assertCodexEgressBaseUrl } from "../proxy/origin";
import { subscriptionKindForPlan } from "../plans/audit";
import {
  getSubscriptionAccount,
  listSubscriptionAccounts,
  publicSubscriptionAccount,
  type CapabilitySource,
  type SubscriptionEnvironment
} from "../auth/subscription-accounts";
import type { AppDependencies, CodexAuthRow, RequestContext } from "../types";
import {
  CREDIT_SURFACE_IDS,
  listOrganizationCreditDefaults,
  listSurfaceCreditStates,
  XAI_SHARED_PROVIDER_AUTHORITY,
  type CreditSurfaceId,
  type SurfaceCreditState
} from "../auth/credits";

type JsonObject = Record<string, unknown>;
const DAY_MS = 24 * 60 * 60 * 1000;

interface RequestAuditCleanupResult {
  deleted: number;
  retention_days: number;
  cutoff: string;
}

export async function routeAdmin(request: Request, env: Env, url: URL, deps: AppDependencies, requestContext: RequestContext): Promise<Response> {
  if (url.hostname === env.ADMIN_DASHBOARD_HOST && request.method === "GET" && url.search === "" && url.pathname === consoleClientPath()) {
    return consoleVersionedClientResponse(url.pathname)!;
  }
  // Public, content-addressed CSS also styles the login page before a session exists.
  if (url.hostname === env.ADMIN_DASHBOARD_HOST && request.method === "GET" && url.search === "" && url.pathname === consoleStylesheetPath()) {
    return consoleStylesheetResponse(url.pathname)!;
  }
  if (url.hostname === env.ADMIN_DASHBOARD_HOST) {
    const login = await routeConsoleLogin(request, env, url, deps, requestContext);
    if (login) return login;
  }
  const authorized = await authorizeConsole(request, env, url, requestContext, deps.now);
  if (authorized instanceof Response) return authorized;
  const admin = authorized;
  if (["/admin/credential-status", "/admin/events/credentials"].includes(url.pathname)) {
    if (url.hostname !== env.ADMIN_DASHBOARD_HOST || request.method !== "GET" || admin.kind !== "console" || !admin.userId) {
      throw new HttpError(403, "Console administrator required", "authentication_error", "admin_required");
    }
    if (url.pathname === "/admin/events/credentials") return credentialEventsResponse(request, env);
    const response = await credentialStatusResponse(env, admin.userId, new Date(requestContext.startedAt));
    const current = await verifyConsoleAccess(request, env, deps.now());
    if (!current || current.role !== "admin" || current.id !== admin.userId || current.sessionEpoch !== admin.sessionEpoch) {
      throw consoleAuthorityChanged();
    }
    return response;
  }
  const operator = operatorMutationContext(env, deps, admin, requestContext);
  const runtimeResponse = await runtimeControlResponse(request, env, url, operator);
  if (runtimeResponse) return runtimeResponse;
  const credentialHtmlTask = url.hostname === env.ADMIN_DASHBOARD_HOST && request.method === "POST" && wantsHtml(request)
    && /^\/admin\/ui\/(?:credential-defaults\/(?:codex|grok|xai)|(?:codex-auths|subscriptions)\/[^/]+\/(?:migrate|cleanup))$/.test(url.pathname);
  const credentialResponse = credentialHtmlTask ? null
    : await credentialControlResponse(request, env, url, operator);
  if (credentialResponse) return credentialResponse;

  if (isAdminDashboardPage(url, env) && request.method === "GET") {
    const response = await adminDashboardResponse({
      unchangedRevision: request.headers.get("X-Console-Revision"),
      env,
      url,
      identity: admin,
      now: new Date(requestContext.startedAt),
      requestId: requestContext.requestId,
      loadCodexAccount: async (authId) => {
        try {
          const freshToken = readTokenResult(await codexTokenAuthority(env, authId).getFreshAccessToken());
          return await readCodexAccountSnapshot(env, deps, freshToken, request.signal);
        } catch {
          return unavailableCodexAccountSnapshot();
        }
      }
    });
    if (response.status === 204) await assertUnchangedReadAuthority(request, env, admin.userId, admin.email, "admin", admin.sessionEpoch, deps.now());
    return response;
  }

  // Access Dashboard mutations (dashboard host only — allowlist).
  if (url.hostname === env.ADMIN_DASHBOARD_HOST && url.pathname.startsWith("/admin/ui/")) {
    return routeDashboardUiMutation(request, env, url, deps, requestContext, admin);
  }

  if (url.pathname === "/admin/users" && request.method === "POST") {
    const body = await readJsonObject(request);
    const user = await createUser(operator, {
      id: stringField(body, "id"),
      email: nullableStringField(body, "email")
    });
    return jsonResponse({ user }, { status: 201 });
  }

  const userIdentityMatch = /^\/admin\/users\/([^/]+)$/.exec(url.pathname);
  if (userIdentityMatch && request.method === "GET") {
    const user = await getUser(env, decodeURIComponent(userIdentityMatch[1]!));
    if (!user) throw userNotFound();
    return jsonResponse({ user: { ...publicService(user), email: user.email, canonical_email: user.canonical_email } }, { headers: { "Cache-Control": "no-store" } });
  }

  if (url.pathname === "/admin/services" && request.method === "POST") {
    const body = await readJsonObject(request);
    return jsonResponse({ user: await createServiceAccount(operator, body.display_name) }, { status: 201 });
  }
  const ownerMatch = /^\/admin\/services\/([^/]+)\/owner$/.exec(url.pathname);
  if (ownerMatch) {
    const id = decodeURIComponent(ownerMatch[1]!);
    if (request.method === "GET") {
      const user = await getUser(env,id);
      if (!user || user.account_kind !== "service") throw serviceNotFound();
      return jsonResponse({owner:await readServiceOwner(env,id)}, {headers:{"Cache-Control":"no-store"}});
    }
    if (request.method === "POST") {
      const body = await readJsonObject(request); requireConfirmation(body,"Change service owner; credentials unchanged");
      return jsonResponse({owner:await assignServiceOwner(operator,id,ownerInput(body)),credentials_unchanged:true});
    }
  }
  const serviceMatch = /^\/admin\/services\/([^/]+)(?:\/(name|classify))?$/.exec(url.pathname);
  if (serviceMatch) {
    const id = decodeURIComponent(serviceMatch[1]!);
    if (!serviceMatch[2] && request.method === "GET") {
      const user = await getUser(env, id);
      if (!user || user.account_kind !== "service") throw new HttpError(404, "Service not found", "invalid_request_error", "user_not_found");
      return jsonResponse({ user: publicService(user) }, { headers: { "Cache-Control": "no-store" } });
    }
    if (request.method === "POST" && serviceMatch[2]) {
      const body = await readJsonObject(request);
      const user = serviceMatch[2] === "name"
        ? await renameServiceAccount(operator, id, body.display_name)
        : await classifyServiceAccount(operator, id, { display_name: body.display_name, expected_updated_at: requiredTrimmedString(body, "expected_updated_at") });
      return jsonResponse({ user: publicService(user) });
    }
  }

  const lifecycleMatch = /^\/admin\/users\/([^/]+)\/(role|status|email)$/.exec(url.pathname);
  if (lifecycleMatch && request.method === "POST") {
    return jsonResponse(await commitLifecycle(operator, decodeURIComponent(lifecycleMatch[1]!), lifecycleMatch[2]!, await readJsonObject(request)));
  }

  const createKeyMatch = /^\/admin\/users\/([^/]+)\/keys$/.exec(url.pathname);
  if (createKeyMatch && request.method === "POST") {
    const body = await readJsonObject(request);
    const issued = await issueApiKey(operator, {
      user_id: decodeURIComponent(createKeyMatch[1]),
      name: typeof body.name === "string" ? body.name : "",
      scopes: stringArrayField(body, "scopes") ?? [],
      expires_at: nullableStringField(body, "expires_at"),
      credential_bindings: "credential_bindings" in body ? credentialBindingsField(body) : undefined
    });
    return jsonResponse({
      api_key: issued.token,
      key: {
        id: issued.id,
        user_id: issued.user_id,
        key_prefix: issued.key_prefix,
        status: issued.status,
        scopes: JSON.stringify(issued.scopes),
        expires_at: issued.expires_at,
        last_used_at: issued.last_used_at,
        created_at: issued.created_at,
        revoked_at: issued.revoked_at
      }
    }, { status: 201 });
  }

  const revokeKeyMatch = /^\/admin\/keys\/([^/]+)$/.exec(url.pathname);
  if (revokeKeyMatch && request.method === "DELETE") {
    const keyId = decodeURIComponent(revokeKeyMatch[1]);
    return jsonResponse(await revokeApiKey(operator, keyId));
  }

  const userCreditsMatch = /^\/admin\/users\/([^/]+)\/credits(?:\/(codex|grok|xai))?$/.exec(url.pathname);
  if (userCreditsMatch) {
    const userId = decodeURIComponent(userCreditsMatch[1]);
    const surface = userCreditsMatch[2] as CreditSurfaceId | undefined;
    if (!surface && request.method === "GET") {
      return jsonResponse({
        kind: "surface_credit_states",
        user_id: userId,
        period: "utc_month",
        states: (await listSurfaceCreditStates(env, deps.now(), userId)).map(publicCreditState)
      }, { headers: { "Cache-Control": "no-store" } });
    }
    if (surface && request.method === "PUT") {
      const body = await readJsonObject(request);
      const state = await setSurfaceCreditPolicy(operator, {
        user_id: userId,
        surface,
        ...creditPolicyField(body)
      });
      return jsonResponse({ kind: "surface_credit_state", state: publicCreditState(state) });
    }
    if (surface && request.method === "DELETE") {
      const removed = await removeSurfaceCreditPolicy(operator, { user_id: userId, surface });
      return jsonResponse({ deleted: removed.deleted, state: publicCreditState(removed.state) });
    }
    throw methodNotAllowed();
  }

  const creditDefaultMatch = /^\/admin\/credit-defaults(?:\/(codex|grok|xai))?$/.exec(url.pathname);
  if (creditDefaultMatch && !creditDefaultMatch[1] && request.method === "GET") {
    return jsonResponse({
      kind: "organization_credit_defaults",
      defaults: await listOrganizationCreditDefaults(env)
    }, { headers: { "Cache-Control": "no-store" } });
  }
  if (creditDefaultMatch?.[1] && request.method === "PUT") {
    const body = await readJsonObject(request);
    return jsonResponse(await setOrganizationCreditDefault(operator, {
      surface: creditDefaultMatch[1] as CreditSurfaceId,
      monthly_allowance: requiredNonNegativeIntegerField(body, "monthly_allowance")
    }));
  }

  if (url.pathname === "/admin/codex-auths" && request.method === "GET") {
    return jsonResponse(
      { auths: (await listCodexAuths(env)).map(publicCodexAuth) },
      { headers: { "Cache-Control": "no-store" } }
    );
  }

  if (url.pathname === "/admin/codex-auths" && request.method === "POST") {
    const body = await readJsonObject(request);
    const auth = await createCodexCredentialAccount(operator, { label: requiredTrimmedString(body, "label") });
    return jsonResponse({ auth: publicCodexAuth(auth) }, { status: 201 });
  }

  const codexAuthMatch = /^\/admin\/codex-auths\/([^/]+)(?:\/(refresh|import|oauth\/start|oauth\/complete|pause|resume))?$/.exec(url.pathname);
  if (codexAuthMatch) {
    const authId = decodeURIComponent(codexAuthMatch[1]);
    const action = codexAuthMatch[2];
    if (!action && request.method === "GET") {
      const auth = await getCodexAuth(env, authId);
      if (!auth) {
        throw codexAuthNotFound();
      }
      return jsonResponse(
        { auth: publicCodexAuth(auth) },
        { headers: { "Cache-Control": "no-store" } }
      );
    }
    if (!action && request.method === "DELETE") {
      return jsonResponse(await logoutCodexCredential(operator, authId));
    }
    if ((action === "pause" || action === "resume") && request.method === "POST") {
      const body = await readJsonObject(request);
      requireConfirmation(body, action === "pause" ? "Pause" : "Resume");
      const auth = await setCodexAdmission(operator, authId, action === "pause" ? "paused" : "enabled");
      return jsonResponse({ auth: publicCodexAuth(auth) }, { headers: { "Cache-Control": "no-store" } });
    }
    if (action === "refresh" && request.method === "POST") {
      const result = await refreshCodexCredential(operator, authId);
      return jsonResponse({
        auth: publicCodexAuth(result.auth),
        diagnostics: {
          auth_id: result.auth_id,
          refreshed: result.refreshed,
          refresh_available: result.refresh_available,
          previous_expires_at: result.previous_expires_at,
          expires_at_changed: result.expires_at_changed
        }
      });
    }

    if (action === "import" && request.method === "POST") {
      const body = await readJsonObject(request);
      const result = await importCodexCredential(operator, {
        session: nullableStringField(body, "session"),
        content: nullableStringField(body, "content"),
        access_token: nullableStringField(body, "access_token"),
        refresh_token: nullableStringField(body, "refresh_token"),
        id_token: nullableStringField(body, "id_token"),
        expires_at: nullableStringField(body, "expires_at"),
        account_id: nullableStringField(body, "account_id"),
        email: nullableStringField(body, "email")
      }, authId);
      return jsonResponse({
        auth: publicCodexAuth(result.auth),
        diagnostics: result.diagnostics
      }, { status: 201 });
    }

    if (action === "oauth/start" && request.method === "POST") {
      const body = await optionalOAuthStartBody(request);
      return jsonResponse(await beginCodexCredentialOAuth(operator, authId, nullableStringField(body, "redirect_uri")));
    }

    if (action === "oauth/complete" && request.method === "POST") {
      const body = await readJsonObject(request);
      const result = await completeCodexCredentialOAuth(operator, {
        session_id: nullableStringField(body, "session_id"),
        state: nullableStringField(body, "state"),
        code: nullableStringField(body, "code"),
        callback_url: nullableStringField(body, "callback_url")
      }, authId);
      return jsonResponse({
        auth: publicCodexAuth(result.auth),
        diagnostics: {
          auth_id: result.auth_id,
          refresh_available: result.refresh_available
        }
      }, { status: 201 });
    }
    throw methodNotAllowed();
  }

  const keyBindingsMatch = /^\/admin\/keys\/([^/]+)\/credential-bindings(?:\/(codex|grok|xai))?$/.exec(url.pathname);
  if (keyBindingsMatch) {
    const keyId = decodeURIComponent(keyBindingsMatch[1]);
    const surfaceId = keyBindingsMatch[2];
    if (!surfaceId && request.method === "GET") {
      return jsonResponse({ bindings: await listApiKeySurfaceCredentials(env, keyId) }, { headers: { "Cache-Control": "no-store" } });
    }
    if (surfaceId && request.method === "PUT") {
      const body = await readJsonObject(request);
      const binding = await setApiKeyCredentialBinding(operator, {
        api_key_id: keyId,
        surface_grant: `surface:${surfaceId}:production` as SurfaceCredentialSelection["surface_grant"],
        credential_account_id: requiredTrimmedString(body, "credential_account_id")
      });
      return jsonResponse({ binding });
    }
    throw methodNotAllowed();
  }

  if (url.pathname === "/admin/usage" && request.method === "GET") {
    return routeAdminUsage(env, url);
  }

  if (url.pathname === "/admin/request-state" && request.method === "GET") {
    return routeAdminRequestState(env);
  }

  if (url.pathname === "/admin/readiness" && request.method === "GET") {
    return routeAdminReadiness(env, deps);
  }

  if (url.pathname === "/admin/request-audit/cleanup" && request.method === "POST") {
    return jsonResponse(await runRequestAuditCleanup(env, deps));
  }

  if (url.pathname === "/admin/execution-plans" && request.method === "GET") {
    return jsonResponse({
      kind: "execution_plans",
      version: EXECUTION_PLAN_SET_VERSION,
      plans: listExecutionPlans().map((plan) => ({
        id: plan.id,
        hostname: plan.hostname,
        environment: plan.environment,
        surface_grant: plan.surfaceGrant,
        credential_slot: plan.credentialSlot,
        credit_charge: plan.creditCharge,
        mode: plan.mode,
        support_status: plan.supportStatus,
        notes: plan.notes
      }))
    }, { headers: { "Cache-Control": "no-store" } });
  }

  if (url.pathname === "/admin/subscriptions" && request.method === "GET") {
    const rows = await listSubscriptionAccounts(env);
    return jsonResponse({
      kind: "subscription_accounts",
      accounts: rows.map(publicSubscriptionAccount)
    }, { headers: { "Cache-Control": "no-store" } });
  }

  if (url.pathname === "/admin/subscriptions" && request.method === "POST") {
    const body = await readJsonObject(request);
    const account = await createGrokSubscription(operator, {
      capability_source: requiredTrimmedString(body, "capability_source") as CapabilitySource,
      environment: requiredTrimmedString(body, "environment") as SubscriptionEnvironment,
      label: requiredTrimmedString(body, "label"),
      provider_account_ref: nullableStringField(body, "provider_account_ref") ?? null
    });
    return jsonResponse({ account: publicSubscriptionAccount(account) }, { status: 201 });
  }

  const subscriptionMatch = /^\/admin\/subscriptions\/([^/]+)(?:\/(import|refresh|test|oauth\/start|oauth\/complete))?$/.exec(url.pathname);
  if (subscriptionMatch) {
    const accountId = decodeURIComponent(subscriptionMatch[1]);
    const action = subscriptionMatch[2];
    const account = await getSubscriptionAccount(env, accountId);

    // Allow DELETE without a D1 row so orphan TokenAuthority DO storage can be purged.
    if (!action && request.method === "DELETE") {
      return jsonResponse(await logoutGrokCredential(operator, accountId));
    }

    if (!account) {
      throw subscriptionNotFound();
    }

    if (!action && request.method === "GET") {
      return jsonResponse({ account: publicSubscriptionAccount(account) }, { headers: { "Cache-Control": "no-store" } });
    }

    if (action === "oauth/start" && request.method === "POST") {
      if (account.capability_source !== "grok") {
        throw new HttpError(400, "OAuth start is only for Grok accounts", "invalid_request_error", "invalid_capability_source");
      }
      const body = await optionalOAuthStartBody(request);
      return jsonResponse(await beginGrokCredentialOAuth(operator, accountId, nullableStringField(body, "redirect_uri")));
    }

    if (action === "oauth/complete" && request.method === "POST") {
      if (account.capability_source !== "grok") {
        throw new HttpError(400, "OAuth complete is only for Grok accounts", "invalid_request_error", "invalid_capability_source");
      }
      const body = await readJsonObject(request);
      const result = await completeGrokCredentialOAuth(operator, accountId, {
        session_id: nullableStringField(body, "session_id"),
        state: nullableStringField(body, "state"),
        code: nullableStringField(body, "code"),
        callback_url: nullableStringField(body, "callback_url")
      });
      return jsonResponse({
        account: publicSubscriptionAccount(result.account),
        diagnostics: { refresh_available: result.refresh_available, secrets_echoed: false }
      }, { status: 201 });
    }

    if (action === "import" && request.method === "POST") {
      const body = await readJsonObject(request);
      const result = await importGrokCredential(operator, accountId, {
        session: nullableStringField(body, "session"),
        content: nullableStringField(body, "content"),
        access_token: nullableStringField(body, "access_token"),
        refresh_token: nullableStringField(body, "refresh_token"),
        id_token: nullableStringField(body, "id_token"),
        oidc_issuer: nullableStringField(body, "oidc_issuer"),
        oidc_client_id: nullableStringField(body, "oidc_client_id"),
        expires_at: nullableStringField(body, "expires_at"),
        account_ref: nullableStringField(body, "account_ref"),
        email: nullableStringField(body, "email")
      });
      return jsonResponse({
        account: publicSubscriptionAccount(result.account),
        diagnostics: result.diagnostics
      }, { status: 201 });
    }

    if (action === "refresh" && request.method === "POST") {
      const result = await refreshGrokCredential(operator, accountId);
      return jsonResponse({
        account: publicSubscriptionAccount(result.account),
        diagnostics: result.diagnostics
      });
    }

    if (action === "test" && request.method === "POST") {
      const result = await testGrokCredential(operator, accountId);
      return jsonResponse({ ...result, account: publicSubscriptionAccount(result.account) });
    }
  }

  throw adminRouteNotFound();
}

export function isAdminSurface(request: Request, url: URL, env: Env): boolean {
  if (url.hostname === CODEX_API_HOSTNAME) {
    return url.pathname.startsWith("/admin/");
  }
  return isDashboardRoute(request, url, env);
}

function isOwnConsolePath(pathname: string, method: string): boolean {
  if(/^\/me\/ui\/runtime-clients\/[a-f0-9-]{36}\/revoke$/.test(pathname))return method==="POST";
  if (pathname === "/me/service-accounts") return method === "GET";
  const service = /^\/me\/service-accounts\/[^/]+(.*)$/.exec(pathname);
  if (service) {
    const suffix = service[1]!;
    if (suffix === "" || suffix === "/setup") return method === "GET";
    return /^\/(?:credits|usage|keys(?:\/|$)|ui\/keys(?:\/|$))/.test(suffix) && isOwnConsolePath(`/me${suffix}`, method);
  }
  if (pathname === "/me" || pathname === "/me/credits" || pathname === "/me/service-availability" || pathname === "/me/usage") return method === "GET";
  if (pathname === "/me/keys") return method === "GET" || method === "POST";
  if (pathname === "/me/keys/revoke-all" || pathname === "/me/ui/keys" || pathname === "/me/ui/keys/revoke-all") return method === "POST";
  if (/^\/me\/keys\/[^/]+$/.test(pathname)) return method === "PATCH" || method === "DELETE";
  if (/^\/me\/keys\/[^/]+\/replace$/.test(pathname)) return method === "POST";
  if (/^\/me\/ui\/keys\/[^/]+\/(?:rename|revoke|replace)$/.test(pathname)) return method === "POST";
  return false;
}

async function ownKeyResponse(
  request: Request,
  env: Env,
  url: URL,
  principal: ConsolePrincipal,
  audit: { subject: string | null; requestId: string | null },
  now: Date,
  service?: ServiceContext
): Promise<Response> {
  const actor = {
    kind: "access" as const,
    ...(service ? {delegatedServiceId: service.id} : {}),
    email: principal.email,
    subject: audit.subject,
    userId: principal.id,
    role: principal.role,
    requestId: audit.requestId,
    sessionEpoch: principal.sessionEpoch
  };
  const body = request.method === "GET" ? {} : await readOwnBody(request);
  const pathKey = /^\/me\/(?:ui\/)?keys\/([^/]+)(?:\/(?:rename|revoke|replace))?$/.exec(url.pathname)?.[1];
  const keyId = pathKey && pathKey !== "revoke-all" ? decodeURIComponent(pathKey) : undefined;
  let issuanceId: string | undefined;
  let fingerprint: string | undefined;
  try {
    if (wantsHtml(request) && request.method === "POST" && (url.pathname === "/me/ui/keys" || url.pathname.endsWith("/replace"))) {
      if (typeof body.submission_id !== "string" || !/^submit_[0-9a-f-]{36}$/.test(body.submission_id)) {
        throw new HttpError(400, "Reopen the form before issuing a key.", "invalid_request_error", "key_submission_required");
      }
      // Public, owner-scoped submission identity; the existing key PK is the
      // atomic at-most-once boundary. No plaintext or separate receipt is stored.
      const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${principal.id}\0${body.submission_id}`));
      issuanceId = `key_ui_${bytesToHex(new Uint8Array(hash))}`;
      rejectMemberCredentialChoice(body, Boolean(service));
      const canonical = JSON.stringify({ actor: principal.id, ...(service ? {service:service.id} : {}), action: url.pathname,
        name: typeof body.name === "string" ? body.name.trim() : body.name ?? null,
        surfaces: memberStringList(body, "surfaces").concat(memberStringList(body, "scopes"), formProductScopes(body)).sort(),
        expires_at: typeof body.expires_at === "string" ? body.expires_at.trim() : null });
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
      fingerprint = bytesToHex(new Uint8Array(digest));
      const replay = await memberSubmissionReplay(env, principal, actor.requestId ?? "", issuanceId, fingerprint, service);
      if (replay) return replay;
    }
    return await ownKeyOperation(request, env, url, principal, actor, body, now, issuanceId, fingerprint, service);
  } catch (error) {
    // A racing replay can hit the primary key after the preliminary read.
    if (issuanceId && fingerprint) {
      try {
        const replay = await memberSubmissionReplay(env, principal, actor.requestId ?? "", issuanceId, fingerprint!, service);
        if (replay) return replay;
      } catch (replayError) { error = replayError; }
    }
    if (wantsHtml(request) && error instanceof HttpError && ["console_identity_changed", "admin_auth_required", ...(!service ? ["user_inactive"] : [])].includes(error.code ?? "")) {
      return consoleLifecycleOutcome({rejected:true,href:"/login",returnTarget:memberHref("keys",keyId,service?.id),label:"重新登录",cookie:clearConsoleSessionCookie(),message:"当前登录身份已经失效，这次密钥操作没有执行。重新登录后查看当前状态。"});
    }
    if (wantsHtml(request) && error instanceof HttpError && ([400,403,404,409,422].includes(error.status) || error.code === "credential_default_unavailable")) {
      return memberMutationPage({ principal, service, requestId: actor.requestId ?? "", keyId, status: error.status, rejected: true,
        message: consoleErrorMessage(error.code ?? null), attemptedName: typeof body.name === "string" ? body.name : undefined });
    }
    throw error;
  }
}

async function memberSubmissionReplay(env: Env, principal: ConsolePrincipal, requestId: string, keyId: string, fingerprint: string, service?: ServiceContext): Promise<Response | null> {
  const key = await getApiKeyById(env, keyId);
  if (!key) return null;
  await assertKeyActorAuthority(env, {kind:"access",userId:principal.id,email:principal.email,sessionEpoch:principal.sessionEpoch,role:principal.role,subject:null,requestId, ...(service ? {delegatedServiceId:service.id} : {})}, service?.id ?? principal.id);
  const audit = await env.DB.prepare(`SELECT a.meta, u.status, u.console_session_epoch, u.canonical_email, u.login_capable FROM operator_mutation_audit AS a JOIN users AS u ON u.id = a.actor_user_id
    WHERE target_type = 'api_key' AND target_id = ? AND actor_user_id = ?
      AND action IN ('key.create','key.replace.create') LIMIT 1`).bind(keyId, principal.id).first<{meta: string; status: string; console_session_epoch: number; canonical_email: string; login_capable: number}>();
  if (audit && (audit.status !== "active" || audit.console_session_epoch !== principal.sessionEpoch || audit.canonical_email !== principal.email || audit.login_capable !== 1)) throw new HttpError(403, "Console identity changed.", "authentication_error", "console_identity_changed");
  let matched = false;
  try { matched = key.user_id === (service?.id ?? principal.id) && JSON.parse(audit?.meta ?? "null")?.member_submission_fingerprint === fingerprint; } catch { /* no trusted receipt */ }
  if (!matched) throw new HttpError(409, "This submission identity belongs to a different operation.", "invalid_request_error", "key_submission_mismatch");
  return memberMutationPage({principal,service,requestId,keyId,message:"这次提交此前已经完成，密钥不会再次发行或重显。当前状态请通过只读页面核对。"});
}

async function ownKeyOperation(request: Request, env: Env, url: URL, principal: ConsolePrincipal,
  actor: Parameters<typeof issueMemberKey>[1], body: JsonObject, now: Date, issuanceId?: string, fingerprint?: string, service?: ServiceContext): Promise<Response> {
  const privateJson = { headers: { "Cache-Control": "no-store" } };
  if (url.pathname === "/me/keys" && request.method === "GET") {
    return jsonResponse({ keys: await listMemberKeys(env, service?.id ?? principal.id, now) }, privateJson);
  }
  if ((url.pathname === "/me/keys" || url.pathname === "/me/ui/keys") && request.method === "POST") {
    rejectMemberCredentialChoice(body, Boolean(service));
    const issued = await issueMemberKey(env, actor, service?.id ?? principal.id, {
      name: body.name,
      surfaces: memberStringList(body, "surfaces").concat(memberStringList(body, "scopes"), formProductScopes(body)),
      expires_at: nullableStringField(body, "expires_at")
    }, now, issuanceId, fingerprint);
    if (wantsHtml(request)) {
      return memberSecretPage({ principal, service, token: issued.token, key: memberKey(issued), requestId: actor.requestId ?? "" });
    }
    return jsonResponse({ api_key: issued.token, key: memberKey(issued) }, { status: 201, ...privateJson });
  }
  if ((url.pathname === "/me/keys/revoke-all" || url.pathname === "/me/ui/keys/revoke-all") && request.method === "POST") {
    const result = await revokeAllMemberKeys(env, actor, service?.id ?? principal.id, now);
    if (wantsHtml(request)) return memberMutationPage({principal,service, requestId: actor.requestId ?? "", message: `已撤销 ${result.revoked} 个密钥。`});
    return jsonResponse(result, privateJson);
  }
  const replace = /^\/me\/(?:ui\/)?keys\/([^/]+)\/replace$/.exec(url.pathname);
  if (replace && request.method === "POST") {
    const result = await replaceMemberKey(env, actor, service?.id ?? principal.id, decodeURIComponent(replace[1]!), nullableStringField(body, "expires_at"), now, issuanceId, fingerprint);
    if (wantsHtml(request)) {
      return memberSecretPage({
        principal, service,
        token: result.replacement.token,
        key: memberKey(result.replacement),
        requestId: actor.requestId ?? "",
        previousPrefix: result.previous.key_prefix,
        oldKeyRemainsActive: result.old_key_remains_active
      });
    }
    return jsonResponse({
      api_key: result.replacement.token,
      key: memberKey(result.replacement),
      previous: result.previous,
      old_key_remains_active: result.old_key_remains_active
    }, { status: 201, ...privateJson });
  }
  const rename = /^\/me\/ui\/keys\/([^/]+)\/rename$/.exec(url.pathname);
  if ((rename && request.method === "POST") || (/^\/me\/keys\/[^/]+$/.test(url.pathname) && request.method === "PATCH")) {
    const keyId = decodeURIComponent((rename ?? /^\/me\/keys\/([^/]+)$/.exec(url.pathname))![1]!);
    const key = await renameMemberKey(env, actor, service?.id ?? principal.id, keyId, body.name, now);
    if (wantsHtml(request)) return memberMutationPage({principal,service, requestId: actor.requestId ?? "", keyId, message: `名称已保存：${key.name}。密钥、范围和绑定不变。`});
    return jsonResponse({key}, privateJson);
  }
  const revoke = /^\/me\/ui\/keys\/([^/]+)\/revoke$/.exec(url.pathname);
  if ((revoke && request.method === "POST") || (/^\/me\/keys\/[^/]+$/.test(url.pathname) && request.method === "DELETE")) {
    const keyId = decodeURIComponent((revoke ?? /^\/me\/keys\/([^/]+)$/.exec(url.pathname))![1]!);
    const result = await revokeMemberKey(env, actor, service?.id ?? principal.id, keyId, now);
    if (wantsHtml(request)) return memberMutationPage({principal,service, requestId: actor.requestId ?? "", keyId, message: result.already_revoked ? "密钥原本已撤销，本次没有再次变更。" : "密钥已撤销。之后的新认证将被拒绝，既有流和外部任务不受此承诺覆盖。"});
    return jsonResponse(result, privateJson);
  }
  throw adminRouteNotFound();
}

function memberKey(key: PublicApiKey & { token?: string }): PublicApiKey {
  return {
    lifecycle: key.lifecycle,
    id: key.id,
    name: key.name,
    key_prefix: key.key_prefix,
    status: key.status,
    scopes: key.scopes,
    family_id: key.family_id,
    expires_at: key.expires_at,
    last_used_at: key.last_used_at,
    created_at: key.created_at,
    revoked_at: key.revoked_at
  };
}

function memberStringList(body: JsonObject, field: string): string[] {
  const value = body[field];
  if (typeof value === "string") return value.trim() ? [value.trim()] : [];
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim());
}

function rejectMemberCredentialChoice(body: JsonObject, delegated: boolean): void {
  // Personal /me compatibility: caller-supplied owner fields are ignored and
  // ownership is always derived from the principal. The new explicit service
  // API rejects target overrides rather than silently retargeting the operation.
  const forbidden = Object.keys(body).some((key) =>
    (delegated && ["user_id", "owner_user_id", "service_id"].includes(key)) || key === "credential_bindings" || key === "credential_account_id" || key.endsWith("_credential_account_id")
  );
  if (forbidden) {
    throw new HttpError(400, "Members cannot choose a credential account.", "invalid_request_error", "credential_selection_forbidden");
  }
}

async function readOwnBody(request: Request): Promise<JsonObject> {
  const contentType = request.headers.get("Content-Type") ?? "";
  if (contentType.includes("application/x-www-form-urlencoded")) {
    const params = new URLSearchParams(await request.text());
    const body: JsonObject = {};
    for (const [key, value] of params.entries()) {
      const name = key.endsWith("[]") ? key.slice(0, -2) : key;
      const existing = body[name];
      if (existing === undefined) body[name] = key.endsWith("[]") ? [value] : value;
      else if (Array.isArray(existing)) existing.push(value);
      else body[name] = [existing, value];
    }
    return body;
  }
  if (!contentType.includes("json")) return {};
  const text = await request.text();
  if (!text.trim()) return {};
  const parsed = JSON.parse(text) as unknown;
  if (!isRecord(parsed)) {
    throw jsonObjectRequired();
  }
  return parsed as JsonObject;
}

function isDashboardRoute(request: Request, url: URL, env: Env): boolean {
  if (url.hostname !== env.ADMIN_DASHBOARD_HOST) {
    return false;
  }
  if (url.pathname === "/login" || url.pathname === "/login/callback" || url.pathname === "/logout") return true;
  if (isRuntimeControlPath(url.pathname)) return true;
  if (isOwnConsolePath(url.pathname, request.method)) return true;
  if (url.pathname.startsWith("/admin/ui/") && request.method === "POST") {
    return true;
  }
  if (url.pathname === "/admin/console.js" && request.method === "GET") return true;
  if ([consoleStylesheetPath(), consoleClientPath()].includes(url.pathname) && url.search === "" && request.method === "GET") return true;
  return request.method === "GET"
    && (
      isAdminDashboardPage(url, env)
      || isDashboardAppPath(url.pathname)
      || url.pathname === "/admin/usage"
      || url.pathname === "/admin/codex-auths"
      || url.pathname.startsWith("/admin/codex-auths/")
      || url.pathname === "/admin/request-state"
      || url.pathname === "/admin/credential-status"
      || url.pathname === "/admin/events/credentials"
      || url.pathname === "/admin/readiness"
    );
}


/** Recover the owning GET from an action path without reading an unauthenticated body. */
function memberKeyActionReturn(pathname: string): string | undefined {
  const action = /^\/me(?:\/service-accounts\/([^/]+))?\/ui\/keys(?:\/([^/]+)\/(?:rename|revoke|replace)|\/revoke-all)?$/.exec(pathname);
  if (!action) return undefined;
  try {
    return memberHref("keys", action[2] ? decodeURIComponent(action[2]) : undefined, action[1] ? decodeURIComponent(action[1]) : undefined);
  } catch { return undefined; }
}

/** An empty acknowledgement cannot carry fresh identity UI. Recheck the exact
 * active session after model reads, before permitting the retained private DOM. */
function consoleAuthorityChanged(): HttpError {
  return new HttpError(403, "Console authority changed", "authentication_error", "console_identity_changed");
}

async function assertUnchangedReadAuthority(request: Request, env: Env, id: string | null | undefined, email: string | null | undefined, role: string, epoch: number | undefined, now: Date): Promise<void> {
  const current = await verifyConsoleAccess(request, env, now);
  if (!current || current.id !== id || current.email !== email || current.role !== role || current.sessionEpoch !== epoch) {
    throw consoleAuthorityChanged();
  }
}

async function authorizeConsole(
  request: Request,
  env: Env,
  url: URL,
  requestContext: RequestContext,
  currentTime: () => Date
): Promise<AdminIdentity | Response> {
  if (url.hostname === CODEX_API_HOSTNAME) return requireOperator(request, env);
  if (url.hostname !== env.ADMIN_DASHBOARD_HOST) {
    throw adminRouteNotFound();
  }
  assertConsoleBrowserWrite(request, env, url);
  const principal = await verifyConsoleAccess(request, env, new Date(requestContext.startedAt));
  if (!principal) {
    const accept = request.headers.get("Accept") ?? "";
    if (request.method === "GET" && (request.headers.get("Sec-Fetch-Dest") === "document" || accept.includes("text/html"))) {
      if ((["/", "/admin", "/admin/"].includes(url.pathname) || /^\/me\/service-accounts\/[^/]+$/.test(url.pathname)) && !consoleReturnTarget(url.pathname + url.search)) {
        throw invalidConsoleReturn();
      }
      return new Response(null, {
        status: 302,
        headers: {
          Location: `https://${env.ADMIN_DASHBOARD_HOST}${consoleLoginHref(url.pathname + url.search)}`,
          "Cache-Control": "no-store",
          "Referrer-Policy": "no-referrer"
        }
      });
    }
    if (wantsHtml(request) && request.method === "POST" && /^\/me(?:\/service-accounts\/[^/]+)?\/ui\/keys/.test(url.pathname)) {
      return consoleLifecycleOutcome({rejected:true,href:"/login",returnTarget:memberKeyActionReturn(url.pathname),label:"重新登录",cookie:clearConsoleSessionCookie(),message:"登录已失效，这次密钥操作没有执行。重新登录后查看当前状态。"});
    }
    if (wantsHtml(request) && request.method === "POST" && (url.pathname.startsWith("/admin/ui/users") || url.pathname.startsWith("/admin/ui/services"))) {
      return consoleLifecycleOutcome({ rejected: true, href: "/login", label: "重新登录", cookie: clearConsoleSessionCookie(), message: "登录已失效，这次管理操作没有执行。重新登录后查看当前状态。" });
    }
    if (wantsHtml(request) && request.method === "POST") {
      const installation=/^\/admin\/ui\/runtime-installations\/([a-z][a-z0-9-]{0,63})$/.exec(url.pathname);
      const client=/^\/me\/ui\/runtime-clients\/[a-f0-9-]{36}\/revoke$/.test(url.pathname);
      if(installation||client)return consoleLifecycleOutcome({rejected:true,href:"/login",returnTarget:installation?`/admin?view=runtime&installation=${installation[1]}`:runtimeMemberHref(),label:"重新登录",cookie:clearConsoleSessionCookie(),message:"登录已失效，这次工具服务操作没有执行。重新登录后查看当前状态。"});
    }
    throw adminAuthRequired();
  }
  if (url.pathname === "/me/service-accounts" && request.method === "GET") return jsonResponse({services:await listDelegatedServices(env,principal)}, {headers:{"Cache-Control":"no-store"}});
  const delegated = /^\/me\/service-accounts\/([^/]+)(.*)$/.exec(url.pathname);
  if (delegated) {
    const service = await delegatedService(env, principal, decodeURIComponent(delegated[1]!));
    const suffix = delegated[2]!;
    const scopedUrl = new URL(url); scopedUrl.pathname = `/me${suffix}`;
    const now = new Date(requestContext.startedAt);
    let response: Response;
    if ((suffix === "" || suffix === "/setup") && request.method === "GET") {
      if (suffix === "/setup") scopedUrl.searchParams.set("view", "setup");
      response = wantsHtml(request) || suffix === "/setup" ? await memberConsoleResponse({request,env,url:scopedUrl,principal,service,now,requestId:requestContext.requestId,unchangedRevision:request.headers.get("X-Console-Revision")})
        : jsonResponse({service}, {headers:{"Cache-Control":"no-store"}});
    } else if (suffix === "/credits" && request.method === "GET") response = meCreditResponse(await listSurfaceCreditStates(env,now,service.id));
    else if (suffix === "/usage" && request.method === "GET") response = await memberUsageResponse({env,url:scopedUrl,principal,service,now});
    else response = await ownKeyResponse(request,env,scopedUrl,principal,{subject:null,requestId:requestContext.requestId},now,service);
    // Read projections cannot return an old delegation after intervening awaits.
    // Writes are authorized by the committing operation and retain truthful outcomes.
    if (request.method === "GET") await delegatedService(env,principal,service.id);
    if (response.status === 204) await assertUnchangedReadAuthority(request,env,principal.id,principal.email,principal.role,principal.sessionEpoch,currentTime());
    return response;
  }
  if (url.pathname === "/me" && request.method === "GET") return meResponse(principal);
  if (url.pathname === "/me/credits" && request.method === "GET") {
    return meCreditResponse(await listSurfaceCreditStates(env, new Date(requestContext.startedAt), principal.id));
  }
  if (url.pathname === "/me/service-availability" && request.method === "GET") {
    return serviceAvailabilityResponse(env, new Date(requestContext.startedAt));
  }
  if (url.pathname === "/me/usage" && request.method === "GET") {
    return memberUsageResponse({
      env,
      url,
      principal,
      now: new Date(requestContext.startedAt)
    });
  }
  if (isOwnConsolePath(url.pathname, request.method)) {
    const client=/^\/me\/ui\/runtime-clients\/([a-f0-9-]{36})\/revoke$/.exec(url.pathname);
    if(client) {
      if(url.search)throw invalidRuntimeOperation();
      let installation:string|undefined;
      try {installation=await revokeRuntimeClient(request,env,client[1]!);}
      catch(error) {
        if(error instanceof HttpError&&[400,401,403,404].includes(error.status))throw error;
        return consoleUnknownOutcome(runtimeMemberHref());
      }
      return memberConsoleResponse({request,env,url:new URL(runtimeMemberHref(installation),url),principal,now:currentTime(),requestId:requestContext.requestId,runtimeRevoked:true});
    }
    return ownKeyResponse(request, env, url, principal, {
      subject: null,
      requestId: requestContext.requestId
    }, new Date(requestContext.startedAt));
  }
  if (url.pathname === "/admin/console.js" && request.method === "GET") return consoleClientResponse();
  // Exact non-personal installation resources share the active-session boundary.
  if (request.method === "GET" && isDashboardAppPath(url.pathname)) return dashboardAppResponse(url.pathname)!;
  if (request.method === "GET" && isAdminDashboardPage(url, env) && url.searchParams.has("area")) {
    if (url.searchParams.getAll("area").length !== 1 || url.searchParams.get("area") !== "me") {
      throw new HttpError(404, "Console area not found", "invalid_request_error", "not_found");
    }
    const response = await memberConsoleResponse({ request,env, url, principal, now: new Date(requestContext.startedAt), requestId: requestContext.requestId, unchangedRevision: request.headers.get("X-Console-Revision") });
    if (response.status === 204) await assertUnchangedReadAuthority(request,env,principal.id,principal.email,principal.role,principal.sessionEpoch,currentTime());
    return response;
  }
  if (principal.role !== "admin") {
    if (request.method === "GET" && isAdminDashboardPage(url, env)) {
      const response = await memberConsoleResponse({
        request,
        unchangedRevision: request.headers.get("X-Console-Revision"),
        env,
        url,
        principal,
        now: new Date(requestContext.startedAt),
        requestId: requestContext.requestId
      });
      if (response.status === 204) await assertUnchangedReadAuthority(request,env,principal.id,principal.email,principal.role,principal.sessionEpoch,currentTime());
      return response;
    }
    if (wantsHtml(request) && request.method === "POST" && (url.pathname.startsWith("/admin/ui/users") || url.pathname.startsWith("/admin/ui/services"))) {
      return consoleLifecycleOutcome({ rejected: true, href: "/admin?view=keys", label: "打开我的密钥", message: "你当前没有管理员权限，这次管理操作没有执行。个人密钥仍可在我的密钥中管理。" });
    }
    throw adminRequired();
  }
  return {
    kind: "console",
    email: principal.email,
    subject: null,
    userId: principal.id,
    role: principal.role,
    sessionEpoch: principal.sessionEpoch
  };
}


function publicCreditState(state: Awaited<ReturnType<typeof listSurfaceCreditStates>>[number]) {
  return state.surface_grant === "surface:xai:production"
    ? { ...state, shared_provider_authority: XAI_SHARED_PROVIDER_AUTHORITY }
    : state;
}

function meCreditResponse(states: Awaited<ReturnType<typeof listSurfaceCreditStates>>): Response {
  return jsonResponse({
    credits: states.map((state) => ({
      surface: state.surface_grant.split(":")[1],
      surface_grant: state.surface_grant,
      mode: state.mode,
      monthly_allowance: state.monthly_allowance,
      source: state.source,
      consumed_credits: state.consumed_credits,
      reconciliation: state.reconciliation,
      remaining_credits: state.remaining_credits,
      period_start: state.period_start,
      reset_at: state.reset_at
    }))
  }, { headers: { "Cache-Control": "no-store" } });
}

function meResponse(principal: ConsolePrincipal): Response {
  return jsonResponse({
    user: {
      id: principal.id,
      email: principal.email,
      role: principal.role,
      status: principal.status
    }
  }, { headers: { "Cache-Control": "no-store" } });
}

async function commitLifecycle(
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

function ownerInput(body: JsonObject): {owner_user_id:string|null;expected_revision:number} {
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

function publicService(user: NonNullable<Awaited<ReturnType<typeof getUser>>>) {
  return { id: user.id, account_kind: user.account_kind, display_name: user.display_name,
    status: user.status, role: user.role, login_capable: user.login_capable,
    created_at: user.created_at, updated_at: user.updated_at };
}

async function routeDashboardUiMutation(
  request: Request,
  env: Env,
  url: URL,
  deps: AppDependencies,
  requestContext: RequestContext,
  admin: AdminIdentity
): Promise<Response> {
  if (request.method !== "POST") {
    throw methodNotAllowed();
  }
  // Dashboard writes require the console session, not the operator bearer.
  if (admin.kind !== "console") {
    throw adminAuthRequired();
  }

  const operator = operatorMutationContext(env, deps, admin, requestContext);
  const runtime=/^\/admin\/ui\/runtime-installations\/([a-z][a-z0-9-]{0,63})$/.exec(url.pathname);
  if(runtime) {
    if(url.search)throw invalidRuntimeOperation();
    const body=await readRuntimeForm(request);
    let flash:DashboardMutationFlash;
    let status=200;
    try {
      await mutateRuntimeInstallation(env,credentialActor(operator),runtime[1]!,body,operator.now);
      flash={kind:"runtime_changed",installation_id:runtime[1]!,message:"工具服务操作已完成。请核对当前状态；已执行的上游操作和资源不会因此撤回或迁移。"};
    } catch(error) {
      // Actor/revision rejection can occur after staging across D1 and the DO.
      // Only input validation is known not to have written; all other uncertain
      // outcomes require a GET, never an automatic repeat of this POST.
      if(!(error instanceof HttpError)||error.status!==400)return consoleUnknownOutcome(`/admin?view=runtime&installation=${runtime[1]}`,"工具服务操作结果尚未确认。请重新打开页面读取当前状态；不会自动重复提交。");
      status=error.status;flash={kind:"runtime_error",installation_id:runtime[1]!,message:"这次操作未完成。页面权限、配置版本或输入已改变；请查看当前状态后重新打开表单。"};
    }
    return dashboardAfterMutation(env,url,admin,deps,requestContext,flash,status);
  }
  const body = await readDashboardBody(request);

  const credentialDefault = /^\/admin\/ui\/credential-defaults\/(codex|grok|xai)$/.exec(url.pathname);
  const retirementTask = /^\/admin\/ui\/(codex-auths|subscriptions)\/([^/]+)\/(migrate|cleanup)$/.exec(url.pathname);
  if (credentialDefault || retirementTask) {
    const provider = retirementTask ? retirementTask[1] === "codex-auths" ? "codex" : "grok" : undefined;
    const accountId = retirementTask ? decodeURIComponent(retirementTask[2]!) : undefined;
    const surface = credentialDefault?.[1];
    const grant = surface ? `surface:${surface}:production` as OrganizationSurface : undefined;
    const credentialActorValue = credentialActor(operator);
    try {
      requireConfirmation(body, "Credential change");
      let flash: DashboardMutationFlash;
      let result: unknown;
      if (grant) {
        const id = requiredTrimmedString(body, "credential_account_id");
        await commitCredentialDefault(env, credentialActorValue, {surface_grant: grant, credential_account_id: id}, operator.now);
        result = {ok:true, surface_grant:grant};
        flash = {kind:"credential_default",surface_grant:grant,account_id:id};
      } else if (retirementTask![3] === "migrate") {
        const defaults = (stringArrayField(body,"default_surfaces") ?? []).map(value => {
          if (!["codex","grok","xai"].includes(value)) throw new HttpError(400,"Invalid surface","invalid_request_error","invalid_surface");
          return `surface:${value}:production` as OrganizationSurface;
        });
        const migration = await migrateCredentialBindings(env, credentialActorValue, {kind:provider!,account_id:accountId!,replacement_account_id:requiredTrimmedString(body,"replacement_account_id"),key_ids:stringArrayField(body,"key_ids") ?? [],default_surfaces:defaults}, operator.now);
        result = migration;
        flash = {kind:"credential_migrated",provider:provider!,account_id:accountId!,bindings:migration.migrated_bindings,defaults:migration.migrated_defaults};
      } else {
        const cleanup = () => provider === "codex" ? codexTokenAuthority(env,accountId!).revoke()
          : env.TOKEN_AUTHORITY.get(env.TOKEN_AUTHORITY.idFromName(`subscription:${accountId}`)).revokeSubscription();
        const completion = await retryCredentialCleanup(env,credentialActorValue,{kind:provider!,account_id:accountId!},cleanup,operator.now);
        result = completion;
        flash = {kind:"credential_cleanup",provider:provider!,account_id:accountId!,token_cleanup:completion.token_cleanup};
      }
      if (!wantsHtml(request)) return jsonResponse(result);
      return dashboardAfterMutation(env,url,admin,deps,requestContext,flash,200,undefined,...mutationReturn(body));
    } catch (error) {
      if (retirementTask?.[3] === "cleanup" && error instanceof HttpError && error.status === 403 && wantsHtml(request)) {
        return consoleUnknownOutcome(`/admin?view=credentials&account=${encodeURIComponent(`${provider}:${accountId}`)}`);
      }
      assertHtmlMutationError(error, request, [400, 409, 422]);
      return dashboardAfterMutation(env,url,admin,deps,requestContext,{kind:"credential_task_error",provider,account_id:accountId,surface_grant:grant,message:consoleErrorMessage(error.code ?? null)},error.status,undefined,...mutationReturn(body));
    }
  }

  if (url.pathname === "/admin/ui/users") {
    const email = nullableStringField(body, "email") ?? "";
    try {
      const user = await createOrganizationUser(operator, email);
      if (wantsHtml(request)) return dashboardAfterMutation(env, url, admin, deps, requestContext, { kind: "user_created", user_id: user.id, email: user.email });
      return jsonResponse({ user }, { status: 201 });
    } catch (error) {
      if (error instanceof HttpError && error.status === 403 && wantsHtml(request)) {
        return consoleLifecycleOutcome({ rejected: true, href: "/login", label: "重新登录", message: "你的登录身份或管理员权限已改变，这次人员创建没有执行。请重新登录并查看当前状态。" });
      }
      assertHtmlMutationError(error, request, [400, 409]);
      return dashboardAfterMutation(env, url, admin, deps, requestContext, {
        kind: "user_create_error", email, message: consoleErrorMessage(error.code ?? null)
      }, error.status);
    }
  }

  const ownerMatch = /^\/admin\/ui\/services\/([^/]+)\/owner$/.exec(url.pathname);
  if (ownerMatch) {
    const id = decodeURIComponent(ownerMatch[1]!);
    try {
      requireConfirmation(body,"Change service owner; credentials unchanged");
      const owner = await assignServiceOwner(operator,id,ownerInput(body));
      if (!wantsHtml(request)) return jsonResponse({owner,credentials_unchanged:true});
      return dashboardAfterMutation(env,url,admin,deps,requestContext,{kind:"service_owner_changed",user_id:id},200,stringField(body,"person_return"));
    } catch (error) {
      assertHtmlMutationError(error, request, [400, 403, 409]);
      return dashboardAfterMutation(env,url,admin,deps,requestContext,{kind:"service_error",user_id:id,action:"owner",display_name:"",message:consoleErrorMessage(error.code ?? null)},error.status,stringField(body,"person_return"));
    }
  }
  const serviceMatch = /^\/admin\/ui\/services(?:\/([^/]+)\/(name|classify))?$/.exec(url.pathname);
  if (serviceMatch) {
    const id = serviceMatch[1] ? decodeURIComponent(serviceMatch[1]) : undefined;
    const action = serviceMatch[2] === "classify" ? "classify" : id ? "rename" : "create";
    const displayName = stringField(body, "display_name") ?? "";
    try {
      if (action === "classify") requireConfirmation(body, "Classify legacy service");
      const user = action === "create" ? await createServiceAccount(operator, displayName)
        : action === "rename" ? await renameServiceAccount(operator, id!, displayName)
        : await classifyServiceAccount(operator, id!, { display_name: displayName, expected_updated_at: requiredTrimmedString(body, "expected_updated_at") });
      if (!wantsHtml(request)) return jsonResponse({ user: publicService(user) }, { status: action === "create" ? 201 : 200 });
      return dashboardAfterMutation(env, url, admin, deps, requestContext, { kind: "service_changed", user_id: user.id, action, display_name: user.display_name! }, 200, stringField(body, "person_return"));
    } catch (error) {
      if (error instanceof HttpError && error.status === 403 && wantsHtml(request)) return consoleLifecycleOutcome({ rejected: true, href: "/login", label: "重新登录", message: "管理员身份已改变，这次服务账号操作没有执行。请重新登录后查看当前状态。" });
      assertHtmlMutationError(error, request, [400, 409]);
      return dashboardAfterMutation(env, url, admin, deps, requestContext, { kind: "service_error", user_id: id, action, display_name: displayName, message: consoleErrorMessage(error.code ?? null) }, error.status, stringField(body, "person_return"));
    }
  }

  const createKey = url.pathname === "/admin/ui/keys";
  if (createKey) {
    const scopes = stringArrayField(body, "scopes") ?? formProductScopes(body);
    const created = await issueApiKey(operator, {
      user_id: requiredTrimmedString(body, "user_id"),
      name: typeof body.name === "string" ? body.name : "",
      scopes,
      expires_at: dashboardKeyExpiry(body),
      credential_bindings: formCredentialBindings(body, scopes)
    });
    if (wantsHtml(request)) {
      return dashboardAfterMutation(env, url, admin, deps, requestContext, {
        kind: "key_created",
        token: created.token,
        key_id: created.id,
        key_prefix: created.key_prefix,
        user_id: created.user_id,
        email: (await getUser(env, created.user_id))?.email ?? null,
        scopes: created.scopes
      });
    }
    return jsonResponse(created, { status: 201 });
  }

  const replaceMatch = /^\/admin\/ui\/keys\/([^/]+)\/replace$/.exec(url.pathname);
  if (replaceMatch) {
    requireConfirmation(body, "Replace key");
    const keyId = decodeURIComponent(replaceMatch[1]);
    let result: Awaited<ReturnType<typeof issueReplacementApiKey>>;
    try {
      result = await issueReplacementApiKey(operator, keyId, dashboardKeyExpiry(body));
    } catch (error) {
      if (!(error instanceof HttpError) || !wantsHtml(request) || !["invalid_expires_at", "expiry_in_past", "expiry_too_far", "invalid_expires_at_utc", "ambiguous_expiry"].includes(error.code ?? "")) throw error;
      const key = await getApiKeyById(env, keyId);
      if (!key) throw error;
      return dashboardAfterMutation(env, url, admin, deps, requestContext, {kind:"key_replacement_error", key_id:keyId, user_id:key.user_id, message:consoleErrorMessage(error.code ?? null)}, error.status, stringField(body, "key_return"));
    }
    if (wantsHtml(request)) {
      return dashboardAfterMutation(env, url, admin, deps, requestContext, {
        kind: "key_replacement_created",
        token: result.replacement.token,
        key_id: result.replacement.id,
        key_prefix: result.replacement.key_prefix,
        user_id: result.replacement.user_id,
        email: (await getUser(env, result.replacement.user_id))?.email ?? null,
        scopes: result.replacement.scopes,
        previous_key_id: result.previous.id,
        previous_key_prefix: result.previous.key_prefix,
        old_key_remains_active: result.old_key_remains_active
      }, 200, stringField(body, "key_return"));
    }
    return jsonResponse(result, { status: 201 });
  }

  const bindingMatch = /^\/admin\/ui\/keys\/([^/]+)\/credential-bindings\/(codex|grok|xai)$/.exec(url.pathname);
  if (bindingMatch) {
    const keyId = decodeURIComponent(bindingMatch[1]);
    const surface = bindingMatch[2];
    const result = await setApiKeyCredentialBinding(operator, {
      api_key_id: keyId,
      surface_grant: `surface:${surface}:production` as SurfaceCredentialSelection["surface_grant"],
      credential_account_id: requiredTrimmedString(body, "credential_account_id")
    });
    if (wantsHtml(request)) {
      return dashboardAfterMutation(env, url, admin, deps, requestContext, {
        kind: "credential_binding",
        key_id: keyId,
        surface_grant: result.surface_grant
      }, 200, stringField(body, "key_return"));
    }
    return jsonResponse({ binding: result });
  }

  const revokeMatch = /^\/admin\/ui\/keys\/([^/]+)\/revoke$/.exec(url.pathname);
  if (revokeMatch) {
    requireConfirmation(body, "Revoke");
    const result = await revokeApiKey(operator, decodeURIComponent(revokeMatch[1]));
    if (wantsHtml(request)) {
      return dashboardAfterMutation(env, url, admin, deps, requestContext, {
        kind: "key_revoked",
        key_id: result.id,
        key_prefix: result.key_prefix,
        already_revoked: result.already_revoked
      }, 200, stringField(body, "key_return"));
    }
    return jsonResponse(result);
  }

  const lifecycleMatch = /^\/admin\/ui\/users\/([^/]+)\/(role|email|status)$/.exec(url.pathname);
  if (lifecycleMatch) {
    requireConfirmation(body, "Member change");
    const userId = decodeURIComponent(lifecycleMatch[1]!);
    const action = lifecycleMatch[2]!;
    const returnUrl = stringField(body, "person_return");
    let result: unknown;
    let flash: DashboardMutationFlash;
    try {
      if (action === "role") {
        const role = userRole(requiredTrimmedString(body, "role"));
        result = await setUserRole(operator, userId, role);
        flash = { kind: "user_role", user_id: userId, role };
      } else if (action === "email") {
        const changed = await changeUserEmail(operator, userId, requiredTrimmedString(body, "email"));
        result = changed;
        flash = { kind: "user_email", user_id: userId, email: changed.email, previous_email: changed.previous_email };
      } else {
        const status = userStatus(requiredTrimmedString(body, "status"));
        const changed = await setUserStatus(operator, userId, status);
        result = changed;
        flash = { kind: "user_status", user_id: userId, email: changed.email, status };
      }
    } catch (error) {
      if (error instanceof HttpError && error.status === 403 && wantsHtml(request)) {
        return consoleLifecycleOutcome({ rejected: true, href: "/login", label: "重新登录", message: "你的登录身份或管理员权限已改变，这次管理操作没有执行。请重新登录并查看当前状态。" });
      }
      assertHtmlMutationError(error, request, [400, 409]);
      return dashboardAfterMutation(env, url, admin, deps, requestContext, {
        kind: "user_lifecycle_error", user_id: userId, action, email: stringField(body, "email") ?? "", message: consoleErrorMessage(error.code ?? null)
      }, error.status, returnUrl);
    }
    if (!wantsHtml(request)) return jsonResponse(result);
    if (userId === admin.userId && (action === "email" || (flash.kind === "user_status" && flash.status === "disabled"))) {
      return consoleLifecycleOutcome({ href: "/login", label: "重新登录", cookie: clearConsoleSessionCookie(),
        message: action === "email" ? "邮箱已迁移，旧控制台会话已失效。请使用新邮箱重新登录。API 密钥和历史不变，撤销或替换密钥需单独操作。" : "账号已停用，旧控制台会话已失效。请联系其他管理员恢复账号后重新登录。" });
    }
    if (userId === admin.userId && flash.kind === "user_role" && flash.role === "user") {
      return consoleLifecycleOutcome({ href: "/admin?view=keys", label: "打开我的密钥", message: "你现在是普通成员，组织管理权限已结束。个人 API 密钥、额度和历史不变。" });
    }
    return dashboardAfterMutation(env, url, admin, deps, requestContext, flash, 200, returnUrl);
  }

  if (url.pathname === "/admin/ui/credit-defaults") {
    requireConfirmation(body, "Default change");
    try {
      const defaults = await setOrganizationCreditDefaults(operator, CREDIT_SURFACE_IDS.map(surface => ({
        surface, monthly_allowance:requiredNonNegativeIntegerField(body,surface),
        expected_monthly_allowance:requiredNonNegativeIntegerField(body,`expected_${surface}`)
      })));
      if (!wantsHtml(request)) return jsonResponse({defaults});
      return dashboardAfterMutation(env,url,admin,deps,requestContext,{kind:"credit_default",defaults});
    } catch (error) {
      assertHtmlMutationError(error, request, [400, 409]);
      return dashboardAfterMutation(env,url,admin,deps,requestContext,{kind:"credit_default_error",message:consoleErrorMessage(error.code ?? null)},error.status);
    }
  }

  const creditDefaultUi = /^\/admin\/ui\/credit-defaults\/(codex|grok|xai)$/.exec(url.pathname);
  if (creditDefaultUi) {
    if (wantsHtml(request)) return dashboardAfterMutation(env, url, admin, deps, requestContext, {
      kind: "credit_default_error", message: "旧额度表单已停用，这次没有保存。请在当前设置中重新确认额度。"
    }, 409);
    requireConfirmation(body, "Default change");
    const surface = creditDefaultUi[1] as CreditSurfaceId;
    const result = await setOrganizationCreditDefault(operator, {
      surface,
      monthly_allowance: requiredNonNegativeIntegerField(body, "monthly_allowance")
    });
    return jsonResponse(result);
  }

  const userCreditMatch = /^\/admin\/ui\/users\/([^/]+)\/credits\/(codex|grok|xai)$/.exec(url.pathname);
  if (userCreditMatch) {
    const userId = decodeURIComponent(userCreditMatch[1]);
    const surface = userCreditMatch[2] as CreditSurfaceId;
    const email = (await getUser(env, userId))?.email ?? null;
    const creditPolicyPage = (state: Pick<SurfaceCreditState, "mode" | "monthly_allowance" | "source">) => dashboardAfterMutation(env, url, admin, deps, requestContext, {
      kind: "credit_policy",
      user_id: userId,
      email,
      surface,
      mode: state.mode,
      monthly_allowance: state.monthly_allowance,
      source: state.source
    });
    const action = stringField(body, "action") ?? "set";
    if (action === "inherit") {
      requireConfirmation(body, "Credit removal");
      const removed = await removeSurfaceCreditPolicy(operator, { user_id: userId, surface });
      if (wantsHtml(request)) return creditPolicyPage(removed.state);
      return jsonResponse({ deleted: removed.deleted, state: publicCreditState(removed.state) });
    }
    requireConfirmation(body, "Credit change");
    const state = await setSurfaceCreditPolicy(operator, {
      user_id: userId,
      surface,
      ...creditPolicyField(body)
    });
    if (wantsHtml(request)) return creditPolicyPage(state);
    return jsonResponse({ kind: "surface_credit_state", state: publicCreditState(state) });
  }

  // Dashboard credentials: account creation, OAuth, and refresh only.
  if (url.pathname === "/admin/ui/codex-auths") {
    const auth = await createCodexCredentialAccount(operator, { label: requiredTrimmedString(body, "label") });
    if (wantsHtml(request)) {
      return dashboardAfterMutation(env, url, admin, deps, requestContext, {
        kind: "codex_created",
        auth_id: auth.id
      }, 200, undefined, ...mutationReturn(body));
    }
    return jsonResponse({ auth: publicCodexAuth(auth) }, { status: 201 });
  }

  if (url.pathname === "/admin/ui/subscriptions") {
    const account = await createGrokSubscription(operator, {
      capability_source: requiredTrimmedString(body, "capability_source") as CapabilitySource,
      environment: requiredTrimmedString(body, "environment") as SubscriptionEnvironment,
      label: requiredTrimmedString(body, "label"),
      provider_account_ref: null
    });
    if (wantsHtml(request)) {
      return dashboardAfterMutation(env, url, admin, deps, requestContext, {
        kind: "grok_created",
        account_id: account.id
      }, 200, undefined, ...mutationReturn(body));
    }
    return jsonResponse({ account: publicSubscriptionAccount(account) }, { status: 201 });
  }

  const codexUiMatch = /^\/admin\/ui\/codex-auths\/([^/]+)\/(oauth\/start|oauth\/complete|refresh|logout|pause|resume)$/.exec(url.pathname);
  if (codexUiMatch?.[2] === "pause" || codexUiMatch?.[2] === "resume") {
    const authId = decodeURIComponent(codexUiMatch[1]);
    const state = codexUiMatch[2] === "pause" ? "paused" : "enabled";
    requireConfirmation(body, state === "paused" ? "Pause" : "Resume");
    const auth = await setCodexAdmission(operator, authId, state);
    if (wantsHtml(request)) {
      return dashboardAfterMutation(env, url, admin, deps, requestContext, {
        kind: "codex_admission", auth_id: auth.id, admission_state: auth.admission_state
      }, 200, undefined, ...mutationReturn(body));
    }
    return jsonResponse({ auth: publicCodexAuth(auth) }, { headers: { "Cache-Control": "no-store" } });
  }

  if (codexUiMatch?.[2] === "oauth/start") {
    const authId = decodeURIComponent(codexUiMatch[1]);
    const result = await beginCodexCredentialOAuth(operator, authId, nullableStringField(body, "redirect_uri"));
    if (wantsHtml(request)) {
      return dashboardAfterMutation(env, url, admin, deps, requestContext, {
        kind: "codex_oauth_started",
        auth_id: authId,
        session_id: result.session_id,
        authorize_url: result.authorize_url,
        redirect_uri: result.redirect_uri
      }, 200, undefined, ...mutationReturn(body));
    }
    return jsonResponse(result);
  }

  if (codexUiMatch?.[2] === "oauth/complete") {
    const authId = decodeURIComponent(codexUiMatch[1]);
    requireConfirmation(body, "OAuth complete");
    const result = await completeCodexCredentialOAuth(operator, {
      session_id: nullableStringField(body, "session_id"),
      state: nullableStringField(body, "state"),
      code: nullableStringField(body, "code"),
      callback_url: nullableStringField(body, "callback_url") ?? stringField(body, "callback") ?? null
    }, authId);
    if (wantsHtml(request)) {
      return dashboardAfterMutation(env, url, admin, deps, requestContext, {
        kind: "codex_imported",
        auth_id: result.auth_id
      }, 200, undefined, ...mutationReturn(body));
    }
    return jsonResponse(result, { status: 201 });
  }

  if (codexUiMatch?.[2] === "refresh") {
    const authId = decodeURIComponent(codexUiMatch[1]);
    requireConfirmation(body, "Refresh");
    let result: Awaited<ReturnType<typeof refreshCodexCredential>>;
    try {
      result = await refreshCodexCredential(operator, authId);
    } catch (error) {
      if (!wantsHtml(request) || !(error instanceof HttpError) || ![
        "reauth_required", "missing_refresh_token", "codex_token_refresh_failed",
        "invalid_token_response", "missing_access_token", "codex_auth_inactive", "credential_lifecycle_changed"
      ].includes(error.code ?? "")) throw error;
      return dashboardAfterMutation(env, url, admin, deps, requestContext, {
        kind: "codex_refresh_error", auth_id: authId, message: consoleErrorMessage(error.code ?? null)
      }, error.status, undefined, ...mutationReturn(body));
    }
    if (wantsHtml(request)) {
      return dashboardAfterMutation(env, url, admin, deps, requestContext, {
        kind: "codex_refreshed",
        auth_id: result.auth_id
      }, 200, undefined, ...mutationReturn(body));
    }
    return jsonResponse(result);
  }

  if (codexUiMatch?.[2] === "logout") {
    const authId = decodeURIComponent(codexUiMatch[1]);
    requireConfirmation(body, "Logout");
    let result: Awaited<ReturnType<typeof logoutCodexCredential>>;
    try { result = await logoutCodexCredential(operator, authId); }
    catch(error) {
      if (error instanceof HttpError && error.status === 403 && wantsHtml(request)) return consoleUnknownOutcome(`/admin?view=credentials&account=${encodeURIComponent(`codex:${authId}`)}`);
      throw error;
    }
    if (wantsHtml(request)) {
      return dashboardAfterMutation(env, url, admin, deps, requestContext, {
        kind: "credential_disconnected", provider:"codex", account_id:result.auth_id, token_cleanup:result.token_cleanup
      }, 200, undefined, ...mutationReturn(body));
    }
    return jsonResponse(result);
  }

  const grokOAuthStartMatch = /^\/admin\/ui\/subscriptions\/([^/]+)\/oauth\/start$/.exec(url.pathname);
  if (grokOAuthStartMatch) {
    const result = await beginGrokCredentialOAuth(
      operator,
      decodeURIComponent(grokOAuthStartMatch[1]),
      nullableStringField(body, "redirect_uri")
    );
    if (wantsHtml(request)) {
      return dashboardAfterMutation(env, url, admin, deps, requestContext, {
        kind: "grok_oauth_started",
        account_id: result.account_id,
        session_id: result.session_id,
        authorize_url: result.authorize_url,
        redirect_uri: result.redirect_uri
      }, 200, undefined, ...mutationReturn(body));
    }
    return jsonResponse(result);
  }

  const grokOAuthCompleteMatch = /^\/admin\/ui\/subscriptions\/([^/]+)\/oauth\/complete$/.exec(url.pathname);
  if (grokOAuthCompleteMatch) {
    requireConfirmation(body, "OAuth complete");
    const result = await completeGrokCredentialOAuth(
      operator,
      decodeURIComponent(grokOAuthCompleteMatch[1]),
      {
        session_id: nullableStringField(body, "session_id"),
        state: nullableStringField(body, "state"),
        code: nullableStringField(body, "code"),
        callback_url: nullableStringField(body, "callback_url") ?? stringField(body, "callback") ?? null
      }
    );
    if (wantsHtml(request)) {
      return dashboardAfterMutation(env, url, admin, deps, requestContext, {
        kind: "grok_imported",
        account_id: result.account_id
      }, 200, undefined, ...mutationReturn(body));
    }
    return jsonResponse(result, { status: 201 });
  }

  const grokRefreshMatch = /^\/admin\/ui\/subscriptions\/([^/]+)\/refresh$/.exec(url.pathname);
  if (grokRefreshMatch) {
    requireConfirmation(body, "Refresh");
    const result = await refreshGrokCredential(operator, decodeURIComponent(grokRefreshMatch[1]));
    if (wantsHtml(request)) {
      return dashboardAfterMutation(env, url, admin, deps, requestContext, {
        kind: "grok_refreshed",
        account_id: result.account_id
      }, 200, undefined, ...mutationReturn(body));
    }
    return jsonResponse(result);
  }

  const grokLogoutMatch = /^\/admin\/ui\/subscriptions\/([^/]+)\/logout$/.exec(url.pathname);
  if (grokLogoutMatch) {
    requireConfirmation(body, "Logout");
    const accountId = decodeURIComponent(grokLogoutMatch[1]!);
    if (!wantsHtml(request)) return jsonResponse(await logoutGrokCredential(operator, accountId));
    const account = await getSubscriptionAccount(env, accountId);
    if (account) assertGrokCapability(account);
    let result: Awaited<ReturnType<typeof disconnectCredential>>;
    try { result = await disconnectCredential(env,credentialActor(operator),{kind:"grok",account_id:accountId},() => env.TOKEN_AUTHORITY.get(env.TOKEN_AUTHORITY.idFromName(`subscription:${accountId}`)).revokeSubscription(),operator.now); }
    catch(error) {
      if (error instanceof HttpError && error.status === 403 && wantsHtml(request)) return consoleUnknownOutcome(`/admin?view=credentials&account=${encodeURIComponent(`grok:${accountId}`)}`);
      throw error;
    }
    return dashboardAfterMutation(env, url, admin, deps, requestContext, {
      kind: "credential_disconnected", provider:"grok", account_id:accountId, token_cleanup:result.token_cleanup
    }, 200, undefined, ...mutationReturn(body));
  }

  throw new HttpError(404, "Admin UI route not found", "invalid_request_error", "not_found");
}

async function dashboardAfterMutation(
  env: Env,
  url: URL,
  admin: AdminIdentity,
  deps: AppDependencies,
  requestContext: RequestContext,
  flash: DashboardMutationFlash,
  status = 200,
  keyReturn?: string,
  accountSearch?: string,
  accountPage?: string
): Promise<Response> {
  const view = flash.kind.startsWith("runtime_")?"runtime":flash.kind.startsWith("grok") || flash.kind.startsWith("codex") || flash.kind.startsWith("credential_") && flash.kind !== "credential_binding"
    ? "credentials"
    : flash.kind === "key_created" || flash.kind === "key_replacement_created"
      ? "setup"
      : flash.kind === "credit_default" || flash.kind === "credit_default_error" ? "quotas" : "access";
  const pageUrl = new URL(url.origin);
  pageUrl.pathname = "/admin";
  pageUrl.searchParams.set("view", view);
  if("installation_id" in flash)pageUrl.searchParams.set("installation",flash.installation_id);
  if (view === "credentials") {
    const account = dashboardAccountForMutation(flash);
    if (account) pageUrl.searchParams.set("account", account);
    if (accountSearch && accountSearch.length <= 256 && !/[\u0000-\u001f\u007f]/.test(accountSearch)) pageUrl.searchParams.set("q", accountSearch.trim());
    if (account && accountPage && isDashboardPageToken(accountPage)) pageUrl.searchParams.set("page", accountPage);
  }
  if (view === "access") {
    const person = "user_id" in flash ? flash.user_id : url.searchParams.get("person");
    if (person) pageUrl.searchParams.set("person", person);
    if (flash.kind === "user_create_error") pageUrl.searchParams.set("task", "add-person");
    if (flash.kind === "service_error" && flash.action === "create") pageUrl.searchParams.set("task", "add-service");
    if (["user_status", "user_role", "user_email", "user_lifecycle_error", "service_changed", "service_owner_changed", "service_error"].includes(flash.kind) && "user_id" in flash && flash.user_id) {
      const destination = dashboardPersonReturnUrl(keyReturn, url, flash.user_id, new Date(requestContext.startedAt));
      if (destination) { pageUrl.pathname = destination.pathname; pageUrl.search = destination.search; }
    }
    if (flash.kind === "key_replacement_error") {
      const action = new URL(url);
      action.searchParams.set("person", flash.user_id);
      const destination = dashboardKeyReturnUrl(keyReturn ?? null, action, flash.key_id, new Date(requestContext.startedAt))
        ?? dashboardKeyReturnUrl(keyReturn ?? null, action, flash.key_id, new Date(requestContext.startedAt), "setup");
      if (destination) pageUrl.search = destination.search;
      else pageUrl.searchParams.set("key", flash.key_id);
    }
    if (flash.kind === "credential_binding" || flash.kind === "key_revoked") {
      const destination = dashboardKeyReturnUrl(keyReturn ?? null, url, flash.key_id, new Date(requestContext.startedAt));
      if (destination) pageUrl.search = destination.search;
    }
  }
  if (flash.kind === "key_replacement_created") {
    const action = new URL(url);
    action.searchParams.set("person", flash.user_id);
    const destination = dashboardKeyReturnUrl(keyReturn ?? null, action, flash.previous_key_id, new Date(requestContext.startedAt));
    const setupDestination = destination ? null : dashboardKeyReturnUrl(keyReturn ?? null, action, flash.previous_key_id, new Date(requestContext.startedAt), "setup");
    if (setupDestination) {
      for (const field of ["q", "page"]) {
        const value = setupDestination.searchParams.get(field);
        if (value) pageUrl.searchParams.set(field, value);
      }
    }
    const previous = destination ?? new URL(`/admin?view=access&person=${encodeURIComponent(flash.user_id)}&key=${encodeURIComponent(flash.previous_key_id)}`, url);
    previous.pathname = "/admin";
    flash = { ...flash, previous_key_url: `${previous.pathname}${previous.search}` };
    previous.searchParams.delete("key");
    previous.hash = "keys";
    flash = { ...flash, return_url: `${previous.pathname}${previous.search}${previous.hash}` };
  }
  if (flash.kind === "key_created" || flash.kind === "key_replacement_created") {
    pageUrl.searchParams.set("person", flash.user_id);
    pageUrl.searchParams.set("key", flash.key_id);
  }
  const response = await adminDashboardResponse({
    env,
    url: pageUrl,
    identity: admin,
    now: new Date(requestContext.startedAt),
    requestId: requestContext.requestId,
    mutationFlash: flash,
    loadCodexAccount: async (authId) => {
      // Rendering a known refresh failure must not retry the provider operation.
      if (flash.kind === "codex_refresh_error" || flash.kind === "codex_admission") return unavailableCodexAccountSnapshot();
      try {
        const freshToken = readTokenResult(await codexTokenAuthority(env, authId).getFreshAccessToken());
        return await readCodexAccountSnapshot(env, deps, freshToken);
      } catch {
        return unavailableCodexAccountSnapshot();
      }
    }
  });
  return status === 200 ? response : new Response(response.body, { status, headers: response.headers });
}

async function readDashboardBody(request: Request): Promise<JsonObject> {
  const contentType = request.headers.get("Content-Type") ?? "";
  if (contentType.includes("application/x-www-form-urlencoded")) {
    const text = await request.text();
    const params = new URLSearchParams(text);
    const body: JsonObject = {};
    for (const [key, value] of params.entries()) {
      if (key === "scopes" || key === "clients" || key.endsWith("[]")) {
        const norm = key.replace(/\[\]$/, "");
        const existing = body[norm];
        if (Array.isArray(existing)) {
          existing.push(value);
        } else if (typeof existing === "string") {
          body[norm] = [existing, value];
        } else {
          body[norm] = [value];
        }
      } else {
        body[key] = value;
      }
    }
    return body;
  }
  return readJsonObject(request);
}

function formProductScopes(body: JsonObject): string[] {
  const raw = body.clients;
  const clientIds = Array.isArray(raw)
    ? raw.map(String)
    : typeof raw === "string" && raw.trim()
      ? [raw.trim()]
      : [];
  return clientIds.map((clientId) => {
    const access = PRODUCT_ACCESS[clientId as keyof typeof PRODUCT_ACCESS];
    if (!access) {
      throw new HttpError(400, "Unknown client", "invalid_request_error", "invalid_clients");
    }
    return access.grant;
  });
}

function formCredentialBindings(body: JsonObject, scopes: readonly string[]): SurfaceCredentialSelection[] {
  return scopes.map((scope) => {
    const surface = /^surface:(codex|grok|xai):production$/.exec(scope)?.[1];
    if (!surface) {
      throw new HttpError(400, "Unknown Surface Grant", "invalid_request_error", "invalid_surface_grant");
    }
    return {
      surface_grant: scope as SurfaceCredentialSelection["surface_grant"],
      credential_account_id: requiredTrimmedString(body, `${surface}_credential_account_id`)
    } as SurfaceCredentialSelection;
  });
}

function isConfirmed(body: JsonObject): boolean {
  return isConfirmValue(body.confirm);
}

function requireConfirmation(body: JsonObject, action: string): void {
  if (!isConfirmed(body)) {
    throw new HttpError(400, `${action} requires confirm=1`, "invalid_request_error", "confirm_required");
  }
}

function operatorMutationContext(
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

function assertHtmlMutationError(error: unknown, request: Request, statuses: readonly number[]): asserts error is HttpError {
  if (!(error instanceof HttpError) || !statuses.includes(error.status) || !wantsHtml(request)) throw error;
}

function wantsHtml(request: Request): boolean {
  const accept = request.headers.get("Accept") ?? "";
  const contentType = request.headers.get("Content-Type") ?? "";
  if (contentType.includes("application/json")) {
    return false;
  }
  if (accept.includes("application/json") && !accept.includes("text/html")) {
    return false;
  }
  return contentType.includes("application/x-www-form-urlencoded") || accept.includes("text/html");
}

function isAdminDashboardPage(url: URL, env: Env): boolean {
  return url.pathname === "/admin"
    || url.pathname === "/admin/"
    || (url.pathname === "/" && url.hostname === env.ADMIN_DASHBOARD_HOST);
}

async function routeAdminUsage(env: Env, url: URL): Promise<Response> {
  if (!hasQueryParams(url)) {
    return jsonResponse(usageQueryGuide(), { headers: { "Cache-Control": "no-store" } });
  }

  const parsed = parseUsageQuery(url);
  try {
    const query = {
      mode: parsed.mode,
      day: parsed.filters.day,
      from: parsed.filters.from,
      to: parsed.filters.to,
      user_id: parsed.filters.user_id,
      route_profile_id: parsed.filters.route_profile_id,
      q: parsed.filters.q,
      limit: parsed.filters.limit
    };
    const [summary, media] = await Promise.all([queryUsageSummary(env, {
      ...query,
      response_model: parsed.filters.response_model,
    }), queryMediaUsageSummary(env, query)]);
    return jsonResponse({
      kind: "usage_summary",
      source: ["usage_daily", "media_usage_daily"],
      timezone: "UTC",
      granularity: "user_plan_model",
      filters: parsed.filters,
      totals: summary.totals,
      rows: summary.rows,
      media_totals: media.totals,
      media_rows: media.rows
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (isUsageSchemaUnavailableError(error)) {
      throw new HttpError(503, "Usage summary schema is unavailable", "server_error", "usage_schema_unavailable");
    }
    throw error;
  }
}

async function routeAdminRequestState(env: Env): Promise<Response> {
  const routes = await queryRequestAttemptState(env);
  return jsonResponse({
    kind: "system_request_attempt_state",
    source: "request_audit",
    timezone: "UTC",
    routes
  }, { headers: { "Cache-Control": "no-store" } });
}

async function routeAdminReadiness(env: Env, deps: AppDependencies): Promise<Response> {
  const generatedAt = deps.now().toISOString();
  let database: "available" | "unavailable" = "unavailable";
  try {
    await env.DB.prepare("SELECT 1 AS ok").first();
    database = "available";
  } catch {
    database = "unavailable";
  }

  let tokenAuthority: "available" | "unavailable" = "unavailable";
  try {
    if (env.TOKEN_AUTHORITY) {
      tokenAuthority = "available";
    }
  } catch {
    tokenAuthority = "unavailable";
  }

  const codexAuths = database === "available" ? await listCodexAuths(env).catch(() => []) : [];
  let egressConfigured: "configured" | "invalid" | "missing" = "missing";
  try {
    assertCodexEgressBaseUrl(env.CODEX_EGRESS_BASE_URL);
    egressConfigured = env.CODEX_EGRESS_SECRET ? "configured" : "missing";
  } catch {
    egressConfigured = env.CODEX_EGRESS_BASE_URL?.trim() ? "invalid" : "missing";
  }

  const attempts = database === "available"
    ? await queryRequestAttemptState(env).catch(() => [])
    : [];

  const subscriptionAccounts = database === "available"
    ? await listSubscriptionAccounts(env).catch(() => [])
    : [];

  const routes = listExecutionPlans().map((plan) => {
    const attempt = attempts.find((row) => row.route_profile_id === plan.id);
    let credential: "configured" | "missing" | "active" | "reauth_required" | "pending_credential" | "degraded" | "unknown" = "unknown";
    let accountLastSuccess: string | null = null;
    let accountLastFailure: string | null = null;
    const subscription_kind = subscriptionKindForPlan(plan);
    if (isChatgptProductionSlot(plan.credentialSlot)) {
      // Official ChatGPT: production Credential Account metadata only.
      const row = codexAuths.find((candidate) => candidate.status === "active") ?? codexAuths[0] ?? null;
      credential = row
        ? (row.status === "active" ? "active" : row.status === "reauth_required" ? "reauth_required" : "configured")
        : "missing";
    } else {
      const account = subscriptionAccounts.find(
        (row) => row.capability_source === "grok" && row.environment === plan.environment
      );
      if (!account) {
        credential = "missing";
      } else if (account.status === "active") {
        credential = "active";
      } else if (account.status === "reauth_required") {
        credential = "reauth_required";
      } else if (account.status === "pending_credential") {
        credential = "pending_credential";
      } else if (account.status === "degraded") {
        credential = "degraded";
      } else {
        credential = "configured";
      }
      accountLastSuccess = account?.last_success_at ?? null;
      accountLastFailure = account?.last_failure_at ?? null;
    }
    return {
      plan_id: plan.id,
      route_profile_id: plan.id,
      hostname: plan.hostname,
      environment: plan.environment,
      credential_slot: plan.credentialSlot,
      subscription_kind,
      credential_status: credential,
      credential,
      last_success_at: accountLastSuccess ?? attempt?.last_success_at ?? null,
      last_failure_at: accountLastFailure ?? attempt?.last_failure_at ?? null,
      request_count: attempt?.request_count ?? 0,
      ok_count: attempt?.ok_count ?? 0,
      error_count: attempt?.error_count ?? 0
    };
  });

  return jsonResponse({
    kind: "readiness",
    generated_at: generatedAt,
    liveness_path: "/healthz",
    database,
    token_authority_binding: tokenAuthority,
    codex_auth: {
      status: codexAuths.some((auth) => auth.status === "active") ? "active" : codexAuths[0]?.status ?? "unconfigured",
      account_count: codexAuths.length,
      expires_at: codexAuths.find((auth) => auth.status === "active")?.expires_at ?? null,
      refresh_available_metadata: codexAuths.some((auth) => Boolean(auth.last_refresh_at))
    },
    official_chatgpt: {
      production: {
        status: codexAuths.some((auth) => auth.status === "active") ? "active" : codexAuths[0]?.status ?? "unconfigured",
        account_count: codexAuths.length,
        expires_at: codexAuths.find((auth) => auth.status === "active")?.expires_at ?? null
      }
    },
    codex_egress: egressConfigured,
    production_ready: database === "available"
      && tokenAuthority === "available"
      && egressConfigured === "configured",
    routes,
    note: "Readiness does not perform live provider probes. A 429 or reachability probe alone is not production_ready. Authorization accepts surface:* grants only."
  }, { headers: { "Cache-Control": "no-store" } });
}

function usageQueryGuide() {
  return {
    kind: "usage_query_guide",
    source: ["usage_daily", "media_usage_daily"],
    timezone: "UTC",
    granularity: "user_plan_model",
    query_required: true,
    query_modes: [
      "/admin/usage?scope=all&limit=100",
      "/admin/usage?day=2026-07-07&limit=100",
      "/admin/usage?from=2026-07-01&to=2026-07-07&limit=100"
    ],
    params: {
      scope: ["all"],
      day: "YYYY-MM-DD",
      from: "YYYY-MM-DD",
      to: "YYYY-MM-DD",
      user_id: "optional string",
      route_profile_id: "optional exact execution plan id",
      response_model: "optional string",
      q: "optional literal person or Responses model search, at most 256 characters",
      limit: "required integer, 1..1000"
    },
    row_schema: [
      "first_day",
      "last_day",
      "user_id",
      "email",
      "route_profile_id",
      "response_model",
      "requests",
      "ok_requests",
      "error_requests",
      "input_tokens",
      "cached_input_tokens",
      "output_tokens",
      "reasoning_tokens",
      "total_tokens",
      "token_measurements",
      "provider_cost_usd_ticks",
      "cost_measurements",
      "last_seen_at"
    ],
    media_row_schema: [
      "first_day", "last_day", "user_id", "email", "route_profile_id", "capability",
      "started_jobs", "completed_jobs", "failed_jobs", "expired_jobs", "outputs",
      "video_seconds", "output_measurements", "duration_measurements",
      "provider_cost_usd_ticks", "cost_measurements", "last_seen_at"
    ],
    notes: [
      "数据查询必须指定查询方式。",
      `显式 from/to 区间最多 ${MAX_USAGE_RANGE_DAYS} 个 UTC 日（含首尾）；更长历史可显式使用 scope=all 或拆分区间。`,
      "模型响应记录按人员、路由和 response_model 分组。",
      "媒体记录按人员、路由和 capability 分组。",
      "response_model 只过滤模型响应记录。媒体记录使用其余适用的过滤条件。",
      "total_tokens 已经是合计。",
      "cached_input_tokens 是 input_tokens 的一部分。",
      "测量次数为 0 时，数值 0 表示未知，不是观察到的 0。",
      "服务商费用是服务商计划中的暂定计量，不是已结算的收费或发票。"
    ]
  };
}



async function runRequestAuditCleanup(env: Env, deps: AppDependencies): Promise<RequestAuditCleanupResult> {
  const retentionDays = requestAuditRetentionDays(env.REQUEST_AUDIT_RETENTION_DAYS);
  const cutoff = new Date(deps.now().getTime() - retentionDays * DAY_MS).toISOString();
  const deleted = await cleanupRequestAudit(env, cutoff);
  return {
    deleted,
    retention_days: retentionDays,
    cutoff
  };
}

/** OAuth start accepts an empty or invalid body. Other admin JSON routes do not. */
async function optionalOAuthStartBody(request: Request): Promise<JsonObject> {
  try {
    return await readJsonObject(request);
  } catch {
    return {};
  }
}

async function readJsonObject(request: Request): Promise<JsonObject> {
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

function publicCodexAuth(row: CodexAuthRow | null) {
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

function stringField(body: JsonObject, field: string): string | undefined {
  return firstString(body[field]) || undefined;
}

function mutationReturn(body: JsonObject): [string | undefined, string | undefined] {
  return [stringField(body, "return_q"), stringField(body, "return_page")];
}

function dashboardKeyExpiry(body: JsonObject): string | null | undefined {
  if (!("expires_at_utc" in body)) return nullableStringField(body, "expires_at");
  if ("expires_at" in body) {
    throw new HttpError(400, "Provide only one expiry date and time.", "invalid_request_error", "ambiguous_expiry");
  }
  const invalid = () => new HttpError(400, "Choose a valid expiry date and time in UTC.", "invalid_request_error", "invalid_expires_at_utc");
  if (typeof body.expires_at_utc !== "string") throw invalid();
  const value = body.expires_at_utc.trim();
  if (!value) return null;
  const parts = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/.exec(value);
  if (!parts || value.startsWith("0000-")) throw invalid();
  const iso = `${parts[1]}:${parts[2] ?? "00"}.${(parts[3] ?? "").padEnd(3, "0")}Z`;
  const instant = new Date(iso);
  if (!Number.isFinite(instant.getTime()) || instant.toISOString() !== iso) throw invalid();
  return iso;
}

function nullableStringField(body: JsonObject, field: string): string | null | undefined {
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

function creditPolicyField(body: JsonObject): { mode: "limited" | "unlimited" | "disabled"; monthly_allowance: number | null } {
  const mode = body.mode;
  if (mode === "unlimited" || mode === "disabled") {
    return { mode, monthly_allowance: null };
  }
  if (mode !== undefined && mode !== "limited") {
    throw new HttpError(400, "Credit policy mode must be limited, unlimited, or disabled.", "invalid_request_error", "invalid_credit_policy");
  }
  return { mode: "limited", monthly_allowance: requiredNonNegativeIntegerField(body, "monthly_allowance") };
}

function requiredNonNegativeIntegerField(body: JsonObject, field: string): number {
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

function stringArrayField(body: JsonObject, field: string): string[] | undefined {
  const value = body[field];
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) {
    throw new HttpError(400, `${field} must be an array of strings`, "invalid_request_error", `invalid_${field}`);
  }
  return value.map((item) => item.trim());
}

function credentialBindingsField(body: JsonObject): SurfaceCredentialSelection[] {
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

function hasQueryParams(url: URL): boolean {
  return Array.from(url.searchParams.keys()).length > 0;
}

function isUsageSchemaUnavailableError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /usage_daily|users/i.test(message) && /no such table|no such column|SQLITE_ERROR|D1_ERROR/i.test(message);
}

function codexTokenAuthority(env: Env, authId: string) {
  return env.TOKEN_AUTHORITY.get(env.TOKEN_AUTHORITY.idFromName(authId));
}
