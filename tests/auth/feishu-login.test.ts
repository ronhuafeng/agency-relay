import { describe, expect, it } from "vitest";
import { commitServiceAccount } from "../../src/auth/service-accounts";
import { commitServiceOwner } from "../../src/auth/service-delegation";
import { handleRequest } from "../../src/router";
import { consoleCookie, makeFixture, type Fixture } from "../router/fixture";

const HOST = "https://admin.example.test";

describe("Feishu console login", () => {
  it("creates one ordinary session from an organization mailbox and rejects the rest", async () => {
    const fixture = makeFixture();
    const started = await handleRequest(new Request(`${HOST}/login`, {
      method: "POST",
      headers: { Origin: HOST }
    }), fixture.env, fixture.ctx, fixture.deps);
    expect(started.status).toBe(302);
    const authorize = new URL(started.headers.get("Location") ?? "");
    expect(authorize.origin).toBe("https://accounts.feishu.cn");
    expect(authorize.searchParams.get("client_id")).toBe("cli_test");
    expect(authorize.searchParams.get("redirect_uri")).toBe(`${HOST}/login/callback`);
    expect(authorize.searchParams.has("code_challenge")).toBe(false);
    expect(authorize.searchParams.has("code_challenge_method")).toBe(false);
    const state = authorize.searchParams.get("state") ?? "";
    expect(state).not.toBe("");

    const missingOrigin = await handleRequest(new Request(`${HOST}/login`, { method: "POST" }), fixture.env, fixture.ctx, fixture.deps);
    expect(missingOrigin.status).toBe(403);

    installFeishu(fixture, { email: "Person@Other.com", enterprise_email: "", tenant_key: "tenant-a" });
    const foreign = await callback(fixture, state);
    expect(foreign.headers.get("Location")).toBe(`${HOST}/login?error=denied`);
    expect([...fixture.db.users.values()]).toHaveLength(0);

    const restarted = await handleRequest(new Request(`${HOST}/login`, {
      method: "POST",
      headers: { Origin: HOST }
    }), fixture.env, fixture.ctx, fixture.deps);
    const nextState = new URL(restarted.headers.get("Location") ?? "").searchParams.get("state") ?? "";
    installFeishu(fixture, {
      email: "personal@example.com",
      enterprise_email: "  Alice+Work@Example.com ",
      tenant_key: "tenant-a"
    });
    const signedIn = await callback(fixture, nextState);
    expect(signedIn.status).toBe(302);
    expect(signedIn.headers.get("Location")).toBe(`${HOST}/`);
    const cookie = signedIn.headers.get("Set-Cookie") ?? "";
    expect(cookie.startsWith("__Host-mini-console=")).toBe(true);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).not.toContain("Domain=");
    const me = await handleRequest(new Request(`${HOST}/me`, { headers: { Cookie: cookie.split(";")[0] ?? "" } }), fixture.env, fixture.ctx, fixture.deps);
    await expect(me.json()).resolves.toMatchObject({
      user: { email: "alice+work@example.com", role: "user", status: "active" }
    });
    expect([...fixture.db.users.values()]).toHaveLength(1);

    const replay = await callback(fixture, nextState);
    expect(replay.headers.get("Location")).toBe(`${HOST}/login?error=expired`);

    fixture.db.seedConsoleUser({ id: "disabled_member", email: "disabled@example.com", status: "disabled" });
    const disabledStart = await handleRequest(new Request(`${HOST}/login`, {
      method: "POST",
      headers: { Origin: HOST }
    }), fixture.env, fixture.ctx, fixture.deps);
    const disabledState = new URL(disabledStart.headers.get("Location") ?? "").searchParams.get("state") ?? "";
    installFeishu(fixture, { email: "disabled@example.com", enterprise_email: "", tenant_key: "tenant-a" });
    const disabled = await callback(fixture, disabledState);
    expect(disabled.headers.get("Location")).toBe(`${HOST}/login?error=user_inactive`);
    expect(fixture.db.users.get("disabled_member")).toMatchObject({ status: "disabled" });

    const logout = await handleRequest(new Request(`${HOST}/logout`, {
      method: "POST",
      headers: { Origin: HOST, Cookie: cookie.split(";")[0] ?? "" }
    }), fixture.env, fixture.ctx, fixture.deps);
    expect(logout.status).toBe(302);
    expect(logout.headers.get("Set-Cookie")).toContain("Max-Age=0");
    const after = await handleRequest(new Request(`${HOST}/me`, { headers: { Cookie: cookie.split(";")[0] ?? "" } }), fixture.env, fixture.ctx, fixture.deps);
    expect(after.status).toBe(403);

    const browser = await handleRequest(new Request(`${HOST}/admin`, { headers: { Accept: "text/html" } }), fixture.env, fixture.ctx, fixture.deps);
    expect(browser.status).toBe(302);
    expect(browser.headers.get("Location")).toBe(`${HOST}/login?return=%2Fadmin`);
  });
});

function callback(fixture: Fixture, state: string, cookie: string | null = state): Promise<Response> {
  const headers = new Headers();
  if (cookie !== null) headers.set("Cookie", `__Host-mini_login=${cookie}`);
  return handleRequest(new Request(`${HOST}/login/callback?code=code-1&state=${encodeURIComponent(state)}`, { headers }), fixture.env, fixture.ctx, fixture.deps);
}

function installFeishu(fixture: Fixture, profile: { email: string; enterprise_email: string; tenant_key: string }): void {
  fixture.deps.fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/oauth/v3/token")) {
      const body = JSON.parse(String(init?.body)) as { client_secret?: string; redirect_uri?: string; code_verifier?: string };
      expect(body.client_secret).toBe(fixture.env.FEISHU_APP_SECRET);
      expect(body.redirect_uri).toBe(`${HOST}/login/callback`);
      expect(body.code_verifier).toBeUndefined();
      return Response.json({ access_token: "user-token" });
    }
    if (url.endsWith("/authen/v1/user_info")) {
      expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer user-token");
      return Response.json({ code: 0, data: profile });
    }
    throw new Error(`unexpected ${url}`);
  };
}


it("binds the callback to the browser that started login", async () => {
  const fixture = makeFixture();
  const first = await handleRequest(new Request(`${HOST}/login`, {
    method: "POST",
    headers: { Origin: HOST }
  }), fixture.env, fixture.ctx, fixture.deps);
  const firstState = new URL(first.headers.get("Location") ?? "").searchParams.get("state") ?? "";
  const firstCookie = first.headers.getSetCookie().find((cookie) => cookie.startsWith("__Host-mini_login=")) ?? "";
  expect(firstCookie).toContain("HttpOnly");
  expect(firstCookie).toContain("Secure");
  expect(firstCookie).toContain("SameSite=Lax");
  expect(firstCookie).not.toContain("Domain=");

  const second = await handleRequest(new Request(`${HOST}/login`, {
    method: "POST",
    headers: { Origin: HOST }
  }), fixture.env, fixture.ctx, fixture.deps);
  const secondState = new URL(second.headers.get("Location") ?? "").searchParams.get("state") ?? "";
  installFeishu(fixture, { email: "alice@example.com", enterprise_email: "", tenant_key: "tenant-a" });
  let providerCalls = 0;
  const provider = fixture.deps.fetch;
  fixture.deps.fetch = async (input, init) => {
    providerCalls += 1;
    return provider(input, init);
  };

  const missing = await callback(fixture, firstState, null);
  expect(missing.headers.get("Location")).toBe(`${HOST}/login?error=denied`);
  expect(providerCalls).toBe(0);
  const mismatched = await callback(fixture, firstState, secondState);
  expect(mismatched.headers.get("Location")).toBe(`${HOST}/login?error=denied`);
  expect(mismatched.headers.get("Set-Cookie")).toBeNull();
  expect(providerCalls).toBe(0);

  const signedIn = await callback(fixture, secondState);
  expect(signedIn.headers.get("Location")).toBe(`${HOST}/`);
  const session = signedIn.headers.getSetCookie().find((cookie) => cookie.startsWith("__Host-mini-console=")) ?? "";
  expect(session.startsWith("__Host-mini-console=")).toBe(true);
  const replay = await callback(fixture, secondState);
  expect(replay.headers.get("Location")).toBe(`${HOST}/login?error=expired`);

  const stale = await callback(fixture, firstState, secondState);
  expect(stale.headers.get("Location")).toBe(`${HOST}/login?error=denied`);
  expect(stale.headers.getSetCookie().some((cookie) => cookie.startsWith("__Host-mini_login=") && cookie.includes("Max-Age=0"))).toBe(false);
});

async function start(fixture: Fixture, target: string): Promise<string> {
  const response = await handleRequest(new Request(`${HOST}/login?${new URLSearchParams({return: target})}`, {method: "POST", headers: {Origin: HOST}}), fixture.env, fixture.ctx, fixture.deps);
  expect(response.status).toBe(302);
  const authorize = new URL(response.headers.get("Location")!);
  const state = authorize.searchParams.get("state")!;
  expect(/^[A-Za-z0-9_-]{43}$/.test(state)).toBe(true);
  expect(authorize.searchParams.get("redirect_uri")).toBe(`${HOST}/login/callback`);
  expect(authorize.searchParams.has("return")).toBe(false);
  return state;
}

it.each(["user", "admin"] as const)("keeps an expired %s deep link through one-use state and rechecks current role", async role => {
  const f = makeFixture();
  f.db.seedConsoleUser({id: "viewer", email: "viewer@example.com", role});
  const token = await consoleCookie(f, "viewer@example.com");
  await f.env.DB.prepare("UPDATE console_sessions SET expires_at = '2000-01-01T00:00:00Z'").run();
  const target = role === "admin" ? "/admin?view=access&person=viewer&range=30d&q=viewer%40example.com#credits" : "/admin?area=me&view=setup&key=missing-key#content";
  const initial = await handleRequest(new Request(`${HOST}${target}`, {headers: {Accept: "text/html", Cookie: `__Host-mini-console=${token}`}}), f.env, f.ctx, f.deps);
  const login = new URL(initial.headers.get("Location")!);
  expect(login.pathname).toBe("/login");
  expect(login.searchParams.get("return")).toBe(target.split("#")[0]);
  const state = await start(f, target);
  const otherState = await start(f, "/admin?area=me&view=quota");
  installFeishu(f, {email: "viewer@example.com", enterprise_email: "", tenant_key: "tenant-a"});
  const result = await handleRequest(new Request(`${HOST}/login/callback?${new URLSearchParams({state, code: "synthetic-code", return: "https://untrusted.invalid/"})}`, {
    headers: { Cookie: `__Host-mini_login=${state}` }
  }), f.env, f.ctx, f.deps);
  expect(result.headers.get("Location")).toBe(`${HOST}${target}`);
  const cookie = result.headers.get("Set-Cookie")!.split(";")[0];
  expect((await callback(f, otherState)).headers.get("Location")).toBe(`${HOST}/admin?area=me&view=quota`);
  expect((await callback(f, state)).headers.get("Location")).toBe(`${HOST}/login?error=expired`);
  if (role === "admin") await f.env.DB.prepare("UPDATE users SET role = 'user' WHERE id = 'viewer'").run();
  const destination = await handleRequest(new Request(`${HOST}${target}`, {headers: {Cookie: cookie}}), f.env, f.ctx, f.deps);
  expect(destination.status).toBe(role === "admin" ? 404 : 200);
  const html = await destination.text();
  expect(html.includes('data-dashboard-view="access"')).toBe(false);
  expect(html.includes('data-selected-key="missing-key"')).toBe(false);
  expect(html.includes('data-member-nav')).toBe(true);
});

it.each(['https://untrusted.invalid/', '//untrusted.invalid/', '/\\untrusted.invalid/', '/login/callback?code=secret', '/me/ui/keys', '/admin?view=unknown', '/admin?view=keys&token=cfwd_secret', '/admin?area=me&view=setup&key=cfwd_secret', '/admin?view=access&person=a&person=b', '/admin?view=access#token=secret', '/admin?view=access#cfwd_secret'])('rejects an unsafe return target before state creation: %s', async target => {
  const f = makeFixture();
  for (const method of ['GET', 'POST']) {
    const response = await handleRequest(new Request(`${HOST}/login?${new URLSearchParams({return: target})}`, {method, headers: {Origin: HOST}}), f.env, f.ctx, f.deps);
    expect(response.status).toBe(400);
    expect(response.headers.get('Location')).toBeNull();
  }
  expect((await f.env.DB.prepare('SELECT count(*) AS count FROM console_login_states').first<{count:number}>())?.count).toBe(0);
});

it('resumes a failed eligible login at the same safe target and rejects expired state without provider use', async () => {
  const f = makeFixture(); const target = '/admin?area=me&view=keys&key=exact-key';
  const state = await start(f, target);
  installFeishu(f, {email: 'outside@foreign.test', enterprise_email: '', tenant_key: 'tenant-a'});
  const denied = new URL((await callback(f, state)).headers.get('Location')!);
  expect(denied.searchParams.get('return')).toBe(target); expect(denied.searchParams.get('error')).toBe('denied');
  const next = await start(f, target);
  await f.env.DB.prepare("UPDATE console_login_states SET expires_at = '2000-01-01T00:00:00Z'").run();
  f.deps.fetch = async () => {throw new Error('Expired state must not call a provider');};
  expect((await callback(f, next)).headers.get('Location')).toBe(`${HOST}/login?error=expired`);
});

it.each(['7d','30d'])('returns a personal usage range exactly after login: %s', async range => {
  const f = makeFixture(); const target = `/admin?area=me&view=usage&range=${range}#content`;
  const state = await start(f,target);
  installFeishu(f,{email:'viewer@example.com',enterprise_email:'',tenant_key:'tenant-a'});
  const result = await callback(f,state);
  expect(result.headers.get('Location')).toBe(`${HOST}${target}`);
  const destination = await handleRequest(new Request(`${HOST}${target}`,{headers:{Accept:'text/html',Cookie:result.headers.get('Set-Cookie')!.split(';')[0]}}),f.env,f.ctx,f.deps);
  expect(destination.status).toBe(200);
  const html = await destination.text();
  expect(/data-dashboard-url="([^"]+)"/.exec(html)?.[1].replaceAll('&amp;','&')).toBe(target.split('#')[0]);
});

it('binds delegated HTML to one-use state and authorizes the current human separately from the service owner', async () => {
  const f = makeFixture(); const now = f.deps.now();
  f.db.seedConsoleUser({id:'viewer',email:'viewer@example.com'});
  f.db.seedConsoleUser({id:'other-owner',email:'other@example.com'});
  const operator = {kind:'admin_secret' as const,userId:null,email:null,role:null,subject:null,requestId:'fixture-service'};
  const service = await commitServiceAccount(f.env,operator,'Build service',now);
  await commitServiceOwner(f.env,operator,service.id,{owner_user_id:'viewer',expected_revision:0},now);
  const target = `/me/service-accounts/${service.id}?view=usage&range=30d#content`;
  const cookie = await consoleCookie(f,'viewer@example.com');
  await f.env.DB.prepare("UPDATE console_sessions SET expires_at = '2000-01-01T00:00:00Z'").run();
  const response = await handleRequest(new Request(`${HOST}${target}`,{headers:{Accept:'text/html',Cookie:`__Host-mini-console=${cookie}`}}),f.env,f.ctx,f.deps);
  expect(new URL(response.headers.get('Location')!).searchParams.get('return')).toBe(target.split('#')[0]);
  const state = await start(f,target);
  installFeishu(f,{email:'viewer@example.com',enterprise_email:'',tenant_key:'tenant-a'});
  const result = await callback(f,state); const freshCookie = result.headers.get('Set-Cookie')!.split(';')[0];
  expect(result.headers.get('Location')).toBe(`${HOST}${target}`);
  const read = (path:string,html=false) => handleRequest(new Request(`${HOST}${path}`,{headers:{Cookie:freshCookie,Accept:html?'text/html':'application/json'}}),f.env,f.ctx,f.deps);
  expect((await read(target,true)).status).toBe(200);
  expect(await (await read('/me')).json()).toMatchObject({user:{id:'viewer',role:'user'}});
  expect(await (await read(`/me/service-accounts/${service.id}`)).json()).toMatchObject({service:{id:service.id}});
  await commitServiceOwner(f.env,operator,service.id,{owner_user_id:'other-owner',expected_revision:1},now);
  expect((await read('/me')).status).toBe(200);
  const denied = await read(target,true); expect(denied.status).toBe(404);
  expect(await denied.text()).not.toContain('data-service-id');
  expect((await callback(f,state)).headers.get('Location')).toBe(`${HOST}/login?error=expired`);
});

it.each(['/me/service-accounts/service?view=usage&range=all','/me/service-accounts/service?view=keys&range=30d'])('rejects invalid delegated HTML before login state: %s', async target => {
  const f = makeFixture();
  const response = await handleRequest(new Request(`${HOST}${target}`,{headers:{Accept:'text/html'}}),f.env,f.ctx,f.deps);
  expect(response.status).toBe(400); expect(response.headers.get('Location')).toBeNull();
  expect((await f.env.DB.prepare('SELECT count(*) AS count FROM console_login_states').first<{count:number}>())?.count).toBe(0);
});
