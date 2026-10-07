/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initializeMutations } from "../../src/admin/client/mutations";
import type { Navigation } from "../../src/admin/client/navigation";
import { createNavigation } from "../../src/admin/client/navigation";
import { createDrafts } from "../../src/admin/client/drafts";
import { browserLayout, dashboardHtml, element, submit } from "../support/browser-dom";
let dispose: (() => void) | null = null;
beforeEach(() => {
  history.replaceState(null, "", "/admin?view=access");
  document.body.innerHTML = new DOMParser().parseFromString(dashboardHtml("access", '<form method="post" action="/admin/ui/keys"><input name="user_id" value="Alex"><button type="submit" name="confirm" value="1">创建密钥</button></form>'), "text/html").body.innerHTML;
  browserLayout();
});
afterEach(() => { dispose?.(); dispose = null; vi.restoreAllMocks(); vi.unstubAllGlobals(); });
function start(): Navigation {
  const navigation: Navigation = {notice: vi.fn(), currentUrl: () => new URL(location.href), discardDraft: vi.fn(), setMutationPending: vi.fn(), showMutationResult: vi.fn(), acceptBackground: vi.fn(), dispose: () => {}};
  dispose = initializeMutations(navigation); return navigation;
}
describe("bounded mutation outcomes", () => {
  it.each([422, 503])("restores the list search after a mutation returns %s", async (status) => {
    const main = element("main", HTMLElement);
    main.insertAdjacentHTML("beforeend", '<form method="get" action="/admin" data-dashboard-search><input name="q"><button type="submit">搜索人员</button></form>');
    const navigation = createNavigation(() => {}, createDrafts());
    const stopMutations = initializeMutations(navigation);
    dispose = () => {stopMutations(); navigation.dispose();};
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({error: {message: "invalid input"}}), {status, headers: {"Content-Type": "application/json"}})));
    submit(element('form[method="post"]', HTMLFormElement));
    const search = element('[data-dashboard-search] button', HTMLButtonElement);
    expect(search.disabled).toBe(true);
    await vi.waitFor(() => expect(search.disabled).toBe(false));
    expect(element('[data-dashboard-search] input', HTMLInputElement).disabled).toBe(false);
    expect(element('form[method="post"] button', HTMLButtonElement).disabled).toBe(status === 503);
  });
  it("submits exactly once with form values and disables duplicate submissions while pending", async () => {
    let resolve: ((response: Response) => void) | null = null;
    const request = new Promise<Response>((done) => {resolve = done;}); const fetch = vi.fn().mockReturnValue(request); vi.stubGlobal("fetch", fetch); const navigation = start(); const form = element("form", HTMLFormElement);
    expect(submit(form).defaultPrevented).toBe(true); submit(form); expect(fetch).toHaveBeenCalledTimes(1); expect(element("button[type=submit]", HTMLButtonElement).disabled).toBe(true);
    const call = fetch.mock.calls[0]; const body: unknown = call?.[1]?.body;
    expect(body instanceof URLSearchParams && body.get("confirm")).toBe("1");
    if (!resolve) throw new Error("request missing"); const complete: (response: Response) => void = resolve;
    complete(new Response(JSON.stringify({error: {message: "invalid input"}}), {status: 422, headers: {"Content-Type": "application/json"}}));
    await vi.waitFor(() => expect(navigation.notice).toHaveBeenCalledWith(expect.stringContaining("未接受"), "error")); expect(element("button[type=submit]", HTMLButtonElement).disabled).toBe(false);
  });
  it.each(["network", "invalid-html", "server-error"])("blocks replay when the result is unknown: %s", async (failure) => {
    history.replaceState(null, "", "/admin?view=access&person=Alex&task=give-access");
    const fetch = vi.fn(); if (failure === "network") fetch.mockRejectedValue(new Error("connection lost")); else fetch.mockResolvedValue(new Response(failure === "invalid-html" ? "<h1>Login</h1>" : "", {status: 503, headers: {"Content-Type": "text/html"}}));
    vi.stubGlobal("fetch", fetch); const navigation = start(); const form = element("form", HTMLFormElement); submit(form);
    await vi.waitFor(() => expect(navigation.notice).toHaveBeenCalledWith(expect.stringContaining("尚未确认"), "error", expect.any(URL), "查看当前状态"));
    expect(navigation.notice).toHaveBeenCalledWith(expect.stringContaining("尚未确认"), "error", new URL("/admin?view=access&person=Alex", location.href), "查看当前状态");
    submit(form); expect(fetch).toHaveBeenCalledTimes(1); expect(element("button[type=submit]", HTMLButtonElement).disabled).toBe(true); expect(navigation.discardDraft).toHaveBeenCalledWith(form);
  });
  it("accepts a bounded one-time result even when a subsequent page read failed", async () => {
    const html = dashboardHtml("access").replace('data-dashboard-view="access"', 'data-dashboard-view="access" data-dashboard-mutation="key_created"');
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(html, {status: 503, headers: {"Content-Type": "text/html"}}))); const navigation = start(); const form = element("form", HTMLFormElement); submit(form);
    await vi.waitFor(() => expect(navigation.showMutationResult).toHaveBeenCalledWith(expect.any(Document), form)); expect(navigation.discardDraft).not.toHaveBeenCalled();
  });
  it.each(["object_denied", "user_inactive"])("keeps current actor content for an object-specific rejection: %s", async code => {
    const changed = vi.fn(); document.addEventListener("console:actor-changed", changed);
    try {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({error: {code, message: "Target rejected"}}, {status: 403})));
      const navigation = start(); submit(element("form", HTMLFormElement));
      await vi.waitFor(() => expect(navigation.notice).toHaveBeenCalledWith(expect.any(String), "error", new URL(location.href), "查看当前状态"));
      expect(changed).not.toHaveBeenCalled(); expect(document.querySelector(".shell")).not.toBeNull();
    } finally { document.removeEventListener("console:actor-changed", changed); }
  });
  it("stopping the wait aborts transport and does not undo or replay the operation", async () => {
    const fetch = vi.fn((_url: string, input: RequestInit) => new Promise<Response>((_resolve, reject) => input.signal?.addEventListener("abort", () => reject(new Error("aborted")))));
    vi.stubGlobal("fetch", fetch); const navigation = start(); submit(element("form", HTMLFormElement)); element("[data-stop-waiting]", HTMLButtonElement).click();
    await vi.waitFor(() => expect(navigation.notice).toHaveBeenCalledWith(expect.stringContaining("尚未确认"), "error", expect.any(URL), "查看当前状态")); expect(fetch).toHaveBeenCalledTimes(1);
  });
  it.each(["查看当前连接", "查看默认连接"])("uses the owning input-error GET label: %s", async label => {
    const target = "/admin?view=credentials&account=codex%3Acurrent";
    const html = dashboardHtml("credentials", `<section data-mutation-input-error><p>请检查连接选择。</p><a data-rejected-read href="${target}">${label}</a></section>`)
      .replace('data-dashboard-view="credentials"','data-dashboard-view="credentials" data-dashboard-mutation="credential_task_error"');
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(html,{status:422,headers:{"Content-Type":"text/html"}})));
    const navigation = start(); submit(element("form", HTMLFormElement));
    await vi.waitFor(() => expect(navigation.notice).toHaveBeenCalledWith("请检查连接选择。", "error", new URL(target,location.href), label));
    expect(navigation.showMutationResult).not.toHaveBeenCalled();
    expect(element("main",HTMLElement).dataset.consoleOutcome).toBe("rejected");
  });
  it("accepts an explicit public unknown result without retaining private state or replaying", async () => {
    const target = "/admin?view=credentials&account=codex%3Acurrent";
    const html = `<title>暂时无法确认当前账号 · Mini</title><main id="content" data-console-terminal-result="unknown" data-console-next="${target}"><div data-console-recovery data-recovery-state="unavailable"><h1>暂时无法确认当前账号</h1><p data-console-outcome="unknown">操作结果尚未确认，可能已经执行。</p><a href="${target}">查看当前连接</a></div></main>`;
    const fetch = vi.fn().mockResolvedValue(new Response(html,{status:503,headers:{"Content-Type":"text/html"}})); vi.stubGlobal("fetch",fetch);
    const ended = vi.fn(); document.addEventListener("console:document-ended",ended);
    try {
      const navigation = start(); const form = element("form",HTMLFormElement); submit(form);
      await vi.waitFor(() => expect(document.querySelector('[data-console-recovery] [data-console-outcome="unknown"]')).not.toBeNull());
      expect(document.querySelector('.shell,.identity,[data-ui-props],[data-console-actor-id],form')).toBeNull();
      expect(document.activeElement).toBe(document.querySelector("h1"));
      expect(location.pathname + location.search).toBe(target); expect(ended).toHaveBeenCalledOnce();
      expect(navigation.discardDraft).toHaveBeenCalledWith(form); expect(fetch).toHaveBeenCalledOnce();
    } finally {document.removeEventListener("console:document-ended",ended);}
  });
  it("accepts the owning public consoleDocument recovery composition after staged authority loss", async () => {
    const target = "/admin?view=credentials&account=grok%3Acurrent";
    // Load the real Worker-owned response at runtime. Its module remains checked
    // in the Worker TypeScript program; this DOM test stays in the client realm.
    const {consoleUnknownOutcome} = await vi.importActual<{consoleUnknownOutcome:(href:string)=>Response}>("../../src/admin/dashboard");
    const response = consoleUnknownOutcome(target); expect(response.status).toBe(403);
    const fetch = vi.fn().mockResolvedValue(response); vi.stubGlobal("fetch",fetch);
    const navigation = start(); submit(element("form",HTMLFormElement));
    await vi.waitFor(() => expect(document.querySelector('[data-console-recovery]')).not.toBeNull());
    expect(document.querySelector('[data-console-actor-id],.identity,[data-dashboard-nav],[data-ui-props],form')).toBeNull();
    expect(document.querySelector('[data-console-recovery] [data-console-outcome]')?.getAttribute("data-console-outcome")).toBe("unknown");
    expect(location.pathname + location.search).toBe(target); expect(navigation.showMutationResult).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledOnce();
  });
  it.each(["actor", "navigation", "form", "extra-shell"] as const)("rejects a public unknown response mixed with private authority or controls: %s", async projection => {
    const {consoleUnknownOutcome} = await vi.importActual<{consoleUnknownOutcome:(href:string)=>Response}>("../../src/admin/dashboard");
    const response = consoleUnknownOutcome("/admin?view=credentials&account=grok%3Acurrent");
    const doc = new DOMParser().parseFromString(await response.text(),"text/html");
    const extra = {actor:'<span data-console-actor-id="actor-A"></span>',navigation:'<nav data-member-nav="true"></nav>',form:'<form method="post" action="/admin/ui/keys"></form>',"extra-shell":'<div class="shell"><p>Former private content</p></div>'}[projection];
    doc.body.insertAdjacentHTML("beforeend",extra);
    const fetch = vi.fn().mockResolvedValue(new Response(doc.documentElement.outerHTML,{status:403,headers:{"Content-Type":"text/html"}})); vi.stubGlobal("fetch",fetch);
    const navigation = start(); const form = element("form",HTMLFormElement); submit(form);
    await vi.waitFor(() => expect(element("main",HTMLElement).dataset.dashboardMutationBlocked).toBe("true"));
    expect(document.querySelector("[data-console-terminal-result]")).toBeNull(); expect(navigation.showMutationResult).not.toHaveBeenCalled();
    expect(location.pathname + location.search).toBe("/admin?view=access"); submit(form); expect(fetch).toHaveBeenCalledOnce();
  });
  it.each(["foreign-target", "different-link", "private-projection", "legacy-login"])("does not treat invalid unknown markup as an authoritative terminal: %s", async invalid => {
    const target = invalid === "foreign-target" ? "https://other.example.test/admin?view=credentials" : invalid === "legacy-login" ? "/login" : "/admin?view=credentials";
    const link = invalid === "different-link" ? "/admin?view=access" : target;
    const html = `<main id="content" data-console-terminal-result="unknown" data-console-next="${target}"><div data-console-recovery><h1>暂时无法确认</h1><p data-console-outcome="unknown">未知结果</p><a href="${link}">查看当前状态</a></div>${invalid === "private-projection" ? '<div class="shell">Old private projection</div>' : ''}</main>`;
    const fetch = vi.fn().mockResolvedValue(new Response(html,{status:403,headers:{"Content-Type":"text/html"}})); vi.stubGlobal("fetch",fetch);
    const navigation = start(); const form = element("form",HTMLFormElement); submit(form);
    await vi.waitFor(() => expect(element("main",HTMLElement).dataset.dashboardMutationBlocked).toBe("true"));
    expect(location.pathname + location.search).toBe("/admin?view=access");
    expect(document.querySelector("[data-console-terminal-result]")).toBeNull();
    expect(navigation.notice).toHaveBeenCalledWith(expect.stringContaining("尚未确认"), "error", expect.any(URL), "查看当前状态");
    submit(form); expect(fetch).toHaveBeenCalledOnce();
  });
});

it('does not apply a delayed mutation response after the document is discarded', async () => {
  let complete!: (response: Response) => void;
  const fetch = vi.fn().mockReturnValue(new Promise<Response>(done => {complete=done;})); vi.stubGlobal('fetch',fetch);
  const navigation = start(); submit(element('form',HTMLFormElement)); dispose?.();
  const notices = vi.mocked(navigation.notice).mock.calls.length;
  const result = dashboardHtml('access').replace('data-dashboard-view="access"','data-dashboard-view="access" data-dashboard-mutation="key_created"');
  complete(new Response(result,{headers:{'Content-Type':'text/html'}}));
  await new Promise(done => setTimeout(done,0));
  expect(navigation.showMutationResult).not.toHaveBeenCalled(); expect(navigation.notice).toHaveBeenCalledTimes(notices);
  expect(fetch).toHaveBeenCalledTimes(1);
});
