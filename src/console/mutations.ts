import { wantsHtml } from "./request";
import { type JsonObject, ownerInput, publicService, publicCreditState, readJsonObject, publicCodexAuth, stringField, nullableStringField, creditPolicyField, requiredNonNegativeIntegerField, stringArrayField, requireConfirmation, operatorMutationContext, codexTokenAuthority } from "../control/input";
import { invalidRuntimeOperation } from "../runtime/installations";
import { readRuntimeForm, mutateRuntimeInstallation } from "../runtime/console";
import { isDashboardPageToken } from "./dashboard-page";
import { type AdminIdentity } from "../auth/authenticate";
import { readTokenResult } from "../auth/token-result";
import { clearConsoleSessionCookie } from "../auth/console-session";
import { consoleError } from "./ui/messages";
import { userRole, userStatus } from "../auth/principal";
import { commitCredentialDefault, credentialActor, migrateCredentialBindings, disconnectCredential, retryCredentialCleanup, type OrganizationSurface } from "../auth/credential-defaults";
import { adminDashboardResponse, dashboardAccountForMutation, dashboardKeyReturnUrl, dashboardPersonReturnUrl, consoleLifecycleOutcome, consoleUnknownOutcome } from "./dashboard";
import { type DashboardMutationFlash } from "./dashboard-data";
import { beginCodexCredentialOAuth, beginGrokCredentialOAuth, completeCodexCredentialOAuth, completeGrokCredentialOAuth, createCodexCredentialAccount, createGrokSubscription, createOrganizationUser, createServiceAccount, assignServiceOwner, renameServiceAccount, classifyServiceAccount, issueApiKey, issueReplacementApiKey, logoutCodexCredential, logoutGrokCredential, assertGrokCapability, refreshCodexCredential, setCodexAdmission, refreshGrokCredential, removeSurfaceCreditPolicy, revokeApiKey, setSurfaceCreditPolicy, setApiKeyCredentialBinding, setUserStatus, setUserRole, setOrganizationCreditDefault, setOrganizationCreditDefaults, changeUserEmail } from "../control/operator-mutations";
import { PRODUCT_ACCESS } from "./client-setup";
import { readCodexAccountSnapshot, unavailableCodexAccountSnapshot } from "../codex/account";
import { getUser, getApiKeyById } from "../auth/access-store";
import { type SurfaceCredentialSelection } from "../auth/bindings";
import { HttpError, adminAuthRequired, jsonResponse, methodNotAllowed, requiredTrimmedString } from "../errors";
import { getSubscriptionAccount, publicSubscriptionAccount, type CapabilitySource, type SubscriptionEnvironment } from "../auth/subscription-accounts";
import { type AppDependencies, type RequestContext } from "../types";
import { CREDIT_SURFACE_IDS, type CreditSurfaceId, type SurfaceCreditState } from "../auth/credits";

export async function routeDashboardUiMutation(
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
      status=error.status;flash={kind:"runtime_error",installation_id:runtime[1]!,error_code:error.code ?? "unknown",message:"这次操作未完成。页面权限、配置版本或输入已改变；请查看当前状态后重新打开表单。"};
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
      return dashboardAfterMutation(env,url,admin,deps,requestContext,{kind:"credential_task_error",provider,account_id:accountId,surface_grant:grant,...consoleError(error.code)},error.status,undefined,...mutationReturn(body));
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
        return consoleLifecycleOutcome({ rejected: true, href: "/login", label: "重新登录", message: "你的登录身份或管理员权限已改变，这次添加成员没有执行。请重新登录并查看当前状态。" });
      }
      assertHtmlMutationError(error, request, [400, 409]);
      return dashboardAfterMutation(env, url, admin, deps, requestContext, {
        kind: "user_create_error", email, ...consoleError(error.code)
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
      return dashboardAfterMutation(env,url,admin,deps,requestContext,{kind:"service_error",user_id:id,action:"owner",display_name:"",...consoleError(error.code)},error.status,stringField(body,"person_return"));
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
      return dashboardAfterMutation(env, url, admin, deps, requestContext, { kind: "service_error", user_id: id, action, display_name: displayName, ...consoleError(error.code) }, error.status, stringField(body, "person_return"));
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
      return dashboardAfterMutation(env, url, admin, deps, requestContext, {kind:"key_replacement_error", key_id:keyId, user_id:key.user_id, ...consoleError(error.code)}, error.status, stringField(body, "key_return"));
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
        kind: "user_lifecycle_error", user_id: userId, action, email: stringField(body, "email") ?? "", ...consoleError(error.code)
      }, error.status, returnUrl);
    }
    if (!wantsHtml(request)) return jsonResponse(result);
    if (userId === admin.userId && (action === "email" || (flash.kind === "user_status" && flash.status === "disabled"))) {
      return consoleLifecycleOutcome({ href: "/login", label: "重新登录", cookie: clearConsoleSessionCookie(),
        message: action === "email" ? "邮箱已迁移，旧控制台会话已失效。请使用新邮箱重新登录。密钥和历史不变，撤销或更换密钥需单独操作。" : "账号已停用，旧控制台会话已失效。请联系其他管理员恢复账号后重新登录。" });
    }
    if (userId === admin.userId && flash.kind === "user_role" && flash.role === "user") {
      return consoleLifecycleOutcome({ href: "/admin?view=keys", label: "打开我的密钥", message: "你现在是普通成员，组织管理权限已结束。个人密钥、额度和历史不变。" });
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
      return dashboardAfterMutation(env,url,admin,deps,requestContext,{kind:"credit_default_error",...consoleError(error.code)},error.status);
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
        kind: "codex_refresh_error", auth_id: authId, ...consoleError(error.code)
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

export function formProductScopes(body: JsonObject): string[] {
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

function assertHtmlMutationError(error: unknown, request: Request, statuses: readonly number[]): asserts error is HttpError {
  if (!(error instanceof HttpError) || !statuses.includes(error.status) || !wantsHtml(request)) throw error;
}
