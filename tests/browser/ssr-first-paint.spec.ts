import type { Page, Route } from '@playwright/test';
import { test, expect, authenticate } from './fixtures';

// Accept stable SSR and any equivalent enhancement implementation. Reject a
// desktop/mobile shell swap or expanded task/template/filter content disappearing
// after script arrival. No incidental DOM tree, class count or pixel baseline.
async function geometry(page: Page, scripted = true) {
  // Wait for parser/CSS ownership, not the held script or an elapsed delay.
  await page.waitForFunction(() => document.readyState !== 'loading'
    && [...document.querySelectorAll<HTMLLinkElement>('link[rel=stylesheet]')].every(link => link.sheet !== null));
  // The fixture uses installed system fonts, not asynchronous @font-face loads.
  // WebKit ties fonts.ready to document load, which this probe deliberately
  // withholds. Wait for painted frames after CSS rather than the held runtime.
  if (scripted) await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  return page.evaluate(() => {
    const box = (selector: string) => {
      const element = [...document.querySelectorAll(selector)].find(candidate => candidate.checkVisibility());
      if (!element) throw new Error('Required first-paint landmark missing');
      const rect = element.getBoundingClientRect();
      return { x: rect.x, y: rect.y + scrollY, width: rect.width, height: rect.height };
    };
    return { scrollY, scrollPaddingTop: getComputedStyle(document.documentElement).scrollPaddingTop, viewport: innerWidth, documentWidth: document.documentElement.scrollWidth,
      main: box('main#content'), rail: box('.nav-rail'),
      routes: [...document.querySelectorAll('.route-catalog [role=tabpanel]')].map(panel => ({state: panel.getAttribute('data-state'), visible: panel.checkVisibility(), targeted: Boolean(panel.querySelector(':target'))})),
      task: box('[data-person-detail], [data-task-help=configuration], .request-filters, .surface-host'),
      // Native disclosure bodies must begin collapsed, without requiring script.
      exposedClosedBodies: [...document.querySelectorAll('details:not([open]) > :not(summary)')]
        .filter(element => element.checkVisibility()).length };
  });
}
function valid(value: Awaited<ReturnType<typeof geometry>>) {
  expect(value.documentWidth).toBeLessThanOrEqual(value.viewport + 1);
  expect(value.main.width).toBeGreaterThan(0);
  expect(value.main.x).toBeGreaterThanOrEqual(-1);
  expect(value.main.x + value.main.width).toBeLessThanOrEqual(value.viewport + 1);
  expect(value.exposedClosedBodies).toBe(0);
  if (value.viewport >= 1000) expect(value.main.x).toBeGreaterThanOrEqual(value.rail.x + value.rail.width - 1);
  else expect(value.main.y).toBeGreaterThanOrEqual(value.rail.y + value.rail.height - 1);
}
for (const width of [390, 999, 1000, 1440]) test.describe(`SSR first paint ${width}px`, () => {
  test.use({ viewport: { width, height: 900 } });
  test('script arrival preserves shell and task geometry', async ({ page, context, worker }) => {
    worker.seedAdminLayouts();
    for (const [view, identity] of [['view=access&person=other', 'admin'], ['view=setup', 'admin'], ['view=audit', 'admin'], ['view=surfaces', 'admin'], ['view=surfaces#route-host-1-title', 'admin'], ['area=me&view=setup', 'member']] as const) {
      // Each first-paint case needs a new document. A fragment-only transition
      // within the previous page does not request another enhancement runtime.
      await page.goto('about:blank');
      await authenticate(context, worker, identity);
      let release!: () => void;
      let entered!: () => void;
      const arrival = new Promise<void>(resolve => { entered = resolve; });
      const barrier = new Promise<void>(resolve => { release = resolve; });
      const pending = new Set<Promise<void>>();
      const handler = (route: Route) => {
        if (route.request().resourceType() !== 'script') return route.continue();
        entered();
        const held = barrier.then(() => route.continue());
        pending.add(held); held.finally(() => pending.delete(held)).catch(() => {});
        return held;
      };
      await page.route('**/*', handler);
      let failure: unknown;
      try {
        await page.goto(`/admin?${view}`, { waitUntil: 'commit' });
        await arrival;
        // Native parsing and fragment selection must finish without downloading
        // the enhancement runtime. This is an event boundary, not a delay.
        await page.waitForLoadState('domcontentloaded');
        if (view.includes('#route-host-1-title')) await expect(page.locator(':target')).toHaveAttribute('id', 'route-host-1-title');
        await expect(page.locator('main#content')).toBeVisible();
        if (view.includes('view=setup')) await expect(page.getByRole('button', { name: '下载配置文件', exact: true })).toBeDisabled();
        const before = await geometry(page); valid(before);
        release();
        await page.waitForLoadState('load');
        if (view.includes('view=setup')) {
          // Native member navigation is already present in SSR. Only the enabled
          // client picker proves enhancement; download still needs an explicit client.
          await expect(page.getByRole('tab', {name:'Codex CLI',exact:true})).toBeEnabled();
        } else await page.waitForFunction(() => document.querySelector('#console-dialog-root') !== null
          && typeof history.state?.miniEntry === 'string');
        await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
        const after = await geometry(page); valid(after);
        expect(after.scrollPaddingTop, `${view} native and enhanced scroll inset agree`).toBe(before.scrollPaddingTop);
        for (const landmark of ['main', 'rail', 'task'] as const) for (const dimension of ['x', 'y', 'width', 'height'] as const)
          expect(Math.abs(after[landmark][dimension] - before[landmark][dimension]), `${view} ${landmark} ${dimension} stays stable; route panels ${JSON.stringify({before: {routes: before.routes, scrollY: before.scrollY, rail: before.rail}, after: {routes: after.routes, scrollY: after.scrollY, rail: after.rail}})}`).toBeLessThanOrEqual(1);
      } catch (error) { failure = error; } finally {
        release();
        const failures = (await Promise.allSettled([...pending])).flatMap(result => result.status === 'rejected' ? [result.reason] : []);
        try { await page.unroute('**/*', handler); } catch (error) { failures.push(error); }
        if (failure !== undefined) failures.unshift(failure);
        if (failures.length === 1) throw failures[0];
        if (failures.length) throw new AggregateError(failures, 'First-paint assertion and request cleanup failed');
      }
    }
    expect(worker.requests.every(request => request.method === 'GET')).toBe(true);
  });
  test.describe('without JavaScript', () => {
    test.use({ script: false });
    test('native task disclosure and GET navigation remain usable', async ({ page, worker }) => {
      await page.goto('/admin?view=access&person=other');
      valid(await geometry(page, false));
      const editor = page.getByRole('button', { name: '更改登录邮箱', exact: true });
      await editor.focus(); await page.keyboard.press('Enter');
      await expect(page.getByRole('textbox', { name: '新的组织邮箱' })).toBeVisible();
      await editor.press('Enter');
      await expect(page.getByRole('textbox', { name: '新的组织邮箱' })).toBeHidden();
      await page.goto('/admin?view=audit');
      const exact = page.getByRole('button', { name: '精确定位', exact: true });
      await exact.focus(); await exact.press('Enter');
      await expect(page.locator('input[name=audit_request]')).toBeVisible();
      await page.locator('input[name=audit_request]').fill('fixture-no-match');
      await page.getByRole('button', { name: '筛选请求', exact: true }).click();
      await page.waitForURL(/audit_request=fixture-no-match/);
      await expect(page.locator('input[name=audit_request]')).toHaveValue('fixture-no-match');
      valid(await geometry(page, false));
      expect(worker.requests.every(request => request.method === 'GET')).toBe(true);
    });
  });
});

test('critical stylesheet finishes before the enhancement runtime starts downloading', async ({ context, worker }) => {
  await authenticate(context, worker, 'admin');
  // The shared page fixture installs Playwright Clock, whose Performance stub
  // does not expose real resource entries. This probe owns an unmocked page.
  const page = await context.newPage();
  try {
    await page.goto('/admin?view=surfaces');
    const ordering = await page.evaluate(() => {
      const resources = performance.getEntriesByType('resource') as PerformanceResourceTiming[];
      const css = resources.find(entry => /\/admin\/console-[a-f0-9]+\.css$/.test(entry.name));
      const runtime = resources.find(entry => /\/admin\/console-[a-f0-9]+\.js$/.test(entry.name));
      return { cssEnd: css?.responseEnd, runtimeStart: runtime?.startTime };
    });
    expect(ordering.cssEnd).toBeGreaterThan(0);
    expect(ordering.runtimeStart).toBeGreaterThanOrEqual(ordering.cssEnd!);
  } finally { await page.close(); }
});

test('a failed stylesheet does not leave runtime startup waiting forever', async ({ page, context, worker }) => {
  await authenticate(context, worker, 'admin');
  await page.route('**/admin/console-*.css', route => route.abort('failed'));
  await page.goto('/admin?view=setup');
  await expect(page.getByRole('tab', {name:'Codex CLI',exact:true})).toBeEnabled();
});
