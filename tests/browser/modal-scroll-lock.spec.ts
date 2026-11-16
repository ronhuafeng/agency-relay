import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures";

// A modal surface must hold the document still under the unchanged product policy.
// Wrong: the lock's stylesheet is refused by the document policy, so the page behind
// the dialog keeps scrolling and the browser reports a violation. Equivalent correct
// implementations may lock either root element and may style the lock differently.
const violations = (page: Page) => page.evaluate(() => (window as unknown as {policyViolations: string[]}).policyViolations);
const documentLocked = (page: Page) => page.evaluate(() => [document.documentElement, document.body].some(element => getComputedStyle(element).overflowY === "hidden"));

test.use({viewport: {width: 1440, height: 900}});
test("modal menu and confirmation lock document scroll without a policy violation", async ({page, worker}) => {
  worker.seedAdminLayouts();
  await page.addInitScript(() => {
    const seen: string[] = []; (window as unknown as {policyViolations: string[]}).policyViolations = seen;
    document.addEventListener("securitypolicyviolation", event => { seen.push(event.effectiveDirective); });
  });
  await page.goto("/admin?view=credentials&account=codex%3Afixture-codex&range=30d&q=Synthetic");
  expect(await documentLocked(page)).toBe(false);

  await page.getByRole("button", {name: "账号菜单", exact: true}).click();
  await expect(page.getByRole("menu")).toBeVisible();
  await expect.poll(() => documentLocked(page)).toBe(true);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu")).toHaveCount(0);
  await expect.poll(() => documentLocked(page)).toBe(false);

  await page.locator('[data-account-detail="codex:fixture-codex"] [data-account-admission] form').getByRole("switch").click();
  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toBeVisible();
  await expect.poll(() => documentLocked(page)).toBe(true);
  await dialog.getByRole("button", {name: "取消", exact: true}).click();
  await expect(dialog).toHaveCount(0);
  await expect.poll(() => documentLocked(page)).toBe(false);

  expect(await violations(page)).toEqual([]);
  expect(worker.requests.every(request => request.method === "GET")).toBe(true);
});
