import { parseUsageQuery, parseUsageTrendRange, type UsageTrendRange } from "./usage-query";
import { ReadError } from "./ui/read-error";
import { createElement, type ReactNode } from "react";
import { consoleDocument } from "./console-shell";
import { type PublicApiKey } from "../auth/api-keys";
import { listSurfaceCreditStates } from "../auth/credits";
import { readMemberAccess, type ReadFact } from "./member-access";
import { MemberScope } from "./member-scope";
import { delegatedService, listDelegatedServices, type ServiceContext } from "../auth/service-delegation";
import { memberHref } from "./member-href";
import { consoleReturnTarget } from "./return-target";
import { buildClientSetupFiles, buildClientSetupTemplates, CLIENT_SETUP_TOKEN_PLACEHOLDER } from "./client-setup";
import { queryUsageDaily, queryMediaUsageSummary, queryUsageSummary } from "../db";
import { HttpError, jsonResponse } from "../errors";
import type { ConsolePrincipal } from "../auth/principal";
import { Icon, type IconName } from "./ui/icon";
import { SidebarGroup, SidebarGroupLabel, SidebarMenu, SidebarMenuButton, SidebarMenuItem } from "./ui/components/sidebar";
import { Badge } from "./ui/components/badge";
import { consoleDataRevision } from "./console-revision";
import {
  isMemberView,
  MEMBER_VIEWS,
  MemberHomePage,
  MemberDelegatedServices,
  MemberKeysPage,
  MemberQuotaPage,
  MemberSecretPage,
  MemberSetupPage,
  MemberUnavailablePage,
  MemberMissingPage,
  MemberUsagePage,
  type MemberView
} from "./ui/pages/member";

export async function memberConsoleResponse(input: {
  env: Env;
  url: URL;
  principal: ConsolePrincipal;
  service?: ServiceContext;
  now: Date;
  requestId: string;
}): Promise<Response> {
  const requested = input.url.searchParams.get("view") ?? "home";
  if (!isMemberView(requested)) {
    return html(404, input.requestId, createElement(MemberMissingPage), input.principal, "home", input.service);
  }
  const view = requested;
  let trend: UsageTrendRange | undefined;
  if (view === "usage") {
    try {
      if ([...input.url.searchParams.keys()].some(key => !["area", "view", "range", "user_id"].includes(key))) throw new Error("Unsupported usage page parameter");
      trend = parseUsageTrendRange(input.url, input.now);
    }
    catch { return html(400, input.requestId, createElement(ReadError, {title: "时间范围不正确", message: "请选择最近 7 天或 30 天。显式日期查询请使用此账号的用量 API。", retryUrl: memberHref("usage", undefined, input.service?.id), retryLabel: "打开最近 7 天", requestId: input.requestId}), input.principal, view, input.service); }
  }
  const readUrl = trend ? `${memberHref("usage", undefined, input.service?.id)}&range=${trend.key}` : memberHref(view, view === "keys" ? input.url.searchParams.get("key") ?? undefined : undefined, input.service?.id);
  try {
    const {body, data} = await renderView(input, view, trend);
    if (input.service) await delegatedService(input.env, input.principal, input.service.id);
    const revision = await consoleDataRevision({data, service: input.service, actor: {id: input.principal.id, email: input.principal.email, role: input.principal.role}});
    return html(200, input.requestId, body, input.principal, view, input.service, trend ? readUrl : undefined, {url: readUrl, revision});
  } catch (error) {
    if (error instanceof HttpError && error.status === 404) throw error;
    return html(503, input.requestId, createElement(MemberUnavailablePage, {retryUrl: consoleReturnTarget(readUrl) ?? "/"}), input.principal, view, input.service);
  }
}

export async function memberUsageResponse(input: {
  env: Env;
  url: URL;
  principal: ConsolePrincipal;
  service?: ServiceContext;
  now: Date;
}): Promise<Response> {
  // Parsing is outside the database failure handler. Foreign owner input is ignored,
  // while all date modes are still validated, never silently widened to all time.
  const parsed = parseUsageQuery(input.url, {defaultAll: true, defaultLimit: 100});
  const query = {mode: parsed.mode, ...parsed.filters, user_id: input.service?.id ?? input.principal.id};
  try {
    const [usage, media] = await Promise.all([
      queryUsageSummary(input.env, query),
      queryMediaUsageSummary(input.env, query)
    ]);
    if (input.service) await delegatedService(input.env, input.principal, input.service.id);
    return jsonResponse({
      scope: input.service ? "service" : "self",
      ...(input.service ? {service_id: input.service.id} : {}),
      billing: "provisional",
      usage,
      media
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof HttpError && error.status === 404) throw error;
    throw new HttpError(503, "Usage is unavailable.", "server_error", "usage_unavailable");
  }
}

export function memberSecretPage(input: {
  principal: ConsolePrincipal;
  service?: ServiceContext;
  token: string;
  key: PublicApiKey;
  requestId: string;
  previousPrefix?: string;
  oldKeyRemainsActive?: boolean;
}): Response {
  const files = buildClientSetupFiles({ token: input.token, scopes: input.key.scopes });
  const body = createElement(MemberSecretPage, {
    token: input.token,
    files,
    previousPrefix: input.previousPrefix ?? null,
    oldKeyRemainsActive: input.oldKeyRemainsActive,
    keyId: input.key.id,
    keyPrefix: input.key.key_prefix
  });
  return html(200, input.requestId, body, input.principal, "keys", input.service);
}

async function renderView(input: {
  env: Env;
  url: URL;
  principal: ConsolePrincipal;
  service?: ServiceContext;
  now: Date;
}, view: MemberView, trend?: UsageTrendRange): Promise<{body: ReactNode; data: unknown}> {
  if (view === "quota") {
    let states: ReadFact<Awaited<ReturnType<typeof listSurfaceCreditStates>>>;
    try { states = { known: true, value: await listSurfaceCreditStates(input.env, input.now, input.service?.id ?? input.principal.id) }; }
    catch { states = { known: false }; }
    return {body: createElement(MemberQuotaPage, { states }), data: states};
  }
  if (view === "setup") return {body: createElement(MemberSetupPage), data: null};
  if (view === "home" || view === "keys") {
    const model = await readMemberAccess(input.env, input.service?.id ?? input.principal.id, input.now);
    const selectedId = input.url.searchParams.get("key");
    if (view === "home") {
      let services: ServiceContext[] | null = [];
      if (!input.service) {
        try { services = await listDelegatedServices(input.env, input.principal); }
        catch { services = null; }
      }
      return {body: createElement("div", null, createElement(MemberHomePage, { model }), !input.service && (services === null || services.length > 0) ? createElement(MemberDelegatedServices,{services}) : null), data: {model, services}};
    }
    return {body: createElement(MemberKeysPage, { model, now: input.now, selectedId }), data: model};
  }
  if (view === "usage") {
    const range = trend!;
    const query = {mode: "range", from: range.from, to: range.to, user_id: input.service?.id ?? input.principal.id, limit: 101} as const;
    const [usage, media, daily] = await Promise.all([queryUsageSummary(input.env, query), queryMediaUsageSummary(input.env, query), queryUsageDaily(input.env, query)]);
    const model = {
      trends: {range, daily, scopeLabel: input.service ? `${input.service.display_name} · 用量` : "我的用量", navigationUrl: `${memberHref("usage", undefined, input.service?.id)}&range=${range.key}`},
      rows: usage.rows.slice(0, 100), mediaRows: media.rows.slice(0, 100),
      rowsTruncated: usage.rows.length > 100, mediaRowsTruncated: media.rows.length > 100,
      range: {emptyLabel: "这个范围没有用量记录。", rawUsageUrl: `${input.service ? `/me/service-accounts/${encodeURIComponent(input.service.id)}/usage` : "/me/usage"}?from=${range.from}&to=${range.to}`},
      filterPlaceholder: "搜索模型",
      limitNote: "请求和媒体记录分别显示最多 100 条，导出文件使用相同上限。"
    };
    return {body: createElement(MemberUsagePage, {model}), data: model};
  }
  return {body: createElement(MemberMissingPage), data: null};
}

function html(status: number, requestId: string, body: ReactNode, principal: ConsolePrincipal, view: MemberView, service?: ServiceContext, navigationUrl?: string, read?: {url: string; revision: string}): Response {
  const nav = createElement(SidebarMenu, null, ...MEMBER_VIEWS.map(item =>
    createElement(SidebarMenuItem, {key:item},
      createElement(SidebarMenuButton, {asChild:true,isActive:item===view},
        createElement("a", {href:memberHref(item, undefined, service?.id), "aria-label":service ? label(item).replace("我的", "服务") : label(item), "aria-current":item===view ? "page" : undefined},
          createElement(Icon, {name:memberIcon(item)}),
          createElement("span", null, {home:"工作台",keys:"密钥",setup:"配置",usage:"用量",quota:"额度"}[item])
        )
      )
    )
  ));
  const document = consoleDocument({
    title: `${service ? service.display_name + " · " + label(view).replace("我的", "") : label(view)} · Agency Relay`,
    navigationUrl,
    readUrl: read?.url,
    dataRevision: read?.revision,
    view,
    email: principal.email,
    actorId: principal.id,
    nav: createElement("div", null, createElement(SidebarGroup, {className:"console-nav-group"}, createElement(SidebarGroupLabel, null, service ? `服务账号 · ${service.display_name}` : "我的空间"), nav), service ? createElement("div", {className:"nav-area-switch"}, createElement("a", {href:memberHref("home")}, "我的空间")) : null, principal.role === "admin" ? createElement("div", {className: "nav-area-switch"}, createElement("a", {href: "/admin"}, "组织管理")) : null),
    role: principal.role,
    current: `${service ? service.display_name : "我的空间"} · ${label(view).replace(service ? "我的" : "服务", "")}`,
    appEnabled: true,
    main: createElement(MemberScope.Provider, {value:service ?? null}, createElement("div", {"data-member-view": view, "data-service-id":service?.id, "data-service-status":service?.status}, service ? createElement("aside", {"aria-label":"当前服务账号",className:"member-scope-bar"}, createElement(Badge, null, "服务账号"), createElement("strong", null, service.display_name), createElement("code", {className:"caption"}, service.id), createElement("span", {className:"caption"}, "独立密钥与额度"), service.status !== "active" ? createElement("p", null, "已停用，不能发行或更换密钥；仍可撤销已有密钥。只有管理员能重新启用。") : null) : null, body, createElement("p", {hidden: true, "data-request-id": requestId}))),
    extra: createElement("script", {id: "console-setup-config", type: "application/json", dangerouslySetInnerHTML: {__html: JSON.stringify({templates: buildClientSetupTemplates(), placeholder: CLIENT_SETUP_TOKEN_PLACEHOLDER}).replaceAll("<", "\\u003c")}}),
    confirm: true
  });
  return new Response(document, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Request-Id": requestId
    }
  });
}

function memberIcon(view: MemberView): IconName {
  switch (view) {
    case "home": return "overview";
    case "keys": return "keys";
    case "usage": return "usage";
    case "quota": return "quotas";
    case "setup": return "setup";
  }
}

function label(view: MemberView): string {
  switch (view) {
    case "home": return "工作台";
    case "keys": return "我的密钥";
    case "usage": return "我的用量";
    case "quota": return "我的额度";
    case "setup": return "客户端配置";
  }
}

/** Acknowledged writes render without any optional list/quota/default reads. */
export function memberMutationPage(input: {
  principal: ConsolePrincipal;
  service?: ServiceContext; requestId: string; message: string;
  keyId?: string; status?: number; rejected?: boolean; attemptedName?: string;
}): Response {
  const href = memberHref("keys", input.keyId, input.service?.id);
  return html(input.status ?? 200, input.requestId, createElement("section", {
    "data-member-result": input.rejected ? "rejected" : "confirmed", "data-member-return": href,
    role: input.rejected ? "alert" : "status"
  }, createElement("h1", null, `${input.service ? input.service.display_name + " · " : ""}${input.rejected ? "操作未执行" : "操作已完成"}`),
  createElement("p", null, input.message), input.keyId ? createElement("p", null, "密钥对象：", createElement("code", null, input.keyId)) : null,
  input.attemptedName !== undefined ? createElement("p", null, "填写的名称：", input.attemptedName) : null,
  createElement("a", {href}, "查看当前密钥")), input.principal, "keys", input.service);
}
