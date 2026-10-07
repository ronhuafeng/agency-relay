import { CONSOLE_RETURN_SECTIONS, consoleLoginHref, consoleReturnTarget } from "../admin/return-target";
import { createElement } from "react";
import { LoginEntry, LogoutEntry } from "../admin/ui/pages/login";
import { assertConsoleBrowserWrite } from "../admin/browser-write";
import { consoleDocument } from "../admin/console-shell";
import { base64UrlEncode, nowIso } from "../crypto";
import { HttpError } from "../errors";
import type { AppDependencies, RequestContext } from "../types";
import {
  clearConsoleSessionCookie,
  consoleSessionCookie,
  createConsoleSession,
  deleteConsoleSession,
  readConsoleSessionPrincipal
} from "./console-session";
import { canonicalMailbox, organizationDomain, resolveConsolePrincipal } from "./principal";

const AUTHORIZE_URL = "https://accounts.feishu.cn/open-apis/authen/v1/authorize";
const TOKEN_URL = "https://accounts.feishu.cn/oauth/v3/token";
const USER_INFO_URL = "https://open.feishu.cn/open-apis/authen/v1/user_info";
const SCOPE = "contact:user.email:readonly contact:user.employee:readonly";
const STATE_SECONDS = 10 * 60;

const LOGIN_ERRORS: Record<string, string> = {
  denied: "这次登录没有获得组织邮箱。",
  user_inactive: "这个账号已停用。请管理员重新启用。再登录也不会恢复。",
  ambiguous_identity: "这个邮箱对应了多个账号。请管理员分开处理。",
  console_identity_changed: "账号信息已变更，请重新登录。",
  expired: "登录已过期。请再试一次。"
};

export async function routeConsoleLogin(
  request: Request,
  env: Env,
  url: URL,
  deps: AppDependencies,
  requestContext: RequestContext
): Promise<Response | null> {
  if (url.hostname !== env.ADMIN_DASHBOARD_HOST) return null;
  if (url.pathname === "/login" && request.method === "GET") return loginPage(request, env, deps.now());
  if (url.pathname === "/login" && request.method === "POST") return startLogin(request, env, url, deps.now());
  if (url.pathname === "/login/callback" && request.method === "GET") {
    return finishLogin(request, env, url, deps, requestContext);
  }
  if (url.pathname === "/logout" && request.method === "GET") return logoutPage();
  if (url.pathname === "/logout" && request.method === "POST") return logout(request, env, url);
  return null;
}

async function loginPage(request: Request, env: Env, now: Date): Promise<Response> {
  const target = loginTarget(new URL(request.url));
  if (await readConsoleSessionPrincipal(env, request, now)) {
    return redirect(`https://${env.ADMIN_DASHBOARD_HOST}${target}`);
  }
  const code = new URL(request.url).searchParams.get("error");
  const message = code ? LOGIN_ERRORS[code] ?? null : null;
  const html = consoleDocument({
    title: "登录 · Mini",
    main: createElement(LoginEntry, {message, action: consoleLoginHref(target)}),
    // A fragment inherited through the initial HTTP redirect never reaches the
    // server. Carry only a bounded section ID into the checked return target.
    extra: createElement("script", {dangerouslySetInnerHTML: {__html: `const f=document.querySelector('form[action^="/login"]');if(f&&${JSON.stringify(CONSOLE_RETURN_SECTIONS)}.includes(location.hash)){const u=new URL(f.action);const t=u.searchParams.get("return")||"/";if(!t.includes("#")){u.searchParams.set("return",t+location.hash);f.action=u.pathname+u.search;}}`}})
  });
  return new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Referrer-Policy": "same-origin"
    }
  });
}

async function startLogin(request: Request, env: Env, url: URL, now: Date): Promise<Response> {
  assertConsoleBrowserWrite(request, env, url);
  const target = loginTarget(url);
  const config = feishuConfig(env);
  if (!config) {
    console.error(JSON.stringify({ event: "feishu_login_unconfigured" }));
    throw new HttpError(500, "An internal error occurred", "server_error", "internal_error");
  }
  const state = randomToken();
  await env.DB.prepare(`DELETE FROM console_login_states WHERE expires_at <= ?`).bind(nowIso(now)).run();
  await env.DB.prepare(
    `INSERT INTO console_login_states (state, expires_at, created_at, return_path) VALUES (?, ?, ?, ?)`
  ).bind(state, nowIso(new Date(now.getTime() + STATE_SECONDS * 1000)), nowIso(now), target).run();
  const authorize = new URL(AUTHORIZE_URL);
  authorize.searchParams.set("client_id", config.appId);
  authorize.searchParams.set("response_type", "code");
  authorize.searchParams.set("redirect_uri", redirectUri(env));
  authorize.searchParams.set("state", state);
  authorize.searchParams.set("scope", SCOPE);
  return redirect(authorize.toString(), [loginStateCookie(state)]);
}

async function finishLogin(
  request: Request,
  env: Env,
  url: URL,
  deps: AppDependencies,
  requestContext: RequestContext
): Promise<Response> {
  const config = feishuConfig(env);
  const code = url.searchParams.get("code")?.trim() ?? "";
  const state = url.searchParams.get("state")?.trim() ?? "";
  const browserState = readLoginState(request);
  if (!config || !code || !state || !browserState || browserState !== state) return loginError(env, "denied");
  const now = deps.now();
  const target = await consumeLoginState(env, state, now);
  if (target === null) return loginError(env, "expired", "/", true);
  try {
    const accessToken = await exchangeCode(deps, config, code, redirectUri(env));
    const profile = await readProfile(deps, accessToken);
    const email = organizationMailbox(profile, config.domain);
    if (!email || !nonEmpty(profile.tenant)) return loginError(env, "denied", target, true);
    const principal = await resolveConsolePrincipal(env, email, now, {
      subject: null,
      requestId: requestContext.requestId
    });
    const token = await createConsoleSession(env, principal, now);
    return redirect(`https://${env.ADMIN_DASHBOARD_HOST}${target}`, [
      consoleSessionCookie(token),
      clearLoginStateCookie()
    ]);
  } catch (error) {
    if (error instanceof HttpError && error.code && LOGIN_ERRORS[error.code]) {
      return loginError(env, error.code, target, true);
    }
    console.error(JSON.stringify({ event: "feishu_login_failed", stage: failureStage(error) }));
    return loginError(env, "denied", target, true);
  }
}

function logoutPage(): Response {
  const html = consoleDocument({
    title: "退出 · Mini",
    main: createElement(LogoutEntry)
  });
  return new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer"
    }
  });
}

async function logout(request: Request, env: Env, url: URL): Promise<Response> {
  assertConsoleBrowserWrite(request, env, url);
  await deleteConsoleSession(env, request);
  return redirect(`https://${env.ADMIN_DASHBOARD_HOST}/login`, [clearConsoleSessionCookie()]);
}

async function consumeLoginState(env: Env, state: string, now: Date): Promise<string | null> {
  const row = await env.DB.prepare(
    `DELETE FROM console_login_states WHERE state = ? AND expires_at > ? RETURNING return_path`
  ).bind(state, nowIso(now)).first<{ return_path: string }>();
  return row ? consoleReturnTarget(row.return_path) : null;
}

async function exchangeCode(
  deps: AppDependencies,
  config: FeishuConfig,
  code: string,
  redirect: string
): Promise<string> {
  const response = await deps.fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      grant_type: "authorization_code",
      client_id: config.appId,
      client_secret: config.secret,
      code,
      redirect_uri: redirect
    })
  });
  const body = await readJson(response);
  const token = accessToken(body);
  if (!response.ok || !token) throw feishuFailure("token", response, body);
  return token;
}

async function readProfile(deps: AppDependencies, accessTokenValue: string): Promise<FeishuProfile> {
  const response = await deps.fetch(USER_INFO_URL, {
    headers: { Authorization: `Bearer ${accessTokenValue}`, Accept: "application/json" }
  });
  const body = await readJson(response);
  const data = record(body) && record(record(body)?.data) ? record(record(body)?.data) : record(body);
  if (!response.ok || !data || (typeof record(body)?.code === "number" && record(body)?.code !== 0)) {
    throw feishuFailure("profile", response, body);
  }
  return {
    email: data.email,
    enterprise: data.enterprise_email,
    tenant: data.tenant_key
  };
}

function feishuFailure(stage: "token" | "profile", response: Response, body: unknown): Error {
  const root = record(body);
  const numeric = typeof root?.code === "number" ? String(root.code) : "";
  const oauth = typeof root?.error === "string" ? root.error.replace(/[^a-zA-Z0-9_]/g, "") : "";
  const safe = [numeric, oauth].filter(Boolean).join("_").slice(0, 60) || "rejected";
  return new Error(`feishu_${stage}_${response.status}_${safe}`);
}

function failureStage(error: unknown): string {
  if (error instanceof HttpError && error.code && /^[a-z0-9_]{1,40}$/.test(error.code)) return error.code;
  if (error instanceof Error && /^feishu_[a-z0-9_]{1,80}$/.test(error.message)) return error.message;
  return "unknown";
}

function organizationMailbox(profile: FeishuProfile, domain: string): string | null {
  return acceptedMailbox(profile.enterprise, domain) ?? acceptedMailbox(profile.email, domain);
}

function acceptedMailbox(value: unknown, domain: string): string | null {
  const email = canonicalMailbox(value);
  if (!email) return null;
  return email.slice(email.lastIndexOf("@") + 1) === domain ? email : null;
}

function accessToken(body: unknown): string | null {
  const root = record(body);
  if (!root || typeof root.error === "string") return null;
  if (typeof root.code === "number" && root.code !== 0) return null;
  if (typeof root.access_token === "string" && root.access_token) return root.access_token;
  const data = record(root.data);
  return typeof data?.access_token === "string" && data.access_token ? data.access_token : null;
}

function feishuConfig(env: Env): FeishuConfig | null {
  const appId = env.FEISHU_APP_ID?.trim();
  const secret = env.FEISHU_APP_SECRET?.trim();
  const domain = organizationDomain(env);
  if (!appId || !secret || !domain) {
    return null;
  }
  return { appId, secret, domain };
}

function redirectUri(env: Env): string {
  return `https://${env.ADMIN_DASHBOARD_HOST}/login/callback`;
}

function loginTarget(url: URL): string {
  if (!url.searchParams.has("return")) return "/";
  const target = url.searchParams.getAll("return");
  const safe = target.length === 1 ? consoleReturnTarget(target[0]) : null;
  if (!safe) throw new HttpError(400, "Invalid console return target", "invalid_request_error", "invalid_console_return");
  return safe;
}

const LOGIN_STATE_COOKIE = "__Host-mini_login";

function loginStateCookie(state: string): string {
  return `${LOGIN_STATE_COOKIE}=${state}; HttpOnly; Secure; Path=/; SameSite=Lax; Max-Age=${STATE_SECONDS}`;
}

function clearLoginStateCookie(): string {
  return `${LOGIN_STATE_COOKIE}=; HttpOnly; Secure; Path=/; SameSite=Lax; Max-Age=0`;
}

function readLoginState(request: Request): string | null {
  const header = request.headers.get("Cookie") ?? "";
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator === -1) continue;
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (name === LOGIN_STATE_COOKIE && value) return value;
  }
  return null;
}

function loginError(env: Env, code: string, target = "/", clearLogin = false): Response {
  const destination = new URL(consoleLoginHref(target), `https://${env.ADMIN_DASHBOARD_HOST}`);
  destination.searchParams.set("error", code);
  return redirect(destination.href, clearLogin ? [clearLoginStateCookie()] : []);
}

function redirect(location: string, cookies: readonly string[] = []): Response {
  const headers = new Headers({
    Location: location,
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer"
  });
  for (const cookie of cookies) headers.append("Set-Cookie", cookie);
  return new Response(null, { status: 302, headers });
}

function randomToken(): string {
  return base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)));
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

interface FeishuConfig {
  appId: string;
  secret: string;
  domain: string;
}

interface FeishuProfile {
  email: unknown;
  enterprise: unknown;
  tenant: unknown;
}
