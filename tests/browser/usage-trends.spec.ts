import { test, expect, expectAccountRole } from "./fixtures";

for (const scenario of [
  {identity: "member", width: 390, colorScheme: "dark"},
  {identity: "member", width: 1440, colorScheme: "light"},
  {identity: "admin", width: 390, colorScheme: "light"},
  {identity: "admin", width: 1440, colorScheme: "dark"}
] as const) test.describe(`usage ${scenario.identity} ${scenario.width}px ${scenario.colorScheme}`, () => {
  test.use({identity: scenario.identity, viewport: {width: scenario.width, height: 900}, colorScheme: scenario.colorScheme});
  test("keeps full-range evidence readable and handles reordered range reads and stale failures", async ({page, worker}, testInfo) => {
    worker.seedUsageTrends();
    const path = scenario.identity === "member" ? "/admin?area=me&view=usage&range=7d" : "/admin?view=usage&range=7d";
    await page.goto(path);
    await expect(page.getByRole('region', {name: '按日用量趋势'})).toBeVisible();
    expect(await page.locator('[data-trend-plan="grok.production.responses"] .usage-metrics').textContent()).toContain('0 · 已记录 1/4 次请求');
    expect(await page.locator('[data-trend-plan="codex.responses"] .usage-metrics').textContent()).toContain(`API 费率折算$0.00071 · 已记录 1/${scenario.identity === "member" ? 4 : 904} 次请求`);
    await expect(page.locator('[data-trend-plan="codex.responses"]')).toContainText('OpenAI Standard');
    await expect(page.locator('.usage-record[data-usage-plan="codex.responses"]').filter({hasText: 'gpt-5.5'}).locator('.usage-record-cost')).toContainText('$0.00071');
    if (scenario.identity === "member") expect((await page.locator('main').textContent())?.includes('other-private-model')).toBe(false);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    const disclosure = page.locator('[data-trend-plan="grok.production.responses"] .usage-data-trigger');
    await expect(disclosure).toHaveAttribute('aria-expanded', 'false');
    await disclosure.focus(); await page.keyboard.press('Enter');
    await expect(disclosure).toHaveAttribute('aria-expanded', 'true');
    const data = page.locator('[data-trend-plan="grok.production.responses"] .table-scroll');
    await expect(data).toBeVisible();
    // Continue the human keyboard path from the disclosure into its opened data region.
    await page.keyboard.press('Tab'); await expect(data).toBeFocused();
    await expect(data).toHaveAttribute('data-slot', 'table-container');
    if (scenario.width === 390) {
      expect(await data.evaluate(element => element.scrollWidth > element.clientWidth)).toBe(true);
      // One physical key dwell allows WebKit's native scroll animation to begin before keyup.
      await page.keyboard.press('ArrowRight', {delay: 80});
      await expect.poll(() => data.evaluate(element => element.scrollLeft)).toBeGreaterThan(0);
    }
    expect(await data.locator('tbody tr').count()).toBe(7);
    expect(await data.evaluate(element => !element.closest('[popover],[role=dialog],details'))).toBe(true);
    expect((await data.locator('tbody tr').first().textContent())?.includes('未记录 · 覆盖 0/0')).toBe(true);
    expect((await data.locator('tbody tr').last().textContent())?.includes('未结束')).toBe(true);
    // Usage fixture has no secrets or real authority on screen. Capture this allowlisted view only.
    await page.evaluate(() => scrollTo(0, 0));
    expect(await page.locator("[data-one-time-key],[data-created-token]").count()).toBe(0);
    const image = testInfo.outputPath(`usage-${scenario.identity}-${scenario.width}-${scenario.colorScheme}.png`);
    await page.screenshot({path: image, fullPage: true, animations: 'disabled'});
    await testInfo.attach('safe usage range', {path: image, contentType: 'image/png'});

    await disclosure.click();
    await expect(data).toBeHidden();
    const originalSummary = await page.locator('[data-trend-plan="grok.production.responses"] .usage-metrics').textContent();
    await page.locator('[data-visible-row-filter-input]').fill('no-rendered-record-matches');
    expect(await page.locator('[data-trend-plan="grok.production.responses"] .usage-metrics').textContent()).toBe(originalSummary);
    await page.locator('[data-visible-row-filter-input]').fill('');

    const stale = worker.hold({method: 'GET', path: '/admin', view: 'usage'});
    await page.getByRole('navigation', {name: 'UTC 时间范围'}).getByRole('link', {name: '30 天', exact: true}).click();
    await stale.entered;
    await page.getByRole('navigation', {name: 'UTC 时间范围'}).getByRole('link', {name: '7 天', exact: true}).click();
    await expect(page.locator('[data-dashboard-notice]')).toHaveAttribute('data-state', 'success');
    await expect(page.locator('[data-dashboard-notice]')).toBeHidden();
    stale.release();
    await expect(page.locator('[data-usage-range-label]')).toHaveAttribute('data-usage-range-label', '2026-06-18 至 2026-06-24 UTC');
    expect((await page.locator('main').textContent())?.includes('older-observation')).toBe(false);

    await page.getByRole('navigation', {name: 'UTC 时间范围'}).getByRole('link', {name: '30 天', exact: true}).click();
    await expect(page.locator('[data-usage-range-label]')).toHaveAttribute('data-usage-range-label', '2026-05-26 至 2026-06-24 UTC');
    expect((await page.locator('main').textContent())?.includes('older-observation')).toBe(true);
    await page.goBack();
    await expect(page.locator('[data-usage-range-label]')).toHaveAttribute('data-usage-range-label', '2026-06-18 至 2026-06-24 UTC');
    worker.failMemberRead('usage');
    await page.getByRole('navigation', {name: 'UTC 时间范围'}).getByRole('link', {name: '30 天', exact: true}).click();
    await expect(page.locator('[data-dashboard-notice]')).toContainText('仍显示旧范围 2026-06-18 至 2026-06-24 UTC');
    await expect(page.locator('[data-dashboard-notice]')).toContainText('已过期');
    await expect(page.locator('[data-usage-range-label]')).toHaveAttribute('data-usage-range-label', '2026-06-18 至 2026-06-24 UTC');
    worker.failMemberRead(null);
    await page.locator('[data-dashboard-notice]').getByRole('link', {name: '重试'}).click();
    await expect(page.locator('[data-usage-range-label]')).toHaveAttribute('data-usage-range-label', '2026-05-26 至 2026-06-24 UTC');
    expect(worker.requests.every(request => request.method === 'GET')).toBe(true);
  });
});

test.describe('personal native empty and unavailable usage', () => {
  test.use({identity: 'member', script: false, viewport: {width: 390, height: 900}});
  test('an empty ledger has one empty state; failed reads remain unavailable', async ({page, worker}) => {
    await page.goto('/admin?area=me&view=usage&range=7d');
    await expect(page.locator('[data-trend-empty="all"]')).toHaveText('此范围暂无用量记录');
    await expect(page.locator('#usage-trends svg')).toHaveCount(0);
    expect(await page.locator('[data-trend-plan]').count()).toBe(0);
    await page.getByRole('link', {name: '30 天', exact: true}).click();
    await expect(page.locator('[data-usage-range-label]')).toHaveAttribute('data-usage-range-label', '2026-05-26 至 2026-06-24 UTC');
    worker.failMemberRead('usage');
    await page.reload();
    expect(await page.locator('[data-trend-empty]').count()).toBe(0);
    expect((await page.locator('main').textContent())?.includes('暂时')).toBe(true);
  });
});

test.describe('native daily ledger', () => {
  test.use({identity: 'member', script: false, viewport: {width: 390, height: 900}});
  test('exposes the complete scoped table without script', async ({page, worker}) => {
    worker.seedUsageTrends();
    await page.goto('/admin?area=me&view=usage&range=7d');
    const table = page.locator('[data-trend-plan="grok.production.responses"] .table-scroll');
    await expect(table).toBeVisible();
    await expect(table.locator('tbody tr')).toHaveCount(7);
    await table.focus(); await expect(table).toBeFocused();
    await expect(table).toHaveAttribute('data-slot', 'table-container');
    expect(await table.evaluate(element => element.scrollWidth > element.clientWidth)).toBe(true);
    await page.keyboard.press('ArrowRight', {delay: 80});
    await expect.poll(() => table.evaluate(element => element.scrollLeft)).toBeGreaterThan(0);
    expect((await page.locator('main').textContent())?.includes('other-private-model')).toBe(false);
  });
});

test('personal Usage updates the identity header from the current server role after demotion', async ({page, worker}) => {
  await page.goto('/admin?area=me&view=usage&range=7d');
  await expectAccountRole(page,'管理员');
  const changed = await page.evaluate(async () => (await fetch('/admin/ui/users/admin/role', {
    method: 'POST', headers: {Accept: 'text/html'}, body: new URLSearchParams({role: 'user', confirm: '1'})
  })).ok);
  expect(changed).toBe(true);
  expect(worker.person('admin@example.test')?.role).toBe('user');
  await page.getByRole('navigation', {name: 'UTC 时间范围'}).getByRole('link', {name: '30 天', exact: true}).click();
  await expect(page.locator('[data-usage-range-label]')).toHaveAttribute('data-usage-range-label', '2026-05-26 至 2026-06-24 UTC');
  await expectAccountRole(page,'成员');
  await expect(page.getByRole('heading', {name: '我的用量', exact: true, level: 1})).toBeVisible();
  await expect(page.getByRole('link', {name: '组织管理', exact: true})).toHaveCount(0);
  expect(await page.locator('main').textContent()).not.toContain('other@example.test');
});
