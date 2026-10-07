import {test, expect} from './fixtures';
import {ORIGIN} from './worker';

// Use the suite's normal pinned engines. Chromium headless-shell does not
// establish actual BFCache support; every native path is identified below.
for (const identity of ['member', 'admin'] as const) test.describe(`${identity} actual browser history re-entry`, () => {
  test.use({identity});

  test('Back uses current authority at the exact target without former private content or mutation replay', async ({page, worker, browserName}, testInfo) => {
    // Keep only protocol enum values, never frame URLs or document details.
    const notRestored: Array<{type: string; reason: string}> = [];
    if (browserName === 'chromium') {
      const session = await page.context().newCDPSession(page);
      await session.send('Page.enable');
      session.on('Page.backForwardCacheNotUsed', event => {
        notRestored.splice(0, notRestored.length, ...event.notRestoredExplanations.slice(0, 16).map(({type, reason}) => ({type, reason})));
      });
    }
    const target = identity === 'admin' ? '/admin?view=access&range=7d&person=other' : '/admin?area=me&view=keys&key=member-key';
    await page.goto(target);
    await expect(page.locator(identity === 'admin' ? '[data-person-detail]' : '[data-member-view=keys]')).toBeVisible();
    await expect(page.locator('[data-confirmation-fallback]:visible')).toHaveCount(0);
    await expect(page).toHaveURL(ORIGIN + target);
    // Invalid display-only marker exercises one-time removal with no usable key.
    await page.locator('main').evaluate(main => main.insertAdjacentHTML('beforeend', '<section data-one-time-key><span data-created-token>INVALID-DISPLAY-ONLY</span></section>'));
    await page.evaluate(() => {
      const observed = window as unknown as {originalHistoryDocument: boolean; pageShowObserved: boolean};
      observed.originalHistoryDocument = true;
      observed.pageShowObserved = false;
    });
    await page.getByRole('button', {name:'账号菜单',exact:true}).click();
    await page.getByRole('menuitem', {name: '退出登录', exact: true}).click();
    await page.waitForURL(ORIGIN + '/logout', {waitUntil: 'load'});
    await expect(page.getByRole('heading', {name: '退出', exact: true})).toBeVisible();
    if (identity === 'admin') worker.setRole('admin', 'user'); else worker.expireSessions();
    let targetReads = 0;
    let targetStatus: number | null = null;
    page.on('request', request => {
      if (request.isNavigationRequest() && request.frame() === page.mainFrame()
        && request.method() === 'GET' && request.url() === ORIGIN + target) targetReads++;
    });
    page.on('response', response => {
      const request = response.request();
      if (request.isNavigationRequest() && request.frame() === page.mainFrame()
        && request.method() === 'GET' && request.url() === ORIGIN + target) targetStatus = response.status();
    });
    await page.goBack({waitUntil: 'load'});
    await expect.poll(() => page.evaluate(() => (window as unknown as {pageShowObserved: boolean}).pageShowObserved)).toBe(true);
    const restored = await page.evaluate(() => (window as unknown as {restoredFromCache: boolean}).restoredFromCache);
    const originalDocument = await page.evaluate(() => (window as unknown as {originalHistoryDocument?: boolean}).originalHistoryDocument === true);
    if (restored) {
      expect(originalDocument).toBe(true);
      expect(targetReads).toBe(0);
      expect(await page.evaluate(() => !document.querySelector('[data-person-detail],[data-created-token],[data-one-time-key],.identity,.nav-rail,[data-ui-props]'))).toBe(true);
      await expect(page.locator('[data-console-recovery]')).toBeVisible();
      const reopen = page.getByRole('link', {name: '查看当前页面', exact: true});
      await expect(reopen).toHaveAttribute('href', target);
      testInfo.annotations.push({type: 'history-reentry', description: 'Actual persisted pageshow on the original production Mini document; cleared content and exact GET recovery required'});
      const loaded = page.waitForEvent('load');
      await reopen.click();
      await loaded;
    } else {
      expect(originalDocument).toBe(false);
      testInfo.annotations.push({type: 'history-reentry', description: `Fresh document after native Back; no actual BFCache restoration established. Native reasons: ${JSON.stringify(notRestored)}`});
    }
    expect(targetReads).toBeGreaterThan(0);
    // A fresh denied response can use the current member shell. It must contain
    // none of the former administrator detail or selected-key private content.
    expect(await page.evaluate(() => !document.querySelector('[data-person-detail],[data-created-token],[data-one-time-key],[data-dashboard-view="access"],[data-key-detail="member-key"]'))).toBe(true);
    if (identity === 'admin') {
      expect(targetStatus).toBe(404);
      await expect(page).toHaveURL(ORIGIN + target);
      await expect(page.getByRole('heading', {name: '没有这个页面', exact: true})).toBeVisible();
      await expect(page.locator('[data-console-actor-id]')).toHaveAttribute('data-console-actor-id', 'admin');
      await expect(page.locator('[data-console-role]')).toHaveAttribute('data-console-role', 'user');
    }
    else {
      expect(targetStatus).toBe(302);
      await expect.poll(() => page.evaluate(() => location.pathname === '/login')).toBe(true);
      expect(await page.evaluate(target => new URL(location.href).searchParams.get('return') === target, target)).toBe(true);
      expect(await page.locator('.identity,[data-member-nav],[data-ui-props]').count()).toBe(0);
    }
    expect(worker.requests.filter(request => request.method === 'POST').length).toBe(0);
    // Safe proof identity survives CI's list reporter without a raw report upload.
    console.info(`history-reentry browser=${browserName} identity=${identity} branch=${restored ? 'persisted' : 'fresh-document'}`);
  });
});
