import { test, expect } from "./fixtures";

for (const script of [true, false]) test.describe(`refresh feedback with scripts ${script}`, () => {
test.use({ script });
test("a rejected Codex refresh shows reconnect status and the failure immediately", async ({ page, worker }) => {
  await page.goto("/admin?view=credentials&account=codex%3Afixture-codex&range=30d&q=Synthetic");
  const account = page.locator('[data-mgmt-state="active"]');
  await expect(account).toBeVisible();
  worker.failCodexRefresh("reauth_required");
  await page.getByRole("button", { name: "刷新账号", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("重新连接");
  await expect(page.locator('[data-mgmt-state="reauth_required"]')).toBeVisible();
  await expect(page.getByRole("button", { name: "刷新账号", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "重新连接", exact: true })).toBeVisible();
  // Native POST keeps its action address; the rendered page owns the read URL.
  const readUrl = new URL((await page.locator("main#content").getAttribute("data-dashboard-url"))!, page.url());
  expect(readUrl.searchParams.get("range")).toBe("30d");
  expect(readUrl.searchParams.get("q")).toBe("Synthetic");
  expect(worker.requests.filter(request => request.method === "POST")).toHaveLength(1);
});

for (const failure of ["codex_token_refresh_failed", "missing_access_token"] as const) test(`a Codex ${failure} refresh failure retains the account and a definite failure result`, async ({ page, worker }) => {
  await page.goto("/admin?view=credentials&account=codex%3Afixture-codex");
  worker.failCodexRefresh(failure);
  const response = page.waitForResponse(response => response.url().includes("/admin/ui/codex-auths/fixture-codex/refresh") && response.request().method() === "POST");
  await page.getByRole("button", { name: "刷新账号", exact: true }).click();
  expect((await response).headers()["content-type"]).toContain("text/html");
  await expect(page.getByRole("alert")).toContainText("刷新账号失败");
  await expect(page.locator('[data-mgmt-state="active"]')).toBeVisible();
  await expect(page.getByRole("button", { name: "刷新账号", exact: true })).toBeEnabled();
  expect(worker.requests.filter(request => request.method === "POST")).toHaveLength(1);
});
});
