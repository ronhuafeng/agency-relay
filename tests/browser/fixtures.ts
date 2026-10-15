import { test as base, expect, type BrowserContext, type Locator, type Page } from "@playwright/test";
import { NOW, ORIGIN, startConsoleWorker, type ConsoleWorker, type Identity } from "./worker";

export const test = base.extend<{ worker: ConsoleWorker; identity: Identity; script: boolean; runtime: boolean }>({
  identity: ["admin", { option: true }],
  script: [true, { option: true }],
  runtime: [false,{option:true}],
  worker: async ({runtime}, use) => {
    const worker = await startConsoleWorker({runtime});
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
      addEventListener("pagehide", event => {
        if (event.isTrusted) (window as unknown as { pageShowObserved: boolean }).pageShowObserved = false;
      });
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
/** Explicitly leave an unresolved write for its native read-only recovery. */
export async function acceptUnknownOutcomeRead(page: Page, link: Locator): Promise<void> {
  await expect(page.locator('main#content')).toHaveAttribute('data-console-outcome', 'unknown');
  const confirmation = page.waitForEvent('dialog', {timeout:5000}).then(async dialog => {
    const type = dialog.type();
    await test.step('accept unresolved-write departure for recovery', () => dialog.accept(), {timeout:5000});
    expect(type).toBe('beforeunload');
  });
  const click = link.click({timeout:5000});
  const settled = await Promise.allSettled([confirmation, click]);
  const failures = settled.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
  if (failures.length) throw new AggregateError(failures, 'Unknown-outcome recovery requires confirmed native departure');
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
  // Native details owns this state both before and after hydration.
  if (!await trigger.evaluate(node => node.closest('details')?.open)) await trigger.click();
  await expect(trigger.locator('xpath=parent::details')).toHaveAttribute('open', '');
}
export { expect };

export async function openNativeConfirmation(form: Locator): Promise<void> {
  await form.getByRole('button',{name:'操作影响',exact:true}).click();
  await expect(form.locator('[data-confirmation-fallback]').getByRole('checkbox')).toBeVisible();
}

// A native history traversal may return a fresh response or a scrubbed BFCache
// document. Both require a current authorized GET before asserting task content.
export async function reopenRestoredConsolePage(page: Page, target: string): Promise<void> {
  await expect.poll(() => page.evaluate(() => (window as unknown as {pageShowObserved?: boolean}).pageShowObserved === true)).toBe(true);
  if (!await page.evaluate(() => (window as unknown as {restoredFromCache?: boolean}).restoredFromCache === true)) return;
  await expect(page.locator('[data-console-recovery]')).toBeVisible();
  expect(await page.locator('.shell,.identity,[data-ui-props],[data-one-time-key],[data-created-token]').count()).toBe(0);
  const url = new URL(target, page.url());
  const reopen = page.getByRole('link', {name:'查看当前页面',exact:true});
  await expect(reopen).toHaveAttribute('href', url.pathname + url.search + url.hash);
  await reopen.click();
  await page.waitForURL(url.href, {waitUntil:'load'});
}
