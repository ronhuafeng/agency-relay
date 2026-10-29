import { isRuntimeControlPath } from "../runtime/control";
import { consoleClientPath, consoleStylesheetPath, isDashboardAppPath } from "./app";

export function isDashboardRoute(request: Request, url: URL, env: Env): boolean {
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

export function wantsHtml(request: Request): boolean {
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

export function isAdminDashboardPage(url: URL, env: Env): boolean {
  return url.pathname === "/admin"
    || url.pathname === "/admin/"
    || (url.pathname === "/" && url.hostname === env.ADMIN_DASHBOARD_HOST);
}

export function isOwnConsolePath(pathname: string, method: string): boolean {
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
