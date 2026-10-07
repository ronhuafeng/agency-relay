import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { release } from 'node:os';
import { test, expect, authenticate, openMemberCreate } from './fixtures';
import { ORIGIN } from './worker';

// These are the actual Noto CJK 2.004 TTC bytes, not the mutable OS package label.
const fonts = [
  ['Noto Sans CJK SC', 'b76b0433203017ca80401b2ee0dd69350349871c4b19d504c34dbdd80541690a'],
  ['Noto Sans CJK SC:weight=bold', 'faa5f3656a78b2e2d450d27fe8382c778bc2b6bb5ea29c986664a6a435056ceb']
];
// CI opts into its reproducible Linux inputs. Local layout and reachability
// checks run with the platform's fonts; they do not compare pixel baselines.
const referenceFonts = process.env.MINI_BROWSER_REFERENCE_FONTS === '1';

for (const scenario of [
  { width: 390, colorScheme: 'dark', identity: 'member', view: 'keys', subject: 'representative' },
  { width: 390, colorScheme: 'light', identity: 'member', view: 'setup&key=member-key', subject: 'key configuration' },
  { width: 1440, colorScheme: 'light', identity: 'admin', view: 'access', subject: 'representative' },
  { width: 390, colorScheme: 'dark', identity: 'admin', view: 'access&person=other', subject: 'person detail' },
  { width: 1440, colorScheme: 'light', identity: 'admin', view: 'access&person=other', subject: 'person detail' },
  { width: 1440, colorScheme: 'dark', identity: 'admin', view: 'surfaces', subject: 'routes' }
] as const) {
  test.describe(`safe ${scenario.subject} ${scenario.width}px ${scenario.colorScheme}`, () => {
    test.use({ viewport: { width: scenario.width, height: 900 }, colorScheme: scenario.colorScheme, identity: scenario.identity });
    test('production controls stay reachable without major horizontal overflow', async ({ page, worker }, testInfo) => {
      if (referenceFonts) {
        expect(process.platform, 'Linux reference font environment').toBe('linux');
        for (const [family, checksum] of fonts) {
          const path = execFileSync('fc-match', ['-f', '%{file}', family!], { encoding: 'utf8' });
          expect(createHash('sha256').update(readFileSync(path)).digest('hex'), `Pinned ${family} font`).toBe(checksum);
        }
      }
      await page.goto(`/admin?view=${scenario.view}`);
      await page.evaluate(() => document.fonts.ready);
      await expect.poll(() => page.locator('[data-one-time-key],[data-created-token]').count()).toBe(0);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
      if (scenario.subject === 'person detail') await page.getByRole('button', { name: '更改登录邮箱', exact: true }).click();
      else if (scenario.identity === 'member' && scenario.subject !== 'key configuration') await openMemberCreate(page);
      const control = scenario.subject === 'person detail'
        ? page.getByRole('textbox', { name: '新的组织邮箱' })
        : scenario.subject === 'key configuration' ? page.getByLabel('已有密钥')
        : scenario.subject === 'routes' ? page.getByRole('tab', { name: 'Codex', exact: true })
        : scenario.identity === 'member' ? page.getByRole('textbox', { name: '名称', exact: true }) : page.getByRole('searchbox', { name: '搜索邮箱、名称或 ID' });
      if (scenario.subject === 'person detail') {
        await expect(page.locator('[data-person-detail="other"]')).toBeVisible();
        await expect(control).toHaveValue('');
      }
      await control.scrollIntoViewIfNeeded();
      if (scenario.subject === 'routes') {
        await control.focus();
        await expect(control).toBeFocused();
        await control.press('ArrowRight');
        await expect(page.getByRole('tab', { name: 'Grok', exact: true })).toBeFocused();
        await expect(page.getByRole('tabpanel')).toHaveCount(1);
        await expect(page.getByRole('tabpanel')).toContainText('grok.trustedtunnel.app');
        await page.getByRole('tab', { name: 'Grok', exact: true }).press('ArrowLeft');
        await control.focus();
      } else await control.click();
      await expect(control).toBeFocused();
      const box = await control.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(scenario.width + 1);
      expect(box!.height).toBeGreaterThan(0);
      // Only this allowlisted, invalid-placeholder display fixture can emit pixels.
      // No snapshot baseline: semantic assertions guard the contract, images aid review.
      expect(worker.requests.every(request => request.method === 'GET')).toBe(true);
      expect(await page.locator('[data-one-time-key],[data-created-token]').count()).toBe(0);
      expect(await page.locator('[name="existing_key"]').evaluateAll(nodes => nodes.every(node => !(node as HTMLInputElement).value))).toBe(true);
      await page.evaluate(() => scrollTo(0, 0));
      const stem = `safe-${scenario.identity}-${scenario.subject.replaceAll(' ', '-')}-${scenario.width}-${scenario.colorScheme}`;
      const path = testInfo.outputPath(`${stem}.png`);
      await page.screenshot({ path, animations: 'disabled', fullPage: true });
      writeFileSync(testInfo.outputPath(`${stem}.json`), JSON.stringify({
        schema: 2, checkout_sha: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
        tracked_dirty: execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], { encoding: 'utf8' }).trim().length > 0,
        role: scenario.identity, scenario: scenario.subject, view: scenario.view,
        viewport: { width: scenario.width, height: 900 }, theme: scenario.colorScheme,
        browser: testInfo.project.name, capture: 'complete', image: `${stem}.png`,
        typography: {
          mode: referenceFonts ? 'linux-reference' : 'platform-system',
          platform: process.platform, os_release: release(),
          // The CSS declaration is not a claim about every resolved glyph font.
          declared_stack: await page.locator('body').evaluate(node => getComputedStyle(node).fontFamily)
        }
      }, null, 2) + '\n');
      await testInfo.attach('safe console representative', { path, contentType: 'image/png' });
    });
  });
}

test.describe('SSR and hydration parity', () => {
  test.use({ identity: 'member' });
  test('default expiry and allowed services survive production hydration', async ({ browser, page, worker }) => {
    const native = await browser.newContext({ baseURL: ORIGIN, proxy: { server: worker.proxy }, ignoreHTTPSErrors: true, javaScriptEnabled: false, locale: 'zh-CN', timezoneId: 'UTC' });
    try {
      await authenticate(native, worker, 'member');
      const plain = await native.newPage();
      await plain.goto('/admin?view=keys');
      const nativeExpiry = await plain.getByRole('combobox', { name: '有效期' }).inputValue();
      const nativeCodex = await plain.getByRole('checkbox', { name: 'Codex', exact: true }).isEnabled();
      const nativeGrok = await plain.getByRole('checkbox', { name: 'Grok', exact: true }).isEnabled();
      await page.goto('/admin?view=keys');
      await expect(page.locator('[data-confirmation-fallback]:visible')).toHaveCount(0);
      await openMemberCreate(page);
      await expect(page.getByRole('combobox', { name: '有效期' })).toHaveValue(nativeExpiry);
      expect(await page.getByRole('checkbox', { name: 'Codex', exact: true }).isEnabled()).toBe(nativeCodex);
      expect(await page.getByRole('checkbox', { name: 'Grok', exact: true }).isEnabled()).toBe(nativeGrok);
      expect(nativeCodex).toBe(true);
      expect(nativeGrok).toBe(false);
    } finally { await native.close(); }
  });
});
