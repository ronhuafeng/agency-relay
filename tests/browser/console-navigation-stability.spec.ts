import { test, expect } from "./fixtures";

for (const width of [390, 1440]) test(`navigation keeps its rail and paints enhanced controls at ${width}px`, async ({ page, worker }) => {
  await page.setViewportSize({ width, height: 954 });
  await page.goto("/admin?view=access");
  await expect(page.locator("#people-create-root [data-slot=collapsible-trigger]")).toHaveCount(2);
  if (width < 1000) await page.locator(".nav-toggle-label").click();
  const nav = await page.locator(".nav-rail").elementHandle();
  const account = await page.getByRole("button", { name: "账号菜单", exact: true }).elementHandle();
  const firstMain = await page.locator("main#content").elementHandle();

  await page.evaluate(() => {
    const rail = document.querySelector<HTMLElement>(".nav-rail")!;
    const initial = rail.getBoundingClientRect();
    const readings = { frames: 0, detachedRail: 0, shiftedRail: 0, fallbackFrames: 0, unenhancedFrames: 0 };
    let running = true;
    const read = () => {
      if (!running) return;
      readings.frames++;
      if (!rail.isConnected || document.querySelector(".nav-rail") !== rail) readings.detachedRail++;
      const rect = rail.getBoundingClientRect();
      if (Math.abs(rect.left - initial.left) > 1 || Math.abs(rect.width - initial.width) > 1) readings.shiftedRail++;
      if (Array.from(document.querySelectorAll<HTMLElement>("[data-confirmation-fallback]")).some(node => node.getClientRects().length)) readings.fallbackFrames++;
      const create = document.getElementById("people-create-root");
      if (create && create.querySelectorAll("[data-slot=collapsible-trigger]").length !== 2) readings.unenhancedFrames++;
      requestAnimationFrame(read);
    };
    requestAnimationFrame(read);
    (window as unknown as { finishNavigationReadings: () => typeof readings }).finishNavigationReadings = () => { running = false; return readings; };
  });

  const request = worker.hold({ method: "GET", path: "/admin", view: "quotas" });
  await page.getByRole("navigation", { name: "控制台页面" }).getByRole("link", { name: "额度政策", exact: true }).click();
  await request.entered;
  expect(await firstMain!.evaluate(node => node.isConnected)).toBe(true);
  request.release();
  await expect(page.locator('main[data-dashboard-view="quotas"]')).toHaveCount(1);
  await expect(page.getByRole("navigation", { name: "控制台页面" }).getByRole("link", { name: "额度政策", exact: true })).toHaveAttribute("aria-current", "page");
  expect(await nav!.evaluate(node => node === document.querySelector(".nav-rail"))).toBe(true);
  expect(await account!.evaluate(node => node.isConnected)).toBe(true);
  expect(await firstMain!.evaluate(node => node.isConnected)).toBe(false);
  await expect(page.locator(".nav-toggle-label strong")).toHaveText("额度政策");

  await page.getByRole("navigation", { name: "控制台页面" }).getByRole("link", { name: "成员与服务", exact: true }).click();
  await expect(page.locator("#people-create-root [data-slot=collapsible-trigger]")).toHaveCount(2);
  const readings = await page.evaluate(async () => {
    await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    return (window as unknown as { finishNavigationReadings: () => { frames: number; detachedRail: number; shiftedRail: number; fallbackFrames: number; unenhancedFrames: number } }).finishNavigationReadings();
  });
  expect(readings.frames).toBeGreaterThan(2);
  expect(readings.detachedRail).toBe(0);
  expect(readings.shiftedRail).toBe(0);
  expect(readings.fallbackFrames).toBe(0);
  expect(readings.unenhancedFrames).toBe(0);
  expect(await nav!.evaluate(node => node === document.querySelector(".nav-rail"))).toBe(true);
  expect(await account!.evaluate(node => node.isConnected)).toBe(true);
  await page.getByRole("button", { name: "账号菜单", exact: true }).click();
  await expect(page.locator(".account-menu-identity .identity-role")).toHaveText("管理员");
  await page.keyboard.press("Escape");
  expect(worker.requests.every(request => request.method === "GET")).toBe(true);
});

test("accepted same-actor role changes replace navigation with current authority", async ({ page, worker }) => {
  await page.goto("/admin?area=me&view=usage&range=7d");
  await expect(page.getByRole("button", { name: "账号菜单", exact: true })).toHaveAttribute("aria-haspopup", "menu");
  const nav = await page.locator(".nav-rail").elementHandle();
  await expect(page.locator("[data-console-role]")).toHaveAttribute("data-console-role", "admin");
  worker.setRole("admin", "user");
  await page.getByRole("navigation", { name: "UTC 时间范围" }).getByRole("link", { name: "30 天", exact: true }).click();
  await expect(page.locator("[data-console-role]")).toHaveAttribute("data-console-role", "user");
  expect(await nav!.evaluate(node => node.isConnected)).toBe(false);
  await expect(page.locator("[data-console-actor-id]")).toHaveAttribute("data-console-actor-id", "admin");
  await expect(page.getByRole("navigation", { name: "成员页面" }).getByRole("link", { name: "组织管理", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "账号菜单", exact: true }).click();
  await expect(page.locator(".account-menu-identity .identity-role")).toHaveText("成员");
  expect(worker.requests.every(request => request.method === "GET")).toBe(true);
});
