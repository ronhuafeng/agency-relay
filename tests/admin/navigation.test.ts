/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createNavigation, type Navigation } from "../../src/admin/client/navigation";
import { createDrafts } from "../../src/admin/client/drafts";
import { browserLayout, dashboardHtml, element } from "../support/browser-dom";
let navigation: Navigation | null = null;
beforeEach(() => { history.replaceState(null, "", "/admin?view=access"); document.documentElement.innerHTML = new DOMParser().parseFromString(dashboardHtml(), "text/html").documentElement.innerHTML; browserLayout(); });
afterEach(() => { navigation?.dispose(); navigation = null; vi.restoreAllMocks(); vi.unstubAllGlobals(); });
function deferred() {
  let complete: ((response: Response) => void) | undefined;
  const promise = new Promise<Response>((resolve) => {complete = resolve;});
  return {promise, resolve(response: Response): void { if (!complete) throw new Error("not ready"); complete(response); }};
}
function start(): Navigation { navigation = createNavigation(() => {}, createDrafts()); return navigation; }
describe("fresh dashboard navigation", () => {
  it("uses a fresh GET, changes the current view and focuses its heading", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(dashboardHtml("credentials"))); vi.stubGlobal("fetch", fetch); start(); element("#account-link", HTMLAnchorElement).click();
    await vi.waitFor(() => expect(document.querySelector("main")?.dataset.dashboardView).toBe("credentials"));
    expect(fetch).toHaveBeenCalledWith(expect.stringContaining("view=credentials"), expect.objectContaining({cache: "no-store", credentials: "same-origin"}));
    expect(document.activeElement?.tagName).toBe("H1"); expect(location.search).toBe("?view=credentials");
    expect(Object.keys(history.state)).toEqual(["miniEntry", "miniDepth"]);
  });
  it("ignores a delayed response after a later navigation has completed", async () => {
    const first = deferred(); const second = deferred();
    vi.stubGlobal("fetch", vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)); start();
    element("#account-link", HTMLAnchorElement).click(); element("#usage-link", HTMLAnchorElement).click(); second.resolve(new Response(dashboardHtml("usage")));
    await vi.waitFor(() => expect(document.querySelector("main")?.dataset.dashboardView).toBe("usage")); first.resolve(new Response(dashboardHtml("credentials")));
    await new Promise<void>((resolve) => setTimeout(resolve, 0)); expect(document.querySelector("main")?.dataset.dashboardView).toBe("usage");
  });
  it("keeps previous data on network failure and offers a retry", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network"))); start(); element("#account-link", HTMLAnchorElement).click();
    await vi.waitFor(() => expect(element("[data-dashboard-notice]", HTMLElement).dataset.state).toBe("error"));
    expect(document.querySelector("main")?.dataset.dashboardView).toBe("access"); expect(document.body.textContent).toContain("仍显示上次的数据");
    expect(element("[data-dashboard-notice] a", HTMLAnchorElement).textContent).toBe("重试");
  });
  it("clears private content on confirmed session expiry and offers login recovery", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({error: {code: "admin_auth_required"}}), {status: 403}))); start(); element("#account-link", HTMLAnchorElement).click();
    await vi.waitFor(() => expect(document.body.textContent).toContain("登录状态无法验证"));
    expect(element("[data-dashboard-notice] a", HTMLAnchorElement).pathname).toBe("/login"); expect(location.search).toBe("?view=access");
    expect(document.querySelector("main")?.dataset.dashboardView).toBeUndefined();
    expect(document.querySelector(".nav-rail")).toBeNull();
  });
  it("clears admin content for the authenticated member shell on a 404 admin-only route", async () => {
    vi.stubGlobal("fetch",vi.fn().mockResolvedValue(new Response('<nav data-member-nav></nav><main><h1>没有这个页面</h1></main>',{status:404,headers:{"Content-Type":"text/html"}})));
    start();element("#account-link",HTMLAnchorElement).click();
    await vi.waitFor(()=>expect(document.body.textContent).toContain("当前角色已改变"));
    expect(document.querySelector("main")?.dataset.dashboardView).toBeUndefined();
    expect(document.querySelector(".nav-rail")).toBeNull();
  });
  it.each([false, true])("checks successful member-shell role transitions before replacement (personal=%s)", async personal => {
    if (personal) element(".shell nav", HTMLElement).setAttribute("data-member-nav", "true");
    document.body.insertAdjacentHTML("afterbegin", '<header><span class="identity-person">管理员</span></header>');
    const incoming = new DOMParser().parseFromString(dashboardHtml("usage"), "text/html");
    incoming.querySelector("nav")!.setAttribute("data-member-nav", "true");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(incoming.documentElement.outerHTML, {headers: {"Content-Type": "text/html"}})));
    start(); element("#usage-link", HTMLAnchorElement).click();
    if (personal) {
      await vi.waitFor(() => expect(document.querySelector("main")?.dataset.dashboardView).toBe("usage"));
      expect(document.body.textContent).not.toContain("当前角色已改变");
    } else {
      await vi.waitFor(() => expect(document.body.textContent).toContain("当前角色已改变"));
      expect(document.querySelector("main")?.dataset.dashboardView).toBeUndefined();
      expect(document.querySelector(".identity-person")?.textContent).toBe("");
      expect(element("[data-dashboard-notice] a", HTMLAnchorElement).pathname).toBe("/");
    }
  });
  it.each([["管理员", "成员"], ["成员", "管理员"]])("refreshes the outer identity for an accepted personal response (%s to %s)", async (previousRole, currentRole) => {
    element(".shell nav", HTMLElement).setAttribute("data-member-nav", "true");
    document.querySelector(".site-header")!.outerHTML = `<header class="site-header"><div class="identity" data-console-actor-id="actor-A" data-console-email="person@example.test" data-console-role="${previousRole === "管理员" ? "admin" : "user"}"><span class="identity-person"><strong>person@example.test</strong><span class="identity-role">${previousRole}</span></span></div></header>`;
    const incoming = new DOMParser().parseFromString(dashboardHtml("usage"), "text/html");
    incoming.querySelector("nav")!.setAttribute("data-member-nav", "true");
    incoming.querySelector(".site-header")!.outerHTML = `<header class="site-header"><div class="identity" data-console-actor-id="actor-A" data-console-email="person@example.test" data-console-role="${currentRole === "管理员" ? "admin" : "user"}"><span class="identity-person"><strong>person@example.test</strong><span class="identity-role">${currentRole}</span></span></div></header>`;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(incoming.documentElement.outerHTML, {headers: {"Content-Type": "text/html"}})));
    start(); element("#usage-link", HTMLAnchorElement).click();
    await vi.waitFor(() => expect(document.querySelector("main")?.dataset.dashboardView).toBe("usage"));
    expect(document.querySelector(".identity-role")?.textContent).toBe(currentRole);
    expect(document.querySelector<HTMLElement>(".identity")?.dataset.consoleRole).toBe(currentRole === "管理员" ? "admin" : "user");
    expect(document.querySelector(".identity-person strong")?.textContent).toBe("person@example.test");
    expect(document.body.textContent).not.toContain("当前角色已改变");
  });
  it("retains a personal usage range as explicitly stale on a member-shell read failure", async () => {
    element(".shell nav", HTMLElement).setAttribute("data-member-nav", "true");
    document.querySelector("main")?.insertAdjacentHTML("beforeend", '<section data-usage-range-label="2026-06-18 至 2026-06-24 UTC">Own usage</section>');
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response('<nav data-member-nav></nav><main><h1>暂时不可用</h1></main>', {status: 503, headers: {"Content-Type": "text/html"}})));
    start(); element("#account-link", HTMLAnchorElement).click();
    await vi.waitFor(() => expect(element("[data-dashboard-notice]", HTMLElement).dataset.state).toBe("error"));
    expect(document.body.textContent).toContain("仍显示旧范围 2026-06-18 至 2026-06-24 UTC");
    expect(document.body.textContent).toContain("已过期");
    expect(document.body.textContent).not.toContain("当前角色已改变");
    expect(document.querySelector("[data-usage-range-label]")).not.toBeNull();
  });
  it("still clears personal usage on confirmed session loss", async () => {
    element(".shell nav", HTMLElement).setAttribute("data-member-nav", "true");
    document.querySelector("main")?.insertAdjacentHTML("beforeend", '<section data-usage-range-label="old range">Own usage</section>');
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({error: {code: "user_inactive"}}), {status: 403, headers: {"Content-Type": "application/json"}})));
    start(); element("#account-link", HTMLAnchorElement).click();
    await vi.waitFor(() => expect(document.body.textContent).toContain("登录状态无法验证"));
    expect(document.querySelector("[data-usage-range-label]")).toBeNull();
  });
  it("keeps unrelated private content for an object-specific denial", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({error: {code: "object_denied"}}), {status: 403}))); start(); element("#account-link", HTMLAnchorElement).click();
    await vi.waitFor(() => expect(document.body.textContent).toContain("没有这个页面的访问权限"));
    expect(document.querySelector("main")?.dataset.dashboardView).toBe("access");
  });
  it("clears private content when Back confirms that the session expired", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(new Response(dashboardHtml("credentials")))
      .mockResolvedValueOnce(new Response(JSON.stringify({error: {code: "admin_auth_required"}}), {status: 403})));
    start(); element("#account-link", HTMLAnchorElement).click();
    await vi.waitFor(() => expect(document.querySelector("main")?.dataset.dashboardView).toBe("credentials"));
    history.back();
    await vi.waitFor(() => expect(document.body.textContent).toContain("登录状态无法验证"));
    expect(document.querySelector("main")?.dataset.dashboardView).toBeUndefined();
    expect(document.querySelector(".nav-rail")).toBeNull();
  });
  it("moves to a section without fetching and opens a details destination", () => {
    document.querySelector("main")?.insertAdjacentHTML("beforeend", '<nav class="section-links"><a href="#keys">密钥</a></nav><details id="keys"><summary>详情</summary></details>');
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch); start(); element(".section-links a", HTMLAnchorElement).click();
    expect(element("#keys", HTMLDetailsElement).open).toBe(true); expect(document.activeElement?.id).toBe("keys"); expect(fetch).not.toHaveBeenCalled();
  });
  it("blocks navigation while a mutation is pending", () => {
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch); const current = start(); current.setMutationPending(true); element("#account-link", HTMLAnchorElement).click();
    expect(fetch).not.toHaveBeenCalled(); expect(element("#account-link", HTMLAnchorElement).getAttribute("aria-disabled")).toBe("true");
    current.setMutationPending(false); expect(element("#account-link", HTMLAnchorElement).getAttribute("aria-disabled")).toBeNull();
  });
  it("Back loads fresh HTML and restores the source link focus", async () => {
    const access = dashboardHtml("access", '<a id="person-account" data-dashboard-link href="/admin?view=credentials">管理账号</a>');
    document.body.innerHTML = new DOMParser().parseFromString(access, "text/html").body.innerHTML;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(new Response(dashboardHtml("credentials"))).mockResolvedValueOnce(new Response(access))); start(); element("#person-account", HTMLAnchorElement).click();
    await vi.waitFor(() => expect(location.search).toBe("?view=credentials")); history.back();
    await vi.waitFor(() => expect(document.querySelector("main")?.dataset.dashboardView).toBe("access")); expect(document.activeElement?.id).toBe("person-account");
  });
});

it('ignores a completed old read after the document has discarded its navigation', async () => {
  const request = deferred(); vi.stubGlobal('fetch', vi.fn().mockReturnValue(request.promise));
  const current = start(); element('#account-link', HTMLAnchorElement).click(); current.dispose();
  document.body.innerHTML = '<main id="content" data-console-recovery>Read again</main>';
  request.resolve(new Response(dashboardHtml('credentials')));
  await new Promise(done => setTimeout(done, 0));
  expect(document.querySelector('[data-console-recovery]')).not.toBeNull();
  expect(document.querySelector('[data-dashboard-view]')).toBeNull();
});
