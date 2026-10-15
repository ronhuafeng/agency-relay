import type {Locator,Page} from "@playwright/test";
import {test,expect,openNativeConfirmation,authenticate} from "./fixtures";
import {authorizedTokens,pendingConsent,resourceRequest,tokenRequest} from "../runtime/oauth-fixture";
import {ORIGIN} from "./worker";
import {createConsoleSession} from "../../src/auth/console-session";

test.use({runtime:true});
async function confirm(page:Page,form:Locator,label:string,script=true) {
  if(!script){await openNativeConfirmation(form);await form.locator('[data-confirmation-fallback] input').check();}
  await form.getByRole("button",{name:label,exact:true}).click();
  if(script)await page.getByRole("alertdialog").getByRole("button",{name:label,exact:true}).click();
}
for(const script of [true,false])test.describe(`Runtime personal native form, script ${script}`,()=>{
  test.use({identity:"member",script,viewport:{width:script?1440:390,height:900}});
  test("URL setup and own revoke preserve other consent and member privacy",async({page,worker,context})=>{
    const f=worker.runtimeFixture!;
    const auth=await authorizedTokens(f);
    await page.goto("/admin?area=me&view=integrations");
    await page.getByRole("link",{name:"Design",exact:true}).click();
    await expect(page.getByRole("heading",{name:"Design",exact:true})).toBeVisible();
    expect(await page.locator('#runtime-detail pre').allTextContents()).toEqual([
      '[mcp_servers.design]\nurl = "https://design.example.test/google-stitch"\n',"codex mcp login design"
    ]);
    await expect(page.getByRole("table",{name:"已记录的客户端授权"})).toContainText("Synthetic client");
    const revoke=page.getByRole("table",{name:"已记录的客户端授权"}).locator("form");
    if(script){
      await revoke.getByRole("button",{name:"撤销授权",exact:true}).click();
      const dialog=page.getByRole("alertdialog");
      await expect(dialog).toContainText("Synthetic client");
      await expect(dialog).toContainText("https://design.example.test/google-stitch");
      await dialog.getByRole("button",{name:"取消",exact:true}).click();
    }
    await confirm(page,revoke,"撤销授权",script);
    await expect(page.getByRole("status").filter({hasText:"客户端授权已撤销"})).toBeVisible();
    const denied=await resourceRequest(f,auth.tokens.access_token);expect(denied.status).toBe(401);await denied.body?.cancel();
    expect(worker.requests.filter(r=>r.method==="POST"&&r.path.startsWith("/me/ui/runtime-clients/")).length).toBe(1);
    await authenticate(context,worker,"other");
    await page.goto("/admin?area=me&view=integrations");
    await expect(page.getByText("目前没有获准使用的工具服务。请联系管理员；重复登录不会增加权限。",{exact:true})).toBeVisible();
    const foreign=await page.goto("/admin?area=me&view=integrations&installation=design");expect(foreign?.status()).toBe(404);
    await expect(page.getByRole("heading",{name:"没有这个工具服务",exact:true})).toBeVisible();
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
  });
});

for(const identity of ["admin","member"] as const)for(const script of [true,false])test.describe(`Expired Runtime form, ${identity}, script ${script}`,()=>{
  test.use({identity,script,viewport:{width:390,height:900}});
  test("offers read-only login recovery and never replays the rejected operation",async({page,worker,context})=>{
    const f=worker.runtimeFixture!;
    const auth=identity==="member"?await authorizedTokens(f):null;
    const target=identity==="admin"?"/admin?view=runtime&installation=design":"/admin?area=me&view=integrations";
    await page.goto(target);
    if(script)await expect(page.locator('[data-confirmation-fallback]:not([hidden])')).toHaveCount(0);
    const form=identity==="admin"?page.locator('form:has(input[name="action"][value="disable"])'):
      page.getByRole("table",{name:"已记录的客户端授权"}).locator("form");
    await f.db.prepare("UPDATE console_sessions SET expires_at='2000-01-01T00:00:00.000Z' WHERE user_id=?").bind(identity).run();
    await confirm(page,form,identity==="admin"?"停用服务":"撤销授权",script);
    await expect(page.getByRole("heading",{name:"操作未执行",exact:true})).toBeVisible();
    const login=page.getByRole("link",{name:"重新登录",exact:true});
    const destination=new URL((await login.getAttribute("href"))!,ORIGIN);
    expect(destination.pathname).toBe("/login");
    expect(destination.searchParams.get("return")).toBe(target);
    expect((await f.db.prepare("SELECT state FROM runtime_installations WHERE id='design'").first())?.state).toBe("enabled");
    if(auth){const retained=await resourceRequest(f,auth.tokens.access_token);expect(retained.status).toBe(200);await retained.body?.cancel();}
    // The IdP itself is not under test. Restore a fresh native session, then use
    // the exact allowed GET destination encoded by the rejected form's recovery.
    const session=await createConsoleSession(f.env,{id:identity,email:`${identity}@example.test`,sessionEpoch:0});
    f.cookies.set(identity,`__Host-mini-console=${session}`);
    await authenticate(context,worker,identity);
    await page.goto(destination.searchParams.get("return")!);
    await expect(page.getByRole("heading",{name:identity==="admin"?"Design":"我的工具服务",exact:true})).toBeVisible();
    if(auth)await expect(page.getByRole("table",{name:"已记录的客户端授权"})).toContainText("Synthetic client");
    expect(worker.requests.filter(r=>r.method==="POST"&&(r.path.startsWith("/me/ui/runtime-clients/")||r.path==="/admin/ui/runtime-installations/design")).length).toBe(1);
  });
});

test("real consent Allow returns to the native client and records its own authorization",async({page,worker,context})=>{
  const f=worker.runtimeFixture!;
  const pending=await pendingConsent(f);
  const binding=pending.cookie.split("; ").find(value=>value.startsWith("__Host-runtime-transaction="))!;
  await authenticate(context,worker,"member");
  await context.addCookies([{name:"__Host-runtime-transaction",value:binding.slice(binding.indexOf("=")+1),url:ORIGIN,httpOnly:true,secure:true,sameSite:"Lax"}]);
  let exchanged=false;
  let callbackHasReferrer:boolean|null=null;
  const clearCallback=worker.acceptRuntimeCallback(async(url,hasReferrer)=>{
    callbackHasReferrer=hasReferrer;
    const code=url.searchParams.get("code");
    if(code){const response=await tokenRequest(f,{grant_type:"authorization_code",client_id:pending.clientId,code,redirect_uri:pending.query.get("redirect_uri")!,resource:pending.query.get("resource")!,code_verifier:pending.verifier});exchanged=response.status===200;await response.body?.cancel();}
  });
  try {
    await page.goto(pending.target.pathname);
    await expect(page.getByRole("heading",{name:"允许这个客户端使用服务？",exact:true})).toBeVisible();
    await expect(page.locator("main")).toContainText("使用此服务的全部工具");
    await page.getByRole("button",{name:"允许（Allow）",exact:true}).click();
    await expect(page.getByRole("heading",{name:"Design",exact:true})).toBeVisible();
    expect(exchanged).toBe(true);
    expect(callbackHasReferrer).toBe(false);
    await expect(page.getByRole("table",{name:"已记录的客户端授权"})).toContainText("Synthetic client");
  } finally {clearCallback();}
});

test("uncertain credential write clears input and recovers without repeating supply",async({page,worker})=>{
  const f=worker.runtimeFixture!;
  const failure=await f.expire("fail-write","true");await failure.body?.cancel();
  await page.goto("/admin?view=runtime&installation=design");
  const member=page.getByRole("table",{name:"成员工具权限"}).getByRole("row").filter({hasText:"other@example.test"});
  await member.getByRole("button",{name:"授予（不设期限）",exact:true}).click();
  const accessConfirmation=page.getByRole("alertdialog");
  await expect(accessConfirmation).toContainText("other@example.test");
  await expect(accessConfirmation).toContainText("Design");
  await expect(accessConfirmation).toContainText("https://design.example.test/google-stitch");
  await accessConfirmation.getByRole("button",{name:"取消",exact:true}).click();
  expect(await f.db.prepare("SELECT state FROM runtime_installation_access WHERE installation_id='design' AND user_id='other'").first()).toBeNull();
  await page.getByText("更换同一账号的凭据",{exact:true}).click();
  const form=page.locator('form:has(input[name="authority"][value="same"])');
  await form.locator('input[name="material"]').fill("synthetic-replacement-not-for-production");
  const held=worker.hold({method:"POST",path:"/admin/ui/runtime-installations/design"});
  let nativePost=false;
  page.on("request",request=>{if(request.method()==="POST"&&new URL(request.url()).pathname==="/admin/ui/runtime-installations/design")nativePost=request.isNavigationRequest();});
  try {
    await form.getByRole("button",{name:"更换同一账号凭据",exact:true}).click();
    const credentialConfirmation=page.getByRole("alertdialog");
    await expect(credentialConfirmation).toContainText("Design");
    await expect(credentialConfirmation).toContainText("https://design.example.test/google-stitch");
    await credentialConfirmation.getByRole("button",{name:"更换同一账号凭据",exact:true}).click();
    await held.entered;
    expect(nativePost).toBe(false);
    expect(await page.evaluate(()=>document.querySelector<HTMLInputElement>('input[name="material"]')?.value==="")).toBe(true);
  } finally {held.release();}
  await expect(page.locator('[data-console-recovery] [data-console-outcome="unknown"]')).toBeVisible();
  // The server's public terminal page disposed the private runtime. Its link
  // starts a new GET; unlike retained unknown forms it needs no beforeunload dialog.
  await page.getByRole("link",{name:"查看当前页面",exact:true}).click();
  await expect(page.getByText("凭据写入结果未确认。不要重新提交凭据。当前无法调用服务。",{exact:true})).toBeVisible();
  expect(await page.locator('input[name="material"]').count()).toBe(0);
  const state=await f.db.prepare("SELECT phase,state FROM runtime_installations WHERE id='design'").first();
  expect(state).toEqual({phase:"writing",state:"enabled"});
  const recover=page.locator('form:has(input[name="action"][value="recover"])');
  await confirm(page,recover,"放弃未确认凭据并停用");
  await expect(page.getByText("工具服务操作已完成。请核对当前状态；已执行的上游操作和资源不会因此撤回或迁移。",{exact:true})).toBeVisible();
  const final=await f.db.prepare("SELECT phase,state,credential_ref IS NULL AS empty FROM runtime_installations WHERE id='design'").first();
  expect(final).toEqual({phase:"ready",state:"disabled",empty:1});
  expect(worker.requests.filter(r=>r.method==="POST"&&r.path==="/admin/ui/runtime-installations/design").length).toBe(2);
});
