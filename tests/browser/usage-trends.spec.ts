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
    await expect(page.locator('.usage-comparison table')).toHaveCount(0);
    await expect(page.getByRole('table', {name: '按人员和服务的用量'})).toHaveCount(1);
    const layout = page.getByRole('combobox', {name: '柱状图布局', exact: true});
    const bars = page.locator('[data-chart-day="2026-06-24"] .usage-chart-bar');
    await expect(layout).toHaveValue('grouped');
    expect(await bars.nth(0).getAttribute('x')).not.toBe(await bars.nth(1).getAttribute('x'));
    await layout.selectOption('stacked');
    expect(await bars.nth(0).getAttribute('x')).toBe(await bars.nth(1).getAttribute('x'));
    const stacked = await bars.evaluateAll(nodes => nodes.map(node => ({y: Number(node.getAttribute('y')), height: Number(node.getAttribute('height'))})));
    expect(stacked[1].y + stacked[1].height).toBeCloseTo(stacked[0].y);
    await layout.selectOption('grouped');
    await page.getByRole('combobox', {name: 'UTC 日期', exact: true}).selectOption('2026-06-23');
    await expect(page.locator('.usage-day-values')).toContainText('2026-06-23 UTC');
    await bars.nth(1).focus();
    await expect(page.locator('.usage-day-values')).toContainText('2026-06-24 UTC');
    await page.getByRole('combobox', {name: '比较指标', exact: true}).selectOption('tokens');
    await expect(page.locator('[data-chart-day="2026-06-23"] [data-daily-plan="codex.responses"] .usage-unknown-mark')).toHaveText('?');
    await expect(page.locator('[data-chart-day="2026-06-24"] [data-daily-plan="grok.production.responses"] .usage-chart-bar')).toHaveAttribute('aria-label', /已记录令牌：0/);
    await page.getByRole('combobox', {name: '比较指标', exact: true}).selectOption('count');
    const disclosure = page.locator('.usage-chart-description > summary');
    const data = page.locator('[data-text-plan="grok.production.responses"]');
    await expect(data).toBeHidden();
    await disclosure.focus(); await page.keyboard.press('Enter');
    await expect(data).toBeVisible();
    await expect(data.locator('dl>div')).toHaveCount(7);
    await expect(data.locator('dl>div').first()).toContainText('未记录 · 覆盖 0/0');
    await expect(data.locator('dl>div').last()).toContainText('未结束');
    // Usage fixture has no secrets or real authority on screen. Capture this allowlisted view only.
    await page.evaluate(() => scrollTo(0, 0));
    expect(await page.locator("[data-one-time-key],[data-created-token]").count()).toBe(0);
    const image = testInfo.outputPath(`usage-${scenario.identity}-${scenario.width}-${scenario.colorScheme}.png`);
    await page.screenshot({path: image, fullPage: true, animations: 'disabled'});
    await testInfo.attach('safe usage range', {path: image, contentType: 'image/png'});

    await disclosure.click();
    await expect(data).toBeHidden();
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
    await expect(page.locator('[data-trend-empty="all"]')).toBeVisible();
    await expect(page.locator('#usage-trends svg')).toHaveCount(0);
    expect(await page.locator('[data-trend-plan]').count()).toBe(0);
    await page.getByRole('link', {name: '查看 30 天', exact: true}).click();
    await expect(page.locator('[data-usage-range-label]')).toHaveAttribute('data-usage-range-label', '2026-05-26 至 2026-06-24 UTC');
    const query = 'A'.repeat(256);
    await page.getByRole('searchbox').fill(query);
    await page.getByRole('button', {name: '搜索', exact: true}).click();
    const exportHref = await page.getByRole('link', {name: '导出数据', exact: true}).getAttribute('href');
    expect(new URL(exportHref!, page.url()).searchParams.get('q')).toBe(query);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await page.locator('[data-trend-empty="all"]').getByRole('link', {name: '清除搜索', exact: true}).click();
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
    await page.locator('.usage-chart-description > summary').focus();
    await page.keyboard.press('Enter');
    const data = page.locator('[data-text-plan="grok.production.responses"]');
    await expect(data).toBeVisible();
    await expect(data.locator('dl>div')).toHaveCount(7);
    await expect(data.locator('dl>div').last()).toContainText('0 · 已记录 1/4 次请求');
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
