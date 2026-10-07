import { createElement } from 'react';
import { randomUUID } from 'node:crypto';
import { renderToString } from 'react-dom/server';
import type { Page } from '@playwright/test';
import { build } from 'esbuild';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test, expect } from './fixtures';
import { ORIGIN, type Identity } from './worker';

// Deliberately invalid, display-only material. These tests never issue a key.
// Synthetic API outcomes prove the call/UI contract, not an OS clipboard write.
const displayValue = 'INVALID-DISPLAY-ONLY-' + 'long-placeholder-'.repeat(24);
let CopySecretIsland: typeof import('../../src/admin/ui/islands').CopySecretIsland;
let DisclosureIsland: typeof import('../../src/admin/ui/islands').DisclosureIsland;
let rendererDirectory: string;
test.beforeAll(async () => {
  // Match the native Worker fixture: compile actual production SSR instead of
  // Playwright's JSX component-test transform. No duplicate client implementation.
  mkdirSync('tmp', { recursive: true });
  rendererDirectory = mkdtempSync(join(process.cwd(), 'tmp/secret-renderer-'));
  const entry = join(rendererDirectory, 'islands.mjs');
  await build({ entryPoints: ['src/admin/ui/islands.tsx'], outfile: entry, bundle: true, platform: 'node', format: 'esm', packages: 'external',
    define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'silent' });
  ({ CopySecretIsland, DisclosureIsland } = await import(pathToFileURL(entry).href));
});
test.afterAll(() => { if (rendererDirectory) rmSync(rendererDirectory, { recursive: true, force: true }); });

type ClipboardMode = 'missing' | 'rejected' | 'throws' | 'unconfirmed' | 'resolved' | 'pending';

async function clipboardMode(page: Page, mode: ClipboardMode) {
  await page.addInitScript((mode) => {
    const state = { calls: 0, matched: false, resolve: () => {}, reject: () => {} };
    Object.assign(window, { copyContract: state });
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: mode === 'missing' ? undefined : {
      writeText(value: string) {
        ++state.calls;
        state.matched = value === document.querySelector('[data-created-token]')?.textContent;
        if (mode === 'throws') throw new DOMException('Clipboard blocked', 'NotAllowedError');
        if (mode === 'rejected') return Promise.reject(new DOMException('Clipboard blocked', 'NotAllowedError'));
        if (mode === 'unconfirmed') return undefined;
        if (mode === 'pending') return new Promise<void>((resolve, reject) => { state.resolve = resolve; state.reject = () => reject(new DOMException('Clipboard blocked', 'NotAllowedError')); });
        return Promise.resolve();
      }
    } });
  }, mode);
}

async function resultPage(page: Page, identity: Identity, token = displayValue) {
  await page.goto(identity === 'member' ? '/admin?view=keys' : '/admin?view=access');
  await expect(page.locator('[data-confirmation-fallback]:visible')).toHaveCount(0);
  const html = renderToString(createElement('section', { 'data-one-time-key': 'true', 'data-synthetic-secret': '', className: 'panel setup-package' },
    createElement('h2', null, '一次性密钥显示测试'),
    identity === 'member' ? createElement(CopySecretIsland, { control: { token } })
      : createElement(DisclosureIsland, { control: { id: 'one-time-secret', title: '手动复制密钥', token } })));
  await page.locator('main').evaluate((main, html) => {
    const before = document.createElement('div'); const after = document.createElement('div');
    // Ordinary flow content gives both engines genuine scroll room, without
    // disabling CSP or injecting a different stylesheet for the component.
    before.innerHTML = '<p>Display-only scroll context</p>'.repeat(15);
    after.innerHTML = '<p>Display-only scroll context</p>'.repeat(20);
    main.appendChild(before); main.insertAdjacentHTML('beforeend', html); main.appendChild(after);
  }, html);
  if (identity === 'admin') await page.getByRole('button', { name: '手动复制密钥', exact: true }).click();
  const copy = page.getByRole('button', { name: '复制密钥', exact: true });
  await expect(copy).toBeVisible(); await copy.scrollIntoViewIfNeeded();
  return page.locator('[data-synthetic-secret]');
}

async function selectionIsComplete(page: Page) {
  return page.evaluate(() => {
    const value = document.querySelector('[data-created-token]');
    return value !== null && document.activeElement === value && document.getSelection()?.toString() === value.textContent;
  });
}
async function noPersistence(page: Page) {
  expect(await page.evaluate(() => ![localStorage, sessionStorage].some(store => Object.values(store).some(value => String(value).includes('INVALID-DISPLAY-ONLY')))
    && !JSON.stringify(history.state).includes('INVALID-DISPLAY-ONLY') && !location.href.includes('INVALID-DISPLAY-ONLY'))).toBe(true);
  expect(await page.evaluate(async () => (await caches.keys()).length)).toBe(0);
}

for (const identity of ['member', 'admin'] as const) {
  test.describe(`${identity} shared one-time copy`, () => {
    test.use({ identity });
    for (const mode of ['missing', 'rejected', 'throws', 'unconfirmed'] as const) {
      test(`${mode}: honest failure, full keyboard selection and cancellation`, async ({ page, worker }) => {
        await clipboardMode(page, mode); const result = await resultPage(page, identity);
        const copy = result.getByRole('button', { name: '复制密钥', exact: true });
        await copy.focus(); const scroll = await page.evaluate(() => scrollY);
        await page.keyboard.press('Enter');
        await expect(result.getByRole('status')).toContainText('未能复制到剪贴板');
        await expect(result.getByRole('button', { name: '已复制', exact: true })).toHaveCount(0);
        await expect(copy).toBeFocused();
        expect(Math.abs(await page.evaluate(() => scrollY) - scroll)).toBeLessThanOrEqual(1);
        await page.keyboard.press('Tab');
        await expect(result.getByRole('button', { name: '选择密钥', exact: true })).toBeFocused();
        await page.keyboard.press('Enter');
        expect(await selectionIsComplete(page)).toBe(true);
        await expect(result.getByRole('status')).toContainText('已选择密钥，请手动复制');
        expect(Math.abs(await page.evaluate(() => scrollY) - scroll)).toBeLessThanOrEqual(1);
        await page.keyboard.press('Escape');
        await expect(result.getByRole('button', { name: '选择密钥', exact: true })).toBeFocused();
        expect(await page.evaluate(() => getSelection()?.toString().length)).toBe(0);
        expect(await result.locator('textarea,input').count()).toBe(0);
        await noPersistence(page);
        expect(worker.requests.filter(request => request.method !== 'GET')).toHaveLength(0);
      });
    }

    test('resolved-call contract checks the exact displayed value, focus and scroll', async ({ page, worker }, testInfo) => {
      testInfo.annotations.push({ type: 'clipboard-evidence', description: 'Synthetic resolved API call verifies arguments and UI only; not an OS clipboard claim.' });
      await clipboardMode(page, 'resolved'); const result = await resultPage(page, identity);
      const copy = result.getByRole('button', { name: '复制密钥', exact: true });
      await copy.focus(); const scroll = await page.evaluate(() => scrollY);
      await page.keyboard.press('Enter');
      await expect(result.getByRole('button', { name: '已复制', exact: true })).toBeFocused();
      expect(await page.evaluate(() => {
        const state = (window as unknown as { copyContract: { calls: number; matched: boolean } }).copyContract;
        return { calls: state.calls, matched: state.matched };
      })).toEqual({ calls: 1, matched: true });
      expect(Math.abs(await page.evaluate(() => scrollY) - scroll)).toBeLessThanOrEqual(1);
      await noPersistence(page);
      expect(worker.totalKeys()).toBe(2);
    });

    test('pending results cannot overrule selection or revive a departed result', async ({ page, worker }) => {
      await clipboardMode(page, 'pending'); const result = await resultPage(page, identity);
      await result.getByRole('button', { name: '复制密钥', exact: true }).click();
      await expect(result.getByRole('button', { name: '正在复制…', exact: true })).toBeFocused();
      await page.keyboard.press('Enter');
      expect(await page.evaluate(() => (window as unknown as { copyContract: { calls: number } }).copyContract.calls)).toBe(1);
      await result.getByRole('button', { name: '选择密钥', exact: true }).click();
      await page.evaluate(() => (window as unknown as { copyContract: { resolve(): void } }).copyContract.resolve());
      await expect(result.getByRole('status')).toContainText('已选择密钥，请手动复制');
      expect(await selectionIsComplete(page)).toBe(true);
      await result.getByRole('button', { name: '复制密钥', exact: true }).click();
      // Admin enhanced navigation retains the same document, so its delayed
      // completion can actually run after the old result has been unmounted.
      const returnUrl = page.url();
      const navigation = page.getByRole('navigation', { name: identity === 'admin' ? '控制台页面' : '成员页面' });
      await navigation.getByRole('link', { name: identity === 'admin' ? '额度政策' : '我的额度', exact: true }).click();
      if (identity === 'member') {
        await page.waitForURL(`${ORIGIN}/admin?area=me&view=quota`, { waitUntil: 'load' });
        await expect(page.getByRole('heading', { name: '我的额度', exact: true })).toBeVisible();
      }
      await expect.poll(() => page.locator('[data-created-token]').count()).toBe(0);
      if (identity === 'admin') await page.evaluate(() => (window as unknown as { copyContract: { resolve(): void } }).copyContract.resolve());
      await page.goBack();
      if (identity === 'member') {
        await page.waitForURL(returnUrl, { waitUntil: 'load' });
        await expect.poll(() => page.getByRole('heading', { name: '我的密钥', exact: true }).isVisible()).toBe(true);
      }
      await expect.poll(() => page.locator('[data-created-token],[data-one-time-key]').count()).toBe(0);
      expect(await page.evaluate(() => getSelection()?.toString().includes('INVALID-DISPLAY-ONLY'))).toBe(false);
      await noPersistence(page);
      expect(worker.totalKeys()).toBe(2);
    });
  });
}

for (const identity of ['member', 'admin'] as const) test.describe(`${identity} native clipboard`, () => {
  test.use({ identity });
  test('real Chromium write and readback match the invalid display value', async ({ page, context, browserName }, testInfo) => {
    test.skip(browserName !== 'chromium', 'Only Chromium exposes the test-only clipboard read permission; WebKit uses the bounded call-contract tests.');
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: ORIGIN });
    const result = await resultPage(page, identity);
    await result.getByRole('button', { name: '复制密钥', exact: true }).click();
    await expect(result.getByRole('button', { name: '已复制', exact: true })).toBeFocused();
    expect(await page.evaluate(async () => await navigator.clipboard.readText() === document.querySelector('[data-created-token]')?.textContent)).toBe(true);
    testInfo.annotations.push({ type: 'clipboard-evidence', description: 'Native Chromium Clipboard API write and readback compared in-memory using an invalid display placeholder.' });
  });
  test('manual keyboard copy and paste work while the Clipboard API is unavailable', async ({ page }) => {
    // A unique invalid value prevents a stale clipboard from a preceding test
    // from falsely proving that the native copy shortcut copied the selection.
    const manualValue = `INVALID-DISPLAY-ONLY-MANUAL-${identity}-${randomUUID()}`;
    await clipboardMode(page, 'missing'); const result = await resultPage(page, identity, manualValue);
    await result.getByRole('button', { name: '选择密钥', exact: true }).click();
    expect(await selectionIsComplete(page)).toBe(true);
    await page.keyboard.press('ControlOrMeta+C');
    // Browser-native paste is an independent consumer of the OS clipboard. The
    // probe exists only in this test and receives an invalid display placeholder.
    await page.evaluate(() => {
      const probe = document.createElement('textarea'); probe.id = 'manual-paste-probe';
      document.body.appendChild(probe); probe.focus({ preventScroll: true });
    });
    await page.keyboard.press('ControlOrMeta+V');
    expect(await page.evaluate(() => (document.querySelector('#manual-paste-probe') as HTMLTextAreaElement).value
      === document.querySelector('[data-created-token]')?.textContent)).toBe(true);
    await page.evaluate(() => document.querySelector('#manual-paste-probe')?.remove());
    await expect(result.getByRole('status')).toContainText('已选择密钥，请手动复制');
  });
  test('native Chromium permission denial retains the manual selection path', async ({ page, context, browserName }) => {
    test.skip(browserName !== 'chromium', 'Chromium permission override is an additional native denial proof; both engines cover the rejected-call contract.');
    await context.grantPermissions([], { origin: ORIGIN });
    const result = await resultPage(page, identity);
    await result.getByRole('button', { name: '复制密钥', exact: true }).click();
    await expect(result.getByRole('status')).toContainText('未能复制到剪贴板');
    await result.getByRole('button', { name: '选择密钥', exact: true }).click();
    expect(await selectionIsComplete(page)).toBe(true);
  });
});

for (const identity of ['member', 'admin'] as const) {
  test.describe(`${identity} narrow touch selection`, () => {
    test.use({ identity, viewport: { width: 390, height: 900 } });
    test('touch selects the whole long value with reachable controls', async ({ browser, worker, browserName }, testInfo) => {
      // The common fixture intentionally has desktop input; this context changes
      // only touch capability and preserves its authenticated HTTPS transport.
      const context = await browser.newContext({ baseURL: ORIGIN, proxy: { server: worker.proxy }, ignoreHTTPSErrors: true,
        viewport: { width: 390, height: 900 }, hasTouch: true, locale: 'zh-CN', timezoneId: 'UTC', reducedMotion: 'reduce', serviceWorkers: 'block' });
      try {
        const { authenticate } = await import('./fixtures'); await authenticate(context, worker, identity);
        const page = await context.newPage(); await clipboardMode(page, 'missing');
        const result = await resultPage(page, identity);
        await result.getByRole('button', { name: '复制密钥', exact: true }).tap();
        await expect(result.getByRole('status')).toContainText('未能复制');
        const select = result.getByRole('button', { name: '选择密钥', exact: true });
        await select.scrollIntoViewIfNeeded(); const scroll = await page.evaluate(() => scrollY);
        await select.tap(); expect(await selectionIsComplete(page)).toBe(true);
        expect(Math.abs(await page.evaluate(() => scrollY) - scroll)).toBeLessThanOrEqual(1);
        expect(await result.getByRole('button').evaluateAll(nodes => nodes.every(node => { const box = node.getBoundingClientRect(); return box.width >= 44 && box.height >= 44; }))).toBe(true);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
        // The only plaintext in these screenshots is explicitly invalid and no
        // key-issuing request has occurred. Never copy this into valid-key tests.
        expect(worker.requests.filter(request => request.method !== 'GET')).toHaveLength(0);
        const path = testInfo.outputPath(`safe-invalid-${identity}-selection-${browserName}.png`);
        await page.screenshot({ path, animations: 'disabled' });
        await testInfo.attach('invalid display placeholder selection', { path, contentType: 'image/png' });
        await result.getByRole('button', { name: '取消选择', exact: true }).tap();
        expect(await page.evaluate(() => getSelection()?.toString().length)).toBe(0);
      } finally { await context.close(); }
    });
  });
}
