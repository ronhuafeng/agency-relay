import { test, expect } from './fixtures';

for (const identity of ['member', 'admin'] as const) {
  test.describe(`${identity} login return`, () => {
    test.use({identity});
    test('expired session retains exact target through Mini login and mocked IdP callback', async ({page, worker}) => {
      worker.expireSessions(); worker.loginAs(identity);
      const target = identity === 'member' ? '/admin?area=me&view=setup&key=member-key#content' : '/admin?view=access&person=other&range=30d#credits';
      await page.goto(target);
      await expect.poll(() => page.evaluate(() => location.pathname === '/login')).toBe(true);
      await page.getByRole('button', {name: '使用飞书继续'}).click({noWaitAfter: true});
      const selected = identity === 'member' ? '.member-setup-config' : '[data-person-detail]';
      await expect(page.locator(selected)).toBeVisible();
      if(identity==='member') await expect(page.locator('[data-setup-key],[data-key-detail]')).toHaveCount(0);
      expect(await page.evaluate(expected => {
        const desired = new URL(expected, location.origin);
        return location.pathname === desired.pathname && location.hash === desired.hash
          && [...desired.searchParams].every(([key,value]) => new URL(location.href).searchParams.get(key) === value);
      }, target)).toBe(true);
      expect(worker.requests.filter(request => request.path === '/login' && request.method === 'POST').length).toBe(1);
    });
  });
}

test.describe('personal and delegated usage login return', () => {
  test.use({identity:'member'});
  for (const context of ['personal','delegated'] as const) test(`expired ${context} range returns to the same authorized HTML owner`, async ({page,worker}) => {
    const service = context === 'delegated' ? await worker.seedDelegatedService() : null;
    worker.seedUsageTrends(service ?? 'member');
    worker.expireSessions(); worker.loginAs('member');
    const target = `${service ? `/me/service-accounts/${service}?view=usage` : '/admin?area=me&view=usage'}&range=30d#content`;
    await page.goto(target);
    await expect.poll(() => page.evaluate(() => location.pathname === '/login')).toBe(true);
    await page.getByRole('button',{name:'使用飞书继续'}).click({noWaitAfter:true});
    await expect(page.locator('[data-member-view=usage]')).toBeVisible();
    await expect(page).toHaveURL(new URL(target,page.url()).href);
    await expect(page.locator('[data-usage-range-label]')).toHaveAttribute('data-usage-range-label','2026-05-26 至 2026-06-24 UTC');
    if (service) await expect(page.locator('[data-service-id]')).toHaveAttribute('data-service-id',service);
    else await expect(page.locator('[data-service-id]')).toHaveCount(0);
    await page.getByRole('button', {name:'账号菜单',exact:true}).click();
    await expect(page.locator('.account-menu-identity strong')).toHaveText('member@example.test');
    await page.keyboard.press('Escape');
    expect(worker.requests.filter(request => request.path === '/login' && request.method === 'POST').length).toBe(1);
  });
});

for (const identity of ['admin', 'member'] as const) test.describe(`${identity} task-section login recovery`, () => {
  test.use({identity});
  test('foreground session expiry preserves the exact task object, query and section', async ({page,worker}) => {
    const service = identity === 'member' ? await worker.seedDelegatedService() : null;
    if (service) worker.seedSetupOverlap(service);
    const key = service ? `${service}-setup-new` : null;
    const target = service
      ? `/me/service-accounts/${service}?view=keys&key=${key}#member-key-inventory`
      : '/admin?view=access&range=30d&person=other&q=other#person-status';
    await page.goto(service ? target : target.split('#')[0]);
    await expect(page.locator('[data-confirmation-fallback]:visible')).toHaveCount(0);
    if (!service) await page.goto(target);
    await expect(page).toHaveURL(new URL(target,page.url()).href);
    worker.expireSessions(); worker.loginAs(identity);
    // Controlled foreground-handler trigger, not an OS-resume or BFCache claim.
    await page.evaluate(()=>document.dispatchEvent(new Event('visibilitychange')));
    const recovery=page.locator('[data-console-recovery]');
    await expect(recovery).toBeVisible();
    await expect(recovery.getByRole('link',{name:'重新登录',exact:true})).toHaveAttribute('href',`/login?${new URLSearchParams({return:target})}`);
    expect(await page.locator('.shell,.identity,[data-ui-props]').count()).toBe(0);
    await recovery.getByRole('link',{name:'重新登录',exact:true}).click();
    await page.getByRole('button',{name:'使用飞书继续'}).click({noWaitAfter:true});
    await expect(page).toHaveURL(new URL(target,page.url()).href);
    if(service) {
      await expect(page.locator('[data-service-id]')).toHaveAttribute('data-service-id',service);
      const visibleDetail=page.locator('[data-key-detail]:visible');
      await expect(visibleDetail).toHaveCount(1);
      await expect(visibleDetail).toHaveAttribute('data-key-detail',key!);
      await expect(page.locator(`[data-key-detail="${service}-setup-old"]`)).toBeHidden();
      await expect(page.locator('#member-key-inventory')).toBeVisible();
      await expect(page.locator('[data-key-id="member-key"]')).toHaveCount(0);
    } else {
      await expect(page.locator('[data-person-detail]')).toHaveAttribute('data-person-detail','other');
      await expect(page.locator('#person-status')).toBeVisible();
    }
    expect(worker.requests.filter(request=>request.method==='POST').map(request=>request.path)).toEqual(['/login']);
  });
});
