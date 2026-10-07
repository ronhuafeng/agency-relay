import { parseUsageTrendRange, parseUsageQuery } from "./usage-query";
import { parseRequestHistoryQuery, REQUEST_HISTORY_FIELDS } from "./request-history";
import { DASHBOARD_PAGE_SIZE } from "./inventory";
import { DASHBOARD_PEOPLE_PAGE_SIZES } from "./ui/href";
import { createElement, Fragment } from "react";
import { DashboardContent, ReadUnavailable, renderDashboardDocument } from "./ui/dashboard-document";
import { MutationNotice } from "./ui/mutation-notice";
import { personInputMessage } from "./ui/messages";
import { loadDashboard, dashboardViewTitle, DASHBOARD_RANGE_DEFINITIONS, DASHBOARD_VIEW_DEFINITIONS, type DashboardViewKey, type DashboardMutationFlash, type AdminDashboardInput, type DashboardRange } from "./dashboard-data";
/**
 * Feishu-authenticated Agency Relay product console.
 * Product authority: docs/product/experience.md
 */
import { presentText } from "./format";



import { consoleDocument } from "./console-shell";
import { ReadError } from "./ui/read-error";
import { RecoveryPage } from "./ui/recovery-page";
import { consoleLoginHref, consoleReturnTarget } from "./return-target";
import { consoleDataRevision } from "./console-revision";



const DAY_MS = 24 * 60 * 60 * 1000;

class DashboardInputError extends Error {}

export function dashboardAccountForMutation(flash: DashboardMutationFlash | null | undefined): string | null {
  if (flash?.kind === "credential_default") return `${flash.surface_grant === "surface:codex:production" ? "codex" : "grok"}:${flash.account_id}`;
  if (flash && "provider" in flash && flash.provider && "account_id" in flash && flash.account_id) return `${flash.provider}:${flash.account_id}`;
  if (flash?.kind.startsWith("codex_") && "auth_id" in flash) return `codex:${flash.auth_id}`;
  if (flash?.kind.startsWith("grok_") && "account_id" in flash) return `grok:${flash.account_id}`;
  return null;
}

export async function adminDashboardResponse(input: AdminDashboardInput): Promise<Response> {
  const nonce = randomNonce();
  let range: DashboardRange;
  let view: DashboardViewKey;
  try {
    range = parseDashboardRange(input.url, input.now);
    view = parseDashboardView(input.url);
  } catch (error) {
    if (error instanceof DashboardInputError) {
      return renderErrorResponse({
        status: 400,
        title: "页面参数不正确",
        message: ["overview", "usage"].includes(input.url.searchParams.get("view") ?? "overview") ? "概览和用量页面请选择最近 7 天或 30 天，并检查筛选参数。其他日期可通过用量 API 查询。" : "请使用有效的页面。时间范围可以是今天、7 天、30 天或全部。",
        requestId: input.requestId,
        retryUrl: input.url.pathname,
        retryLabel: "打开默认页面",
        nonce
      });
    }
    throw error;
  }

  const dataAsOf = input.now.toISOString();
  const setupResult = view === "setup" && (input.mutationFlash?.kind === "key_created" || input.mutationFlash?.kind === "key_replacement_created") ? input.mutationFlash : null;
  const requestedPerson = ["access", "setup", "usage"].includes(view) ? input.url.searchParams.get("person") ?? setupResult?.user_id ?? null : null;
  const task = input.url.searchParams.get("task");
  const requestedKey = input.url.searchParams.get("key") ?? setupResult?.key_id ?? null;
  const requestedAccount = view === "credentials" ? input.url.searchParams.get("account") ?? dashboardAccountForMutation(input.mutationFlash) : null;
  const inventoryQuery = new URLSearchParams();
  for (const key of ["kind", "q", "page", "page_size", "key_q", "key_page", ...(view === "usage" ? ["plan", "model"] : []), ...REQUEST_HISTORY_FIELDS]) {
    const value = input.url.searchParams.get(key)?.trim();
    if (value) inventoryQuery.set(key, key === "kind" && value === "all" ? "human" : value);
  }
  const base = {
    appEnabled: input.url.hostname === input.env.ADMIN_DASHBOARD_HOST,
    canonicalUrl: `${input.url.pathname}?view=${view}&range=${range.key}${requestedPerson === null ? "" : `&person=${encodeURIComponent(requestedPerson)}`}${task ? `&task=${task}` : ""}${requestedKey === null ? "" : `&key=${encodeURIComponent(requestedKey)}`}${requestedAccount === null ? "" : `&account=${encodeURIComponent(requestedAccount)}`}${inventoryQuery.size ? `&${inventoryQuery}` : ""}`,
    documentTitle: `${requestedAccount !== null ? "连接详情" : task === "add-account" ? "连接上游账号" : task === "sync-configuration" ? "生成配置文件" : requestedKey !== null ? view === "setup" ? "客户端配置" : "密钥详情" : task === "give-access" ? "创建密钥" : task === "add-person" ? "添加成员" : dashboardViewTitle(view)} · Agency Relay 控制台`,
    operatorId: input.identity.userId ?? null,
    operatorLabel: input.identity.email ?? "已登录的管理员",
    range,
    nowMs: input.now.getTime(),
    dataAsOf,
    mutationFlash: input.mutationFlash ?? null
  };
  try {
    const model = await loadDashboard(input, {...base, view}, {person: requestedPerson, key: requestedKey, account: requestedAccount, task, inventory: inventoryQuery});
    // Selected upstream snapshots can read providers; only local inventories and
    // ledgers participate in periodic console updates. Write results stay put.
    const revision = !input.mutationFlash && !task && !(view === "credentials" && requestedAccount)
      ? await consoleDataRevision(model) : undefined;
    return htmlResponse(renderDashboardDocument(model, nonce, createElement(DashboardContent, {model}), revision), 200, nonce, true, input.url.origin);
  } catch (error) {
    const requestId = presentText(input.requestId);
    console.error(JSON.stringify({
      event: "admin_dashboard_read_failed",
      request_id: requestId,
      view,
      error_category: dashboardErrorCategory(error)
    }));
    const notice = input.mutationFlash?.kind === "user_create_error"
      ? createElement("p", {role: "alert", "data-mutation-input-error": ""}, personInputMessage(input.mutationFlash))
      : createElement(MutationNotice, {flash: input.mutationFlash});
    const recovery = createElement(ReadUnavailable, {url: base.canonicalUrl, requestId});
    return htmlResponse(renderDashboardDocument({...base, view}, nonce, createElement(Fragment, null, notice, recovery)), 503, nonce, true, input.url.origin);
  }
}

function parseDashboardRange(url: URL, now: Date): DashboardRange {
  try { parseRequestHistoryQuery(url); } catch { throw new DashboardInputError("invalid request history query"); }
  const entries = [...url.searchParams.entries()];
  const allowed = new Set(["range", "view", "plan", "status", "limit", "model", "person", "task", "key", "account", "kind", "q", "page", "page_size", "key_q", "key_page", ...REQUEST_HISTORY_FIELDS]);
  if (
    entries.some(([key]) => !allowed.has(key))
    || url.searchParams.getAll("range").length > 1
    || url.searchParams.getAll("view").length > 1
    || url.searchParams.getAll("person").length > 1
    || url.searchParams.getAll("task").length > 1
    || url.searchParams.getAll("key").length > 1
    || url.searchParams.getAll("account").length > 1
    || (url.searchParams.has("kind") && (url.searchParams.getAll("kind").length !== 1 || url.searchParams.get("view") !== "access" || !["all", "human", "admin", "service", "legacy_unresolved"].includes(url.searchParams.get("kind")!)))
    || (url.searchParams.has("page_size") && (url.searchParams.getAll("page_size").length !== 1 || url.searchParams.get("view") !== "access" || !DASHBOARD_PEOPLE_PAGE_SIZES.some(size => String(size) === url.searchParams.get("page_size"))))
    || (url.searchParams.has("account") && (url.searchParams.get("view") !== "credentials" || !/^(codex|grok):\S[\s\S]*$/.test(url.searchParams.get("account")!) || /[\u0000-\u001f\u007f]/.test(url.searchParams.get("account")!) || url.searchParams.has("task")))
    || (url.searchParams.has("key") && (!["access", "setup"].includes(url.searchParams.get("view") ?? "") || !url.searchParams.get("person")?.trim() || !url.searchParams.get("key")?.trim() || url.searchParams.has("task") && !(url.searchParams.get("view") === "setup" && url.searchParams.get("task") === "sync-configuration")))
    || (url.searchParams.get("view") === "setup" && url.searchParams.has("person") && !url.searchParams.has("key"))
    || (url.searchParams.has("task") && (url.searchParams.get("task") === "sync-configuration" ? url.searchParams.get("view") !== "setup" || url.searchParams.has("person") && !url.searchParams.has("key") : url.searchParams.get("task") === "add-account" ? url.searchParams.get("view") !== "credentials" || url.searchParams.has("person") : !["add-person", "add-service", "give-access"].includes(url.searchParams.get("task")!) || url.searchParams.get("view") !== "access"))
    || (url.searchParams.get("task") === "give-access" && !url.searchParams.get("person")?.trim())
  ) {
    throw new DashboardInputError("invalid dashboard query");
  }
  for (const field of ["q", "page", "key_q", "key_page"]) {
    if (!url.searchParams.has(field)) continue;
    if (url.searchParams.getAll(field).length !== 1
      || (!["access", "setup"].includes(url.searchParams.get("view") ?? "") && !(url.searchParams.get("view") === "usage" && field === "q") && !(url.searchParams.get("view") === "credentials" && (field === "q" || field === "page" && url.searchParams.has("account"))))
      || field.startsWith("key_") && (url.searchParams.get("view") !== "access" || !url.searchParams.get("person")?.trim())) throw new DashboardInputError("invalid inventory query");
    const value = url.searchParams.get(field)!;
    if (field.endsWith("page")) {
      if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value) * DASHBOARD_PAGE_SIZE)) throw new DashboardInputError("invalid inventory page");
    } else if (value.length > 256 || /[\u0000-\u001f\u007f]/.test(value)) throw new DashboardInputError("invalid inventory search");
  }
  if (["overview", "usage"].includes(url.searchParams.get("view") ?? "overview")) {
    try {
      const usage = url.searchParams.get("view") === "usage";
      if ([...url.searchParams.keys()].some(key => !(usage ? ["view", "range", "person", "plan", "model", "q"] : ["view", "range"]).includes(key))) throw new Error("Unsupported usage page parameter");
      const trend = parseUsageTrendRange(url, now);
      const params = new URLSearchParams({from: trend.from, to: trend.to, limit: "1000"});
      if (url.searchParams.has("q")) params.set("q", url.searchParams.get("q")!);
      if (url.searchParams.getAll("q").length > 1) throw new Error("Repeated usage search");
      for (const [page, api] of [["person", "user_id"], ["plan", "route_profile_id"], ["model", "response_model"]]) {
        if (url.searchParams.getAll(page).length > 1) throw new Error("Repeated usage filter");
        if (url.searchParams.has(page)) params.set(api, url.searchParams.get(page)!);
      }
      parseUsageQuery(new URL(`https://usage.invalid/?${params}`));
      return {key: trend.key, title: trend.key === "7d" ? "7 天" : "30 天", label: `${trend.from} 至 ${trend.to} UTC`,
        emptyLabel: `${trend.from} 至 ${trend.to} UTC 没有用量记录`, mode: "range", day: null, from: trend.from, to: trend.to,
        rawUsageUrl: `/admin/usage?${params}`};
    } catch { throw new DashboardInputError("invalid usage query"); }
  }
  const requestedKey = url.searchParams.get("range") ?? "7d";
  const definition = DASHBOARD_RANGE_DEFINITIONS.find((candidate) => candidate.key === requestedKey);
  if (!definition) {
    throw new DashboardInputError("invalid dashboard query");
  }

  const today = utcDay(now);
  if (definition.mode === "day") {
    return {
      key: definition.key,
      title: definition.title,
      label: `${today} UTC`,
      emptyLabel: `${today} UTC 没有用量记录`,
      mode: "day",
      day: today,
      from: null,
      to: null,
      rawUsageUrl: usageUrl({ day: today })
    };
  }
  if (definition.mode === "all") {
    return {
      key: definition.key,
      title: definition.title,
      label: "全部保留的 UTC 日",
      emptyLabel: "保留的历史里没有用量记录",
      mode: "all",
      day: null,
      from: null,
      to: null,
      rawUsageUrl: usageUrl({ scope: "all" })
    };
  }

  const from = utcDay(new Date(now.getTime() - (definition.days - 1) * DAY_MS));
  return {
    key: definition.key,
    title: definition.title,
    label: `${from} 至 ${today} UTC`,
    emptyLabel: `${from} 至 ${today} UTC 没有用量记录`,
    mode: "range",
    day: null,
    from,
    to: today,
    rawUsageUrl: usageUrl({ from, to: today })
  };
}

function parseDashboardView(url: URL): DashboardViewKey {
  const requestedView = url.searchParams.get("view") ?? "overview";
  const definition = DASHBOARD_VIEW_DEFINITIONS.find((candidate) => candidate.key === requestedView);
  if (!definition) {
    throw new DashboardInputError("invalid dashboard query");
  }
  return definition.key;
}

function usageUrl(input: { scope?: "all"; day?: string; from?: string; to?: string }): string {
  const params = new URLSearchParams();
  if (input.scope) {
    params.set("scope", input.scope);
  }
  if (input.day) {
    params.set("day", input.day);
  }
  if (input.from && input.to) {
    params.set("from", input.from);
    params.set("to", input.to);
  }
  params.set("limit", "1000");
  return `/admin/usage?${params.toString()}`;
}

/** A form may return only to its own valid dashboard key address. */
export function dashboardKeyReturnUrl(value: string | null, action: URL, keyId: string, now: Date, view: "access" | "setup" = "access"): URL | null {
  if (!value) return null;
  try {
    const url = new URL(value, action);
    if (url.origin !== action.origin || !["/", "/admin"].includes(url.pathname)
      || url.searchParams.get("view") !== view || url.searchParams.get("key") !== keyId
      || url.searchParams.get("person") !== action.searchParams.get("person")) return null;
    parseDashboardRange(url, now);
    return url;
  } catch { return null; }
}

export function dashboardPersonReturnUrl(raw: string | undefined, action: URL, userId: string, now: Date): URL | null {
  if (!raw) return null;
  try {
    const url = new URL(raw, action);
    if (url.origin !== action.origin || !["/", "/admin"].includes(url.pathname)
      || url.searchParams.get("view") !== "access" || url.searchParams.get("person") !== userId
      || url.searchParams.has("task") || url.searchParams.has("key")) return null;
    parseDashboardRange(url, now);
    return url;
  } catch { return null; }
}

/** A committed self-change must not reread a page the actor can no longer access. */
export function consoleLifecycleOutcome(input: { message: string; href: "/login" | "/admin?view=keys"; returnTarget?: string; label: string; cookie?: string; rejected?: boolean }): Response {
  const nonce = randomNonce();
  const title = input.rejected ? "操作未执行" : "人员已更新";
  const href = input.href === "/login" && input.returnTarget ? consoleLoginHref(input.returnTarget) : input.href;
  const response = htmlResponse(consoleDocument({ title: `${title} · Agency Relay`, nonce,
    main: createElement("section", { "data-console-terminal-result": "", "data-console-next": href, role: "status" },
      createElement("h1", { tabIndex: -1 }, title),
      createElement("p", null, input.message),
      createElement("a", { href, className: "action-link" }, input.label))
  }), input.rejected ? 403 : 200, nonce);
  if (input.cookie) response.headers.set("Set-Cookie", input.cookie);
  return response;
}

/** Loss of authority after a staged write does not establish that it rolled back. */
export function consoleUnknownOutcome(href: string): Response {
  const target = consoleReturnTarget(href);
  const next = target ?? "/";
  const nonce = randomNonce();
  return htmlResponse(consoleDocument({title:"请重新打开页面 · Agency Relay",nonce,
    main:createElement("section",{"data-console-terminal-result":"unknown","data-console-next":next},
      createElement(RecoveryPage,{state:"reopen",description:"当前访问条件已改变。请重新打开页面，检查当前权限和操作状态。",href:next,outcome:"unknown",brand:false}))
  }),403,nonce);
}

function renderErrorResponse(input: {
  status: 400 | 503;
  title: string;
  message: string;
  requestId: string;
  retryUrl: string;
  retryLabel: string;
  nonce: string;
}): Response {
  const html = consoleDocument({title: `${input.title} · Agency Relay`, nonce: input.nonce, main: createElement(ReadError, input)});
  return htmlResponse(html, input.status, input.nonce);
}

function htmlResponse(html: string, status: number, nonce: string, allowScript = false, origin?: string): Response {
  const socket = origin ? new URL("/admin/events/credentials", origin) : null;
  if (socket) socket.protocol = socket.protocol === "http:" ? "ws:" : "wss:";
  return new Response(html, {
    status,
    headers: {
      "Cache-Control": "no-store",
      // form-action 'self' is required for board HTML form POSTs (/admin/ui/*).
      // Read-only era used 'none'; writable console must allow same-origin submits.
      // Radix uses style attributes for SSR form inputs and control geometry.
      // Stylesheets and executable scripts remain nonce-bound.
      "Content-Security-Policy": `default-src 'none'; script-src ${allowScript ? `'nonce-${nonce}'` : "'none'"}; ${allowScript ? `connect-src 'self'${socket ? ` ${socket.href}` : ""}; manifest-src 'self'; img-src 'self'; worker-src 'self'; ` : ""}style-src 'nonce-${nonce}'; style-src-attr 'unsafe-inline'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`,
      "Content-Type": "text/html; charset=utf-8",
      "Referrer-Policy": "same-origin",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
      "X-Robots-Tag": "noindex, nofollow"
    }
  });
}

function dashboardErrorCategory(error: unknown): "schema_unavailable" | "read_failed" {
  return error instanceof Error && /no such (?:table|column)/iu.test(error.message)
    ? "schema_unavailable"
    : "read_failed";
}

/** Operator-facing instant (no raw ISO walls). */
function utcDay(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function randomNonce(): string {
  const bytes = new Uint8Array(18);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}
