import { authorizeConsole, consoleAuthorityChanged, assertUnchangedReadAuthority } from "../console/http";
import { routeDashboardUiMutation } from "../console/mutations";
import { isDashboardRoute, wantsHtml, isAdminDashboardPage } from "../console/request";
import { commitLifecycle, ownerInput, publicService, publicCreditState, optionalOAuthStartBody, readJsonObject, publicCodexAuth, stringField, nullableStringField, creditPolicyField, requiredNonNegativeIntegerField, stringArrayField, credentialBindingsField, requireConfirmation, operatorMutationContext, hasQueryParams, codexTokenAuthority } from "./input";
import { parseUsageQuery, MAX_USAGE_RANGE_DAYS } from "../console/usage-query";
import { runtimeControlResponse } from "../runtime/control";
import { readServiceOwner } from "../auth/service-delegation";
import { verifyConsoleAccess } from "../auth/authenticate";
import { routeConsoleLogin } from "../auth/feishu-login";
import { readTokenResult } from "../auth/token-result";
import { credentialStatusResponse, credentialEventsResponse } from "../console/credential-status";
import { credentialControlResponse } from "./credential-control";
import { adminDashboardResponse } from "../console/dashboard";
import { consoleClientPath, consoleVersionedClientResponse, consoleStylesheetPath, consoleStylesheetResponse } from "../console/app";
import { beginCodexCredentialOAuth, beginGrokCredentialOAuth, completeCodexCredentialOAuth, completeGrokCredentialOAuth, createCodexCredentialAccount, createGrokSubscription, createUser, createServiceAccount, assignServiceOwner, renameServiceAccount, classifyServiceAccount, importCodexCredential, importGrokCredential, issueApiKey, logoutCodexCredential, logoutGrokCredential, refreshCodexCredential, setCodexAdmission, refreshGrokCredential, removeSurfaceCreditPolicy, revokeApiKey, setSurfaceCreditPolicy, setApiKeyCredentialBinding, setOrganizationCreditDefault, testGrokCredential } from "./operator-mutations";
import { readCodexAccountSnapshot, unavailableCodexAccountSnapshot } from "../codex/account";
import { cleanupRequestAudit, requestAuditRetentionDays, queryMediaUsageSummary, queryRequestAttemptState, queryUsageSummary } from "../usage/queries";
import { getCodexAuth, listCodexAuths } from "../codex/credential-store";
import { getUser } from "../auth/access-store";
import { listApiKeySurfaceCredentials, type SurfaceCredentialSelection } from "../auth/bindings";
import { HttpError, adminRouteNotFound, codexAuthNotFound, jsonResponse, methodNotAllowed, requiredTrimmedString, serviceNotFound, subscriptionNotFound, userNotFound } from "../errors";
import { CODEX_API_HOSTNAME, EXECUTION_PLAN_SET_VERSION, isChatgptProductionSlot, listExecutionPlans } from "../plans/execution-plans";
import { codexEgressReadiness } from "../codex/egress-transport";
import { subscriptionKindForPlan } from "../plans/audit";
import { getSubscriptionAccount, listSubscriptionAccounts, publicSubscriptionAccount, type CapabilitySource, type SubscriptionEnvironment } from "../auth/subscription-accounts";
import { type AppDependencies, type RequestContext } from "../types";
import { listOrganizationCreditDefaults, listSurfaceCreditStates, type CreditSurfaceId } from "../auth/credits";

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
          return await readCodexAccountSnapshot(env, freshToken, request.signal);
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
  const egressConfigured = codexEgressReadiness(env);

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
      "模型响应记录按账号、路由和 response_model 分组。",
      "媒体记录按账号、路由和 capability 分组。",
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

function isUsageSchemaUnavailableError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /usage_daily|users/i.test(message) && /no such table|no such column|SQLITE_ERROR|D1_ERROR/i.test(message);
}
