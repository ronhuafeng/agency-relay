import { test, expect } from "./fixtures";
import { NOW } from "./worker";

test("an unknown management result blocks other mounted forms until a fresh authorized read", async ({ page, worker }) => {
  await page.goto("/admin?view=access&person=other");
  await expect(page.locator("[data-confirmation-fallback]:visible")).toHaveCount(0);
  const write = worker.hold({ method: "POST", path: "/admin/ui/users/other/status" });
  await page.getByRole("switch", { name: /启用账号/ }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "停用账号", exact: true }).click();
  await write.entered;
  expect(worker.status("other")).toBe("disabled");
  await page.getByRole("button", { name: "停止等待", exact: true }).click();
  await expect(page.locator("[data-dashboard-notice]")).toContainText("操作结果尚未确认");
  write.release();

  await page.getByRole("button", { name: "更改登录邮箱", exact: true }).click();
  const email = page.locator('form[action="/admin/ui/users/other/email"]');
  await email.getByRole("textbox", { name: "新的组织邮箱", exact: true }).fill("reviewed.other@example.test");
  await expect(email.getByRole("button", { name: "迁移邮箱", exact: true })).toBeDisabled();
  await email.evaluate(node => (node as HTMLFormElement).requestSubmit());
  expect(worker.requests.filter(request => request.method === "POST")).toHaveLength(1);
  expect(worker.person("other@example.test")?.id).toBe("other");

  await page.getByRole("link", { name: "查看当前状态", exact: true }).click();
  await expect(page.getByRole("switch", { name: /启用账号/ })).not.toBeChecked();
  await page.getByRole("button", { name: "更改登录邮箱", exact: true }).click();
  await expect(page.locator('form[action="/admin/ui/users/other/email"] button[type="submit"]')).toBeEnabled();
  expect(worker.requests.filter(request => request.method === "POST")).toHaveLength(1);
});

for (const change of ["demotion", "expiry"] as const) test(`a rejected quota save discards private administration after ${change}`, async ({ page, worker }) => {
  await page.goto("/admin?view=quotas");
  await expect(page.locator("[data-confirmation-fallback]:visible")).toHaveCount(0);
  const defaults = ["codex", "grok", "xai"].map(surface => worker.quotaDefault(surface));
  await page.locator('[data-quota-default="codex"]').getByRole("spinbutton").fill("321");
  if (change === "demotion") worker.setRole("admin", "user");
  else worker.expireSessions();
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "保存", exact: true }).click();
  await expect(page.locator("[data-console-recovery]")).toBeVisible();
  expect(await page.locator(".shell,.identity,[data-ui-props]").count()).toBe(0);
  expect(["codex", "grok", "xai"].map(surface => worker.quotaDefault(surface))).toEqual(defaults);
  expect(worker.requests.filter(request => request.method === "POST" && request.path === "/admin/ui/credit-defaults")).toHaveLength(1);
});

test("discarding an organization draft allows the next changed quiet read", async ({ page, worker }) => {
  await page.clock.install({ time: new Date(NOW) });
  await page.goto("/admin?view=quotas");
  const initial = String(worker.quotaDefault("codex"));
  await page.locator('[data-quota-default="codex"]').getByRole("spinbutton").fill("321");
  await page.locator("main#content").focus();
  worker.setQuotaDefault("grok", 90); worker.advanceClock(120000);
  await page.clock.fastForward(120000);
  await expect(page.locator("[data-console-status]")).toHaveText("有新数据");
  await page.getByRole("button", { name: "放弃修改", exact: true }).click();
  await expect(page.locator('[data-quota-default="codex"]').getByRole("spinbutton")).toHaveValue(initial);
  await expect(page.locator("[data-draft-state]")).toBeHidden();
  await page.locator("main#content").focus();
  worker.advanceClock(120000); await page.clock.fastForward(120000);
  await expect(page.locator('[data-quota-default="grok"]').getByRole("spinbutton")).toHaveValue("90");
  await expect(page.locator("[data-console-status]")).toBeHidden();
  expect(worker.requests.every(request => request.method === "GET")).toBe(true);
});
