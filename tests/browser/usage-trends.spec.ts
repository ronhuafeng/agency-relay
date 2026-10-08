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
    await expect(page.locator('[data-trend-plan="codex.responses"]')).not.toContainText('OpenAI Standard');
    await expect(page.locator('[data-trend-plan="codex.responses"]')).not.toContainText('API 费率折算');
    await expect(page.locator('.usage-record[data-usage-plan="codex.responses"]').filter({hasText: 'gpt-5.5'}).locator('.usage-record-cost')).toContainText('$0.0007');
    if (scenario.identity === "member") expect((await page.locator('main').textContent())?.includes('other-private-model')).toBe(false);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await expect(page.locator('.usage-comparison table')).toHaveCount(0);
    await expect(page.getByRole('table', {name: '按人员和服务的用量'})).toHaveCount(1);
    await expect(page.getByRole('combobox', {name: '柱状图布局'})).toHaveCount(0);
    await expect(page.getByRole('combobox', {name: '比较指标'})).toHaveCount(0);
    const bars = page.locator('[data-chart-day="2026-06-24"] .usage-chart-bar');
    expect(await bars.nth(0).getAttribute('x')).not.toBe(await bars.nth(1).getAttribute('x'));
    await expect(page.locator('[data-chart-day="2026-06-23"] [data-daily-plan="codex.responses"] .usage-unknown-mark')).toHaveAttribute('aria-label', /未记录/);
    await expect(page.locator('.usage-bar-plot text')).toHaveCount(0);
    await expect(page.locator('.usage-day-tick')).toHaveCount(await page.locator('[data-chart-day]').count());
    await expect(page.locator('[data-chart-day="2026-06-24"] [data-daily-plan="grok.production.responses"] .usage-chart-bar')).toHaveAttribute('aria-label', /已记录令牌：0/);
    await expect(page.locator('.usage-chart-description')).toHaveCount(0);
    await expect(page.locator('[data-text-plan]')).toHaveCount(0);
    await expect(page.locator('.usage-trend-endpoints')).toHaveCount(0);
    // Usage fixture has no secrets or real authority on screen. Capture this allowlisted view only.
    await page.evaluate(() => scrollTo(0, 0));
    expect(await page.locator("[data-one-time-key],[data-created-token]").count()).toBe(0);
    const image = testInfo.outputPath(`usage-${scenario.identity}-${scenario.width}-${scenario.colorScheme}.png`);
    await page.screenshot({path: image, fullPage: true, animations: 'disabled'});
    await testInfo.attach('safe usage range', {path: image, contentType: 'image/png'});

    // The same server filter changes the complete chart, original details and export.
    await page.getByRole('searchbox').fill('gpt-5.5');
    await page.getByRole('button', {name: '搜索', exact: true}).click();
    await expect(page.locator('[data-trend-plan]')).toHaveCount(1);
    await expect(page.locator('.usage-record')).toHaveCount(1);
    await expect(page.locator('[data-trend-plan="codex.responses"] .usage-metrics')).toContainText('Requests2');
    const exportHref = await page.getByRole('link', {name: '导出数据', exact: true}).getAttribute('href');
    const exportResponse = await page.request.get(exportHref!);
    expect(exportResponse.status()).toBe(200);
    const exported = await exportResponse.json();
    const usage = scenario.identity === "member" ? exported.usage : exported;
    const mediaRows = scenario.identity === "member" ? exported.media.rows : exported.media_rows;
    expect(usage.totals.requests).toBe(2);
    expect(usage.rows).toHaveLength(1);
    expect(usage.rows[0].response_model).toBe('gpt-5.5');
    expect(mediaRows).toHaveLength(0);
    await page.getByRole('navigation', {name: 'UTC 时间范围'}).getByRole('link', {name: '30 天', exact: true}).click();
    await expect(page.getByRole('searchbox')).toHaveValue('gpt-5.5');
    await expect(page.locator('[data-trend-plan="codex.responses"] .usage-metrics')).toContainText('Requests2');
    await page.getByRole('link', {name: '清除', exact: true}).click();
    await page.getByRole('navigation', {name: 'UTC 时间范围'}).getByRole('link', {name: '7 天', exact: true}).click();

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
    await expect(page.locator('[data-trend-empty]')).toHaveCount(0);
    await expect(page.locator('#usage-trends .usage-bar-plot')).toBeVisible();
    await expect(page.locator('#usage-trends .usage-day-tick')).toHaveCount(7);
    expect(await page.locator('[data-trend-plan]').count()).toBe(0);
    await expect(page.getByText('至', {exact: false}).filter({hasText: 'UTC'})).toHaveCount(0);
    await page.getByRole('navigation', {name: 'UTC 时间范围'}).getByRole('link', {name: '30 天', exact: true}).click();
    await expect(page.locator('[data-usage-range-label]')).toHaveAttribute('data-usage-range-label', '2026-05-26 至 2026-06-24 UTC');
    const query = 'A'.repeat(256);
    await page.getByRole('searchbox').fill(query);
    await page.getByRole('button', {name: '搜索', exact: true}).click();
    const exportHref = await page.getByRole('link', {name: '导出数据', exact: true}).getAttribute('href');
    expect(new URL(exportHref!, page.url()).searchParams.get('q')).toBe(query);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await page.getByRole('link', {name: '清除', exact: true}).click();
    await expect(page.getByRole('searchbox')).toHaveValue('');
    expect(new URL(page.url()).searchParams.get('area')).toBe('me');
    expect(new URL(page.url()).searchParams.get('range')).toBe('30d');
    worker.failMemberRead('usage');
    await page.reload();
    expect(await page.locator('[data-trend-empty]').count()).toBe(0);
    expect((await page.locator('main').textContent())?.includes('暂时')).toBe(true);
  });
});

test.describe('native daily ledger', () => {
  test.use({identity: 'member', script: false, viewport: {width: 390, height: 900}});
  test('exposes scoped bars and complete daily text without script', async ({page, worker}) => {
    worker.seedUsageTrends();
    await page.goto('/admin?area=me&view=usage&range=7d');
    await expect(page.locator('.usage-bar-plot')).toBeVisible();
    await expect(page.locator('.usage-comparison table')).toHaveCount(0);
    await expect(page.locator('.usage-chart-description')).toHaveCount(0);
    await expect(page.locator('[data-trend-plan="grok.production.responses"] .usage-metrics')).toContainText('0 · 已记录 1/4 次请求');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
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
