import { test as base, expect, type BrowserContext, type Page } from "@playwright/test";
import { NOW, ORIGIN, startConsoleWorker, type ConsoleWorker, type Identity } from "./worker";

export const test = base.extend<{ worker: ConsoleWorker; identity: Identity; script: boolean }>({
  identity: ["admin", { option: true }],
  script: [true, { option: true }],
  worker: async ({}, use) => {
    const worker = await startConsoleWorker();
    try { await use(worker); expect(worker.unexpected, "No fixture errors or business-network access").toEqual([]); }
    finally { await worker.close(); }
  },
  context: async ({ browser, worker, identity, script, viewport, colorScheme }, use) => {
    const context = await browser.newContext({
      baseURL: ORIGIN, proxy: { server: worker.proxy }, ignoreHTTPSErrors: true,
      locale: "zh-CN", timezoneId: "UTC", reducedMotion: "reduce", viewport,
      colorScheme, javaScriptEnabled: script, serviceWorkers: "block"
    });
    await authenticate(context, worker, identity);
    await context.addInitScript(() => {
      // Observe real browser lifecycle events; never synthesize pagehide/pageshow.
      (window as unknown as { restoredFromCache: boolean }).restoredFromCache = false;
      (window as unknown as { pageShowObserved: boolean }).pageShowObserved = false;
      addEventListener("pageshow", (event) => {
        if (!event.isTrusted) return;
        (window as unknown as { restoredFromCache: boolean }).restoredFromCache = (event as PageTransitionEvent).persisted;
        (window as unknown as { pageShowObserved: boolean }).pageShowObserved = true;
      });
    });
    try { await use(context); } finally { await context.close(); }
  },
  page: async ({ context }, use) => {
    const page = await context.newPage();
    await page.clock.setFixedTime(new Date(NOW));
    await use(page);
  }
});

export async function authenticate(context: BrowserContext, worker: ConsoleWorker, identity: Identity): Promise<void> {
  // Session values never enter a URL, test title, trace, storageState file or log.
  await context.addCookies([{ name: "__Host-mini-console", value: await worker.session(identity), url: ORIGIN, httpOnly: true, secure: true, sameSite: "Lax" }]);
}
export async function expectAccountRole(page: Page, role: string): Promise<void> {
  await page.getByRole('button', {name:'账号菜单',exact:true}).click();
  await expect(page.locator('.account-menu-identity .identity-role')).toHaveText(role);
  await page.keyboard.press('Escape');
}
export async function openMemberCreate(page: Page): Promise<void> {
  const trigger = page.locator('a[data-member-create-toggle]');
  await expect(trigger).toBeVisible();
  if (await trigger.getAttribute('aria-expanded') !== 'true') await trigger.click();
  await expect(page.locator('[data-member-key-create] input[name=name]')).toBeVisible();
}
export async function openKeyEditor(page: Page, task: 'rename' | 'replace'): Promise<void> {
  const detail = page.locator('[data-key-detail]:visible');
  const trigger = detail.getByRole('button', {name: task === 'rename' ? '重命名' : '更换密钥', exact: true});
  await expect(trigger).toBeVisible();
  if (await trigger.getAttribute('aria-expanded') !== 'true') await trigger.click();
}
export { expect };
