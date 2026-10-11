import { test, expect } from "./fixtures";

for (const width of [390, 1440]) test(`ordinary navigation loads a fresh server document at ${width}px`, async ({ page, worker }) => {
  await page.setViewportSize({ width, height: 954 });
  await page.goto("/admin?view=access");
  await expect(page.locator("#people-create-root [data-slot=collapsible-trigger]")).toHaveCount(2);
  if (width < 1000) await page.locator(".nav-toggle-label").click();
  await page.evaluate(() => { document.documentElement.dataset.navigationProbe = "people"; });

  const originalUrl = page.url();
  const held = worker.hold({ method: "GET", path: "/admin", view: "quotas" });
  const request = page.waitForRequest(request => request.isNavigationRequest()
    && request.frame() === page.mainFrame() && new URL(request.url()).searchParams.get("view") === "quotas");
  try {
    await page.getByRole("navigation", { name: "控制台页面" }).getByRole("link", { name: "额度政策", exact: true }).click({noWaitAfter: true});
    await held.entered;
    expect((await request).method()).toBe("GET");
    // The fixture has not sent response headers. DOM locator operations wait
    // for native navigation, so observe the uncommitted destination directly.
    expect(page.url()).toBe(originalUrl);
  } finally { held.release(); }
  await page.waitForURL(/view=quotas/, {waitUntil: "load"});
  await expect(page.locator('main[data-dashboard-view="quotas"]')).toBeVisible();
  await expect(page.locator("html")).not.toHaveAttribute("data-navigation-probe");
  if (width < 1000) {
    await expect(page.locator("#console-navigation-toggle")).not.toBeChecked();
    // The mobile rail keeps its label and account menu visible; the checkbox
    // controls only the page-link panel, not the navigation landmark itself.
    await expect(page.locator("#console-navigation-items")).toBeHidden();
    await page.locator(".nav-toggle-label").click();
    await expect(page.locator("#console-navigation-items")).toBeVisible();
  }
  await expect(page.getByRole("navigation", { name: "控制台页面" }).getByRole("link", { name: "额度政策", exact: true })).toHaveAttribute("aria-current", "page");
  await expect(page.locator(".nav-toggle-label strong")).toHaveText("额度政策");
  await expect(page.locator('[data-confirmation-fallback]:not([hidden])')).toHaveCount(0);

  await page.evaluate(() => { document.documentElement.dataset.navigationProbe = "quotas"; });
  await page.getByRole("navigation", { name: "控制台页面" }).getByRole("link", { name: "成员与服务", exact: true }).click();
  await page.waitForURL(/view=access/, {waitUntil: "load"});
  await expect(page.locator("html")).not.toHaveAttribute("data-navigation-probe");
  await expect(page.locator("#people-create-root [data-slot=collapsible-trigger]")).toHaveCount(2);
  await page.getByRole("button", { name: "账号菜单", exact: true }).click();
  await expect(page.locator(".account-menu-identity .identity-role")).toHaveText("管理员");
  await page.keyboard.press("Escape");
  expect(worker.requests.every(request => request.method === "GET")).toBe(true);
});

test("accepted same-actor role changes replace navigation with current authority", async ({ page, worker }) => {
  await page.goto("/admin?area=me&view=usage&range=7d");
  await expect(page.getByRole("button", { name: "账号菜单", exact: true })).toHaveAttribute("aria-haspopup", "menu");
  await page.evaluate(() => { document.documentElement.dataset.navigationProbe = "admin"; });
  await expect(page.locator("[data-console-role]")).toHaveAttribute("data-console-role", "admin");
  worker.setRole("admin", "user");
  await page.getByRole("navigation", { name: "UTC 时间范围" }).getByRole("link", { name: "30 天", exact: true }).click();
  await expect(page.locator("[data-console-role]")).toHaveAttribute("data-console-role", "user");
  await expect(page.locator("html")).not.toHaveAttribute("data-navigation-probe");
  await expect(page.locator("[data-console-actor-id]")).toHaveAttribute("data-console-actor-id", "admin");
  await expect(page.getByRole("navigation", { name: "成员页面" }).getByRole("link", { name: "组织管理", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "账号菜单", exact: true }).click();
  await expect(page.locator(".account-menu-identity .identity-role")).toHaveText("成员");
  expect(worker.requests.every(request => request.method === "GET")).toBe(true);
});
