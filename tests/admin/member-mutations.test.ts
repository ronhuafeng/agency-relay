/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initializeMemberMutations } from "../../src/admin/client/member-mutations";
import { browserLayout, element, submit } from "../support/browser-dom";
let dispose: (() => void) | null = null;
beforeEach(() => {
  history.replaceState(null, "", "/admin?view=keys");
  document.body.className = "console-simple";
  document.body.innerHTML = '<header class="site-header"><div class="identity" data-console-actor-id="actor-A" data-console-email="viewer@example.test" data-console-role="user"></div></header><nav data-member-nav><a href="/admin">首页</a></nav><main id="content"><form method="post" action="/me/ui/keys"><input name="name" value="测试密钥"><button type="submit">创建密钥</button></form></main>';
  browserLayout();
});
afterEach(() => {dispose?.(); dispose = null; vi.restoreAllMocks(); vi.unstubAllGlobals();});
const html = (body: string): string => `<!doctype html><html><head><title>我的密钥 · Mini</title></head><body class="console-simple"><header class="site-header"><div class="identity" data-console-actor-id="actor-A" data-console-email="viewer@example.test" data-console-role="user"></div></header><main id="content">${body}</main></body></html>`;
describe("member mutation outcomes", () => {
  it("shows the one-time result once and leaves a GET address for refresh", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(html('<article data-one-time-key><h1>密钥已创建</h1><a download="codex-config.toml">下载</a></article>'), {headers: {"Content-Type": "text/html"}}));
    vi.stubGlobal("fetch", fetch); dispose = initializeMemberMutations(); const form = element("form", HTMLFormElement); submit(form); submit(form);
    await vi.waitFor(() => expect(document.querySelector("[data-one-time-key]")).not.toBe(null)); expect(fetch).toHaveBeenCalledTimes(1); expect(location.pathname).toBe("/admin"); expect(location.search).toBe("?area=me&view=keys");
  });
  it("reads current state before reporting a revocation as complete", async () => {
    const form = element("form", HTMLFormElement); form.action = "/me/ui/keys/preview/revoke";
    const fetch = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({id: "preview", revoked: true}), {headers: {"Content-Type": "application/json"}}))
      .mockResolvedValueOnce(new Response(html('<div data-member-view="keys"><h1>我的密钥</h1><p>已撤销</p></div>'), {headers: {"Content-Type": "text/html"}}));
    vi.stubGlobal("fetch", fetch); dispose = initializeMemberMutations(); submit(form);
    await vi.waitFor(() => expect(element("[data-member-feedback]", HTMLElement).dataset.state).toBe("success")); expect(fetch).toHaveBeenCalledTimes(2); expect(fetch.mock.calls[1]?.[0]).toBe("/admin?area=me&view=keys"); expect(document.body.textContent).toContain("已撤销");
  });
  it("blocks a second write after an unknown network result", async () => {
    const form = element("form", HTMLFormElement); form.action = "/me/ui/keys/preview/revoke"; const fetch = vi.fn();
    element("main",HTMLElement).insertAdjacentHTML("beforeend",'<form id="another-write" method="post" action="/me/ui/keys/revoke-all"><button type="submit">撤销全部</button></form>');
    fetch.mockRejectedValue(new Error("lost"));
    vi.stubGlobal("fetch", fetch); dispose = initializeMemberMutations(); submit(form);
    await vi.waitFor(() => expect(element("[data-member-feedback]", HTMLElement).textContent).toContain("不要重复提交")); const count = fetch.mock.calls.length; submit(form); expect(fetch).toHaveBeenCalledTimes(count); expect(element('button[type=submit]', HTMLButtonElement).disabled).toBe(true);
    expect(element("main",HTMLElement).dataset.memberMutationBlocked).toBe("true");
    expect(element('#another-write button',HTMLButtonElement).disabled).toBe(true);
    expect(submit(element('#another-write',HTMLFormElement)).defaultPrevented).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(count);
  });
  it.each(["response", "network"])("retains confirmed revoke after list %s failure without replay", async failure => {
    const form = element("form", HTMLFormElement); form.action = "/me/ui/keys/preview/revoke";
    element("main",HTMLElement).insertAdjacentHTML("beforeend",'<form id="another-write" method="post" action="/me/ui/keys"><input name="name" value="Unsaved"><button type="submit">创建密钥</button></form>');
    const fetch = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({id:"preview",revoked:true}),{headers:{"Content-Type":"application/json"}}));
    if (failure === "response") fetch.mockResolvedValueOnce(new Response("",{status:503})); else fetch.mockRejectedValueOnce(new Error("lost read"));
    vi.stubGlobal("fetch",fetch); dispose=initializeMemberMutations(); submit(form);
    await vi.waitFor(()=>expect(document.body.textContent).toContain("密钥已撤销。 列表未刷新"));
    expect(document.body.textContent).not.toContain("操作结果尚未确认");
    expect(element("[data-member-feedback]",HTMLElement).dataset.state).toBe("success");
    submit(form); expect(fetch).toHaveBeenCalledTimes(2);
    expect(element("main",HTMLElement).dataset.memberMutationBlocked).toBe("true");
    expect(element('#another-write button',HTMLButtonElement).disabled).toBe(true);
    submit(element('#another-write',HTMLFormElement));expect(fetch).toHaveBeenCalledTimes(2);
  });
  it("handles native confirmed rename and preserves the exact GET return",async()=>{
    const form=element("form",HTMLFormElement);form.action="/me/ui/keys/preview/rename";
    const fetch=vi.fn().mockResolvedValueOnce(new Response(html('<section data-member-result="confirmed" data-member-return="/admin?area=me&view=keys&key=preview"><h1>操作已完成</h1><p>名称已保存。</p></section>'),{headers:{"Content-Type":"text/html"}})).mockResolvedValueOnce(new Response("",{status:503}));
    vi.stubGlobal("fetch",fetch);dispose=initializeMemberMutations();submit(form);
    await vi.waitFor(()=>expect(document.body.textContent).toContain("名称已保存。 列表未刷新"));
    expect(location.search).toBe("?area=me&view=keys&key=preview");expect(fetch).toHaveBeenCalledTimes(2);
  });
  it("recognizes an expired-session terminal rejection and removes private member content",async()=>{
    document.querySelector("nav")?.insertAdjacentHTML("beforebegin",'<div class="identity"><strong>private@example.test</strong></div>');
    vi.stubGlobal("fetch",vi.fn().mockResolvedValue(new Response(html('<section data-console-terminal-result data-console-next="/login"><h1>操作未执行</h1><p>登录已失效。</p><a href="/login">重新登录</a></section>'),{status:403,headers:{"Content-Type":"text/html"}})));
    dispose=initializeMemberMutations();submit(element("form",HTMLFormElement));
    await vi.waitFor(()=>expect(document.querySelector('[data-console-terminal-result]')).not.toBeNull());
    expect(document.querySelector('form,[data-member-nav],.identity')).toBeNull();
    expect(document.body.textContent).not.toContain('操作结果尚未确认');expect(location.pathname).toBe('/login');
  });
  it.each([
    [400,"missing_surface_grants","请至少选择一个客户端"],
    [404,"key_not_found","没有找到这个密钥"],
    [403,"user_inactive","这个账号已停用"]
  ])("explains a %i %s object rejection and keeps form values for correction", async (status, code, message) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({error: {message: "Rejected object operation", code}}), {status, headers: {"Content-Type": "application/json"}})));
    dispose = initializeMemberMutations(); submit(element("form", HTMLFormElement)); await vi.waitFor(() => expect(document.body.textContent).toContain(message)); expect(element("input", HTMLInputElement).value).toBe("测试密钥"); expect(element('button[type=submit]', HTMLButtonElement).disabled).toBe(false);
    expect(element("main",HTMLElement).dataset.memberMutationBlocked).not.toBe("true");
  });
  it.each([[404,"service_not_found"],[403,"admin_auth_required"],[403,"console_identity_changed"]])("discards the current scope on a known %i %s authority rejection",async(status,code)=>{
    const changed=vi.fn();document.addEventListener("console:actor-changed",changed,{once:true});
    const fetch=vi.fn().mockResolvedValue(new Response(JSON.stringify({error:{message:"Authority rejected",code}}),{status,headers:{"Content-Type":"application/json"}}));
    vi.stubGlobal("fetch",fetch);dispose=initializeMemberMutations();submit(element("form",HTMLFormElement));
    await vi.waitFor(()=>expect(changed).toHaveBeenCalledOnce());
    expect((changed.mock.calls[0]![0] as CustomEvent).detail).toEqual({outcome:"rejected",changed:false,reason:"authority"});
    expect(document.querySelector('[data-member-feedback][data-state="error"]')).toBeNull();
    expect(fetch).toHaveBeenCalledOnce();
  });
});

it('does not repopulate a departed page with a delayed one-time result', async () => {
  let complete!: (response: Response) => void;
  const fetch = vi.fn().mockReturnValue(new Promise<Response>(done => {complete=done;})); vi.stubGlobal('fetch',fetch);
  dispose = initializeMemberMutations(); submit(element('form',HTMLFormElement)); dispose();
  document.body.innerHTML = '<main id="content" data-console-recovery>Read again</main>';
  complete(new Response(html('<article data-one-time-key>INVALID-DISPLAY-ONLY</article>'), {headers:{'Content-Type':'text/html'}}));
  await new Promise(done => setTimeout(done,0));
  expect(document.querySelector('[data-one-time-key],[data-member-feedback]')).toBeNull();
  expect(document.querySelector('[data-console-recovery]')).not.toBeNull(); expect(fetch).toHaveBeenCalledTimes(1);
});
