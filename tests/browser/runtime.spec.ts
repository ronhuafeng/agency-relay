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
test.describe("Feishu tool selection",()=>{
  test.use({runtime:"connectors",viewport:{width:390,height:900}});
  test("filters Feishu tools, reviews permissions and saves only the staged changes",async({page,worker})=>{
    const configured=await worker.runtimeFixture!.admin("lark-doc",{action:"configure"});
    expect(configured.status).toBe(200);
    await configured.body?.cancel();
    await page.goto("/admin?view=runtime&installation=lark-doc");
    await page.getByRole("link",{name:"工具权限",exact:true}).click();
    await expect(page.getByRole("link",{name:"工具权限",exact:true})).toHaveAttribute("aria-current","page");
    await expect(page.getByRole("region",{name:"服务配置",exact:true})).toHaveCount(0);
    const section=page.getByRole("region",{name:"飞书工具",exact:true});
    const search=section.getByRole("searchbox",{name:"搜索飞书工具"});
    const fetchDoc=section.getByRole("checkbox",{name:/读取文档正文/});
    const addComment=section.getByRole("checkbox",{name:/添加文档评论/});
    const calendar=section.getByRole("checkbox",{name:"calendar.v4.calendar.get",exact:true});
    const calendarList=section.getByRole("checkbox",{name:"calendar.v4.calendar.list",exact:true});
    const domain=section.getByRole("combobox",{name:"业务域"});
    const status=section.getByRole("combobox",{name:"工具状态"});
    const save=section.getByRole("button",{name:"保存工具设置",exact:true});
    await expect(domain).toHaveValue("hosted");
    await expect(save).toBeDisabled();
    await expect(section.getByRole("checkbox",{name:"批量启停本组 10 项"})).toHaveAttribute("aria-checked","mixed");
    await status.selectOption("enabled");
    await expect(addComment).toHaveCount(0);
    await status.selectOption("all");
    await search.fill("fetch-doc");
    await expect(fetchDoc).toBeChecked();
    await fetchDoc.uncheck();
    await section.getByRole("button",{name:"放弃更改"}).click();
    await expect(fetchDoc).toBeChecked();
    await expect(save).toBeDisabled();
    await fetchDoc.uncheck();
    await page.getByRole("link",{name:"成员权限",exact:true}).click();
    await expect(page.getByRole("table",{name:"成员工具权限"})).toBeVisible();
    await page.getByRole("link",{name:"工具权限",exact:true}).click();
    await expect(search).toBeVisible();
    await expect(fetchDoc).not.toBeChecked();
    await search.fill("add-comments");
    await expect(addComment).not.toBeChecked();
    await addComment.check();
    await search.fill("calendar.v4.calendar.get");
    await expect(domain).toHaveValue("");
    await expect(section.getByText("calendar:calendar:readonly",{exact:true})).toHaveCount(0);
    await section.getByRole("button",{name:"calendar.v4.calendar.get的权限详情",exact:true}).click();
    await expect(section.getByText("calendar:calendar:readonly",{exact:true})).toBeVisible();
    await section.getByRole("checkbox",{name:"批量启停当前结果 1 项"}).check();
    await expect(calendar).toBeChecked();
    await search.fill("calendar.v4.calendar.list");
    await expect(calendarList).not.toBeChecked();
    await search.fill("unmatched-tool-fixture");
    await expect(section.getByRole("list",{name:"飞书工具列表"})).toHaveCount(0);
    await confirm(page,section.locator("form"),"保存工具设置");
    await expect(page.getByRole("status").filter({hasText:"工具服务已更新"})).toBeVisible();
    await page.reload();
    await search.fill("calendar.v4.calendar.get");
    await expect(calendar).toBeChecked();
    await search.fill("fetch-doc");
    await expect(fetchDoc).not.toBeChecked();
    await search.fill("add-comments");
    await expect(addComment).toBeChecked();
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
  });
});
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
    if(identity==="admin"){await expect(page.getByRole("region",{name:"Design 管理",exact:true})).toBeVisible();await expect(page.getByRole("textbox",{name:"服务名称",exact:true})).toHaveValue("Design");}
    else await expect(page.getByRole("heading",{name:"我的工具服务",exact:true})).toBeVisible();
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
    await page.getByRole("button",{name:"允许",exact:true}).click();
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
  await page.getByRole("link",{name:"成员权限",exact:true}).click();
  await expect(page.getByRole("link",{name:"工具权限",exact:true})).toHaveCount(0);
  const member=page.getByRole("table",{name:"成员工具权限"}).getByRole("row").filter({hasText:"other@example.test"});
  await member.getByRole("button",{name:"授予权限",exact:true}).click();
  const accessConfirmation=page.getByRole("alertdialog");
  await expect(accessConfirmation).toContainText("other@example.test");
  await expect(accessConfirmation).toContainText("Design");
  await expect(accessConfirmation).toContainText("https://design.example.test/google-stitch");
  await accessConfirmation.getByRole("button",{name:"取消",exact:true}).click();
  expect(await f.db.prepare("SELECT state FROM runtime_installation_access WHERE installation_id='design' AND user_id='other'").first()).toBeNull();
  await page.getByRole("link",{name:"服务配置",exact:true}).click();
  await page.getByRole("radio",{name:"同一上游账号",exact:true}).check();
  const form=page.locator('form:has(input[name="authority"][value="same"])');
  await form.locator('input[name="material"]').fill("synthetic-replacement-not-for-production");
  const held=worker.hold({method:"POST",path:"/admin/ui/runtime-installations/design"});
  let nativePost=false;
  page.on("request",request=>{if(request.method()==="POST"&&new URL(request.url()).pathname==="/admin/ui/runtime-installations/design")nativePost=request.isNavigationRequest();});
  try {
    await form.getByRole("button",{name:"更新凭据",exact:true}).click();
    const credentialConfirmation=page.getByRole("alertdialog");
    await expect(credentialConfirmation).toContainText("Design");
    await expect(credentialConfirmation).toContainText("https://design.example.test/google-stitch");
    await credentialConfirmation.getByRole("button",{name:"更新凭据",exact:true}).click();
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
  await expect(page.getByText("工具服务已更新。",{exact:true})).toBeVisible();
  const final=await f.db.prepare("SELECT phase,state,credential_ref IS NULL AS empty FROM runtime_installations WHERE id='design'").first();
  expect(final).toEqual({phase:"ready",state:"disabled",empty:1});
  expect(worker.requests.filter(r=>r.method==="POST"&&r.path==="/admin/ui/runtime-installations/design").length).toBe(2);
});

for (const script of [true,false]) test.describe(`Runtime workspace script ${script}`,()=>{
  test.use({identity:"admin",script,viewport:{width:script?1440:390,height:900},colorScheme:script?"light":"dark"});
  test("keeps credential authority choices explicit and usable without disclosures",async({page,worker})=>{
    await page.goto("/admin?view=runtime&installation=design");
    await expect(page.locator("main details")).toHaveCount(0);
    const same=page.locator('form:has(input[name="authority"][value="same"])');
    const rebind=page.locator('form:has(input[name="authority"][value="rebind"])');
    await expect(same).toBeVisible();await expect(rebind).toBeHidden();
    await page.getByRole("radio",{name:"更改请求头或账号",exact:true}).focus();
    await page.keyboard.press("Space");
    await expect(rebind).toBeVisible();await expect(same).toBeHidden();
    await expect(rebind.locator('input[name="material"]')).toHaveAttribute("type","password");
    await page.keyboard.press("ArrowLeft");
    await expect(page.getByRole("radio",{name:"同一上游账号",exact:true})).toBeChecked();
    await expect(same).toBeVisible();await expect(rebind).toBeHidden();
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
    if(script){
      const retire=page.getByRole("button",{name:"永久退役服务",exact:true});
      await retire.click();const dialog=page.getByRole("alertdialog");
      await expect(dialog).toContainText("不能重新启用");
      await dialog.getByRole("button",{name:"取消",exact:true}).click();
      await expect(retire).toBeFocused();
    }
    expect(worker.requests.filter(request=>request.method==="POST")).toHaveLength(0);
  });
});
