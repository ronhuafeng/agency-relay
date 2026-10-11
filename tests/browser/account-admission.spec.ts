import type { Locator, Page, WebSocketRoute } from "@playwright/test";
import { test, expect } from "./fixtures";

const target = "/admin?view=credentials&account=codex%3Afixture-codex&range=30d&q=Synthetic";
const admission = (page: Page) => page.locator('[data-account-detail="codex:fixture-codex"] [data-account-admission]');
const admissionPosts = (requests: Array<{method: string; path: string}>) => requests.filter(request => request.method === "POST" && /\/codex-auths\/fixture-codex\/(pause|resume)$/.test(request.path));
async function confirm(page: Page, form: Locator, script: boolean, label: string) {
  if (!script) await form.locator('[data-confirmation-fallback] input').check();
  await form.getByRole("switch", {name: "ChatGPT · Synthetic Codex：允许新请求", exact: true}).click();
  if (script) await page.getByRole("alertdialog").getByRole("button", {name: label, exact: true}).click();
}

// Protect a reversible, exact-account operation through the real router and SQL.
// Wrong implementations that logout, change bindings, or optimistically flip on
// cancelled confirmation must fail; equivalent layout changes remain acceptable.
for (const script of [true, false]) test.describe(`account admission script ${script}`, () => {
  test.use({script, viewport: {width: script ? 1440 : 390, height: 900}, colorScheme: script ? "light" : "dark"});
  test("confirms pause and resume while preserving health, keys and stored defaults", async ({page, worker}) => {
    worker.seedAdminLayouts();
    const before = worker.codexAdmissionFacts(); const keys = worker.keyMetadata();
    await page.goto(target);
    const form = admission(page).locator("form");
    const toggle = form.getByRole("switch");
    if (script) {
      await expect(form.locator('[data-confirmation-fallback]')).toBeHidden();
      await toggle.click();
      const dialog = page.getByRole("alertdialog");
      await expect(dialog).toContainText("Synthetic Codex（fixture-codex）");
      await expect(dialog).toContainText("2 个未撤销密钥、2 项绑定");
      await expect(dialog).toContainText("已接受的请求或外部任务不会因此取消");
      await expect(dialog).toContainText("当前默认连接保留");
      await dialog.getByRole("button", {name:"取消",exact:true}).click();
      await expect(toggle).toBeFocused();
    } else {
      await toggle.click();
      await expect(form.locator('[data-confirmation-fallback] input')).not.toBeChecked();
    }
    await expect(toggle).toBeChecked();
    expect(admissionPosts(worker.requests)).toHaveLength(0);
    expect(worker.codexAdmissionFacts()).toEqual(before);

    await confirm(page, form, script, "暂停请求");
    await expect(page.locator('[data-mutation-flash="codex_admission"]')).toContainText("ChatGPT 请求已暂停");
    await expect(toggle).not.toBeChecked();
    await expect(form).toHaveAttribute("action", "/admin/ui/codex-auths/fixture-codex/resume");
    await expect(page.locator('[data-codex-admin] [data-credential-status]')).toHaveText("已连接");
    await expect(page.locator('[data-account-key="grok:fixture-codex"]')).not.toContainText("已暂停");
    const currentDefault = page.locator('#default-codex-account option[value="fixture-codex"]');
    await expect(currentDefault).toHaveJSProperty("selected", true);
    await expect(currentDefault).toBeDisabled();
    expect(worker.codexAdmissionFacts()).toEqual({...before,account:{...before.account,admission_state:"paused"}});
    expect(worker.keyMetadata()).toEqual(keys);
    const read = await page.request.get("/admin/codex-auths");
    expect(read.status()).toBe(200);
    expect((await read.json()).auths.find((account: {id:string}) => account.id === "fixture-codex")).toMatchObject({status:"active",admission_state:"paused"});

    await confirm(page, form, script, "恢复请求");
    await expect(page.locator('[data-mutation-flash="codex_admission"]')).toContainText("ChatGPT 请求准入已恢复");
    await expect(toggle).toBeChecked();
    expect(worker.codexAdmissionFacts()).toEqual(before); expect(worker.keyMetadata()).toEqual(keys);
    expect(admissionPosts(worker.requests).map(request=>request.path)).toEqual(["/admin/ui/codex-auths/fixture-codex/pause","/admin/ui/codex-auths/fixture-codex/resume"]);
    await page.locator('[data-mutation-flash="codex_admission"]').getByRole("link", {name:"查看当前连接",exact:true}).click();
    expect(new URL(page.url()).searchParams.get("account")).toBe("codex:fixture-codex");
    expect(await page.evaluate(()=>document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  });
});

test("an uncertain pause blocks replay and reconciles the exact committed account", async ({page, worker}) => {
  await page.goto(target);
  await expect(admission(page).locator('[data-confirmation-fallback]')).toBeHidden();
  const write = worker.hold({method:"POST",path:"/admin/ui/codex-auths/fixture-codex/pause"});
  try {
    await confirm(page, admission(page).locator("form"), true, "暂停请求");
    await write.entered;
    expect(worker.codexAdmissionFacts().account?.admission_state).toBe("paused");
    // The server has committed, but no success response has arrived in this page.
    await expect(admission(page).getByRole("switch")).toBeChecked();
    await page.getByRole("button", {name:"停止等待",exact:true}).click();
    await expect(page.locator('[data-dashboard-notice]')).toContainText("操作结果尚未确认");
    write.release();
    await expect(admission(page).getByRole("switch")).toBeDisabled();
    await admission(page).locator("form").evaluate(form=>(form as HTMLFormElement).requestSubmit());
    expect(admissionPosts(worker.requests)).toHaveLength(1);
    await page.locator('[data-dashboard-notice]').getByRole("link", {name:"查看当前状态",exact:true}).click();
    await expect(admission(page).getByRole("switch")).not.toBeChecked();
    await expect(admission(page).getByRole("switch")).toBeEnabled();
    await expect(admission(page).locator("form")).toHaveAttribute("action","/admin/ui/codex-auths/fixture-codex/resume");
    expect(admissionPosts(worker.requests)).toHaveLength(1);
  } finally { write.release(); }
});

test("a metadata pause invalidates the stale control and keeps the exact recovery target", async ({page, worker}) => {
  let channel: WebSocketRoute | undefined;
  await page.routeWebSocket("**/admin/events/credentials", socket=>{channel=socket;socket.send(JSON.stringify({type:"connected"}));});
  await page.goto(target);
  await expect.poll(()=>Boolean(channel)).toBe(true);
  await expect.poll(()=>worker.requests.filter(request=>request.path === "/admin/credential-status").length).toBeGreaterThan(0);
  const search = page.getByRole("searchbox", {name:"搜索账号",exact:true});
  await search.fill("unfinished search");
  worker.setBoundCredentialAdmission("paused"); channel!.send(JSON.stringify({type:"credentials-changed"}));
  await expect(admission(page).getByRole("switch")).toBeDisabled();
  await expect(admission(page).getByRole("switch")).not.toBeChecked();
  await expect(admission(page).locator('[data-credential-admission]')).toBeVisible();
  await expect(page.locator('[data-codex-admin] [data-credential-status]')).toHaveText("已连接");
  await expect(page.locator('[data-action="refresh-codex"] button')).toBeEnabled();
  await expect(admission(page).locator("form")).toHaveAttribute("action","/admin/ui/codex-auths/fixture-codex/pause");
  await expect(search).toHaveValue("unfinished search");
  await admission(page).getByRole("link", {name:"查看当前状态",exact:true}).click();
  await expect(admission(page).getByRole("switch")).not.toBeChecked();
  await expect(admission(page).getByRole("switch")).toBeEnabled();
  expect(new URL(page.url()).searchParams.get("q")).toBe("Synthetic");
  expect(new URL(page.url()).searchParams.get("range")).toBe("30d");
  expect(admissionPosts(worker.requests)).toHaveLength(0);
});
