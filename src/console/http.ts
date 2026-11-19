import { formProductScopes } from "./mutations";
import { wantsHtml, isAdminDashboardPage, isOwnConsolePath } from "./request";
import { type JsonObject, nullableStringField } from "../control/input";
import { invalidRuntimeOperation } from "../runtime/installations";
import { revokeRuntimeClient } from "../runtime/console";
import { runtimeMemberHref } from "./runtime-location";
import { delegatedService, listDelegatedServices, type ServiceContext } from "../auth/service-delegation";
import { assertKeyActorAuthority } from "../auth/key-authority";
import { consoleLoginHref, consoleReturnTarget } from "./return-target";
import { memberHref } from "./member-href";
import { requireOperator, verifyConsoleAccess, type AdminIdentity } from "../auth/authenticate";
import { clearConsoleSessionCookie } from "../auth/console-session";
import { consoleError } from "./ui/messages";
import { type ConsolePrincipal } from "../auth/principal";
import { issueMemberKey, listMemberKeys, renameMemberKey, replaceMemberKey, revokeAllMemberKeys, revokeMemberKey, type PublicApiKey } from "../auth/api-keys";
import { memberConsoleResponse, memberSecretPage, memberUsageResponse, memberMutationPage } from "./member-console";
import { serviceAvailabilityResponse } from "../control/credential-control";
import { consoleLifecycleOutcome, consoleUnknownOutcome } from "./dashboard";
import { consoleClientResponse, dashboardAppResponse, isDashboardAppPath } from "./app";
import { getApiKeyById } from "../auth/access-store";
import { assertConsoleBrowserWrite } from "./browser-write";
import { bytesToHex } from "../crypto";
import { isRecord } from "../records";
import { HttpError, adminAuthRequired, adminRequired, adminRouteNotFound, invalidConsoleReturn, jsonObjectRequired, jsonResponse } from "../errors";
import { CODEX_API_HOSTNAME } from "../plans/execution-plans";
import { type RequestContext } from "../types";
import { listSurfaceCreditStates } from "../auth/credits";

export async function authorizeConsole(
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
      return memberConsoleResponse({request,env,url:new URL(runtimeMemberHref(installation,"clients"),url),principal,now:currentTime(),requestId:requestContext.requestId,runtimeRevoked:true});
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
        ...consoleError(error.code), attemptedName: typeof body.name === "string" ? body.name : undefined });
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
  return memberMutationPage({principal,service,requestId,keyId,message:"这次提交之前已经完成，不会再次创建或显示密钥。请查看当前密钥状态。"});
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

function memberKeyActionReturn(pathname: string): string | undefined {
  const action = /^\/me(?:\/service-accounts\/([^/]+))?\/ui\/keys(?:\/([^/]+)\/(?:rename|revoke|replace)|\/revoke-all)?$/.exec(pathname);
  if (!action) return undefined;
  try {
    return memberHref("keys", action[2] ? decodeURIComponent(action[2]) : undefined, action[1] ? decodeURIComponent(action[1]) : undefined);
  } catch { return undefined; }
}

export function consoleAuthorityChanged(): HttpError {
  return new HttpError(403, "Console authority changed", "authentication_error", "console_identity_changed");
}

export async function assertUnchangedReadAuthority(request: Request, env: Env, id: string | null | undefined, email: string | null | undefined, role: string, epoch: number | undefined, now: Date): Promise<void> {
  const current = await verifyConsoleAccess(request, env, now);
  if (!current || current.id !== id || current.email !== email || current.role !== role || current.sessionEpoch !== epoch) {
    throw consoleAuthorityChanged();
  }
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
