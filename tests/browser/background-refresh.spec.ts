import { test, expect, openMemberCreate, openKeyEditor } from "./fixtures";
import { NOW } from "./worker";

test('quiet reads retain unchanged content and apply changed SQL data without moving focus or scroll', async ({page, worker}) => {
  await page.clock.install({time: new Date(NOW)});
  await page.setViewportSize({width: 1200, height: 420});
  worker.seedUsageTrends();
  await page.goto('/admin?view=usage&range=7d');
  const root = await page.locator('main#content').elementHandle();
  await page.locator('main#content').focus();
  await page.evaluate(() => scrollTo(0, 120));
  const scroll = await page.evaluate(() => scrollY);
  expect(scroll).toBeGreaterThan(0);
  const reads = () => worker.requests.filter(request => request.method === 'GET' && request.view === 'usage').length;
  const before = reads();
  worker.advanceClock(300000);
  await page.clock.fastForward(300000);
  await expect.poll(reads).toBeGreaterThan(before);
  expect(await root!.evaluate(node => node === document.querySelector('main#content'))).toBe(true);
  expect(await page.locator('[data-console-status]').isVisible()).toBe(false);

  worker.recordObservedRequest();
  const unchangedRevision = await page.locator('main').getAttribute('data-console-revision');
  worker.advanceClock(300000);
  await page.clock.fastForward(300000);
  await expect.poll(() => page.locator('main').getAttribute('data-console-revision')).not.toBe(unchangedRevision);
  await expect(page.locator('[data-trend-plan="grok.production.responses"] .usage-metrics')).toContainText('Requests5');
  expect(await root!.evaluate(node => node.isConnected)).toBe(false);
  await expect(page.locator('main#content')).toBeFocused();
  expect(await page.evaluate(() => scrollY)).toBe(scroll);
  expect(worker.requests.every(request => request.method === 'GET')).toBe(true);
});

test('changed ledger data waits while its inline table is open', async ({page, worker}) => {
  await page.clock.install({time: new Date(NOW)});
  worker.seedUsageTrends();
  await page.goto('/admin?view=usage&range=7d');
  const disclosure = page.locator('[data-trend-plan="grok.production.responses"] .usage-data-trigger');
  await disclosure.click();
  await page.locator('.usage-series-head h3').first().evaluate(node => { (node as HTMLElement).tabIndex = -1; (node as HTMLElement).focus(); });
  const revision = await page.locator('main').getAttribute('data-console-revision');
  worker.recordObservedRequest();
  worker.advanceClock(300000);
  await page.clock.fastForward(300000);
  await expect(page.locator('[data-console-status]')).toHaveText('有新数据');
  await expect(disclosure).toHaveAttribute('aria-expanded', 'true');
  expect(await page.locator('main').getAttribute('data-console-revision')).toBe(revision);
  await disclosure.click();
  await page.locator('main#content').focus();
  worker.advanceClock(300000);
  await page.clock.fastForward(300000);
  await expect(page.locator('[data-trend-plan="grok.production.responses"] .usage-metrics')).toContainText('Requests5');
  await expect(page.locator('[data-console-status]')).toBeHidden();
});

test.describe('member draft during background reads', () => {
  test.use({identity: 'member'});
  test('keeps the exact key and unfinished name when fresh lifecycle data arrives', async ({page, worker}) => {
    await page.clock.install({time: new Date(NOW)});
    await page.goto('/admin?area=me&view=keys&key=member-key');
    await openKeyEditor(page, 'rename');
    const name = page.locator('form[action$="/rename"] input[name=name]');
    await name.fill('Unfinished name');
    await page.locator('main#content').focus();
    const revision = await page.locator('main').getAttribute('data-console-revision');
    worker.expireKey('member-key');
    worker.advanceClock(120000);
    await page.clock.fastForward(120000);
    await expect(page.locator('[data-console-status]')).toHaveText('有新数据');
    await expect(name).toHaveValue('Unfinished name');
    await expect(page.locator('[data-key-detail="member-key"]')).toBeVisible();
    expect(await page.locator('main').getAttribute('data-console-revision')).toBe(revision);
    expect(worker.requests.every(request => request.method === 'GET')).toBe(true);
  });

  test('discards retained service content when a background read confirms lost management authority', async ({page, worker}) => {
    const id = await worker.seedDelegatedService();
    await page.clock.install({time: new Date(NOW)});
    await page.goto(`/me/service-accounts/${id}?view=keys`);
    await openMemberCreate(page);
    await page.locator('[data-member-key-create] input[name=name]').fill('Unfinished service key');
    worker.withdrawServiceOwner(id);
    worker.advanceClock(120000);
    await page.clock.fastForward(120000);
    await expect(page.locator('[data-console-recovery]')).toBeVisible();
    await expect(page.locator('[data-member-key-create]')).toHaveCount(0);
    expect(await page.locator('body').textContent()).not.toContain('Unfinished service key');
    expect(worker.requests.every(request => request.method === 'GET')).toBe(true);
  });
});
