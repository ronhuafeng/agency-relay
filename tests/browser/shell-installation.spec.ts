import { writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { dashboardAppResponse } from '../../src/admin/app';
import { test, expect, authenticate, expectAccountRole } from './fixtures';
import { ORIGIN } from './worker';

for (const identity of ['member', 'admin'] as const) {
  test.describe(`${identity} shared shell`, () => {
    test.use({ identity });
    test('role home, stable navigation, narrow controls and exact re-entry', async ({ page, browserName }, testInfo) => {
      await page.goto('/');
      await expect(page.locator(identity === 'member' ? '[data-member-view="home"]' : '[data-dashboard-view="overview"]')).toBeVisible();
      await expectAccountRole(page,identity === 'member' ? '成员' : '管理员');
      const accountTrigger=page.getByRole('button', {name:'账号菜单',exact:true});
      await expect(accountTrigger).toBeFocused();
      const evidence: unknown[] = [];
      // Long but synthetic identity tests layout only, never changes server authority.
      for (const width of [320, 390, 768, 999, 1000, 1024, 1440, 1920, 2560]) {
        await page.setViewportSize({ width, height: 900 });
        await page.emulateMedia({ colorScheme: width < 1000 ? "dark" : "light" });
        const toggle = page.getByRole('checkbox', { name: '显示导航' });
        if (width < 1000 && identity === 'admin') {
          await expect(page.locator(".nav-toggle-label")).toBeVisible();
          // Real keyboard interaction with the native disclosure, not an injected click.
          await toggle.focus();
          if (await toggle.isChecked()) await page.keyboard.press('Space');
          await expect(page.locator('.console-navigation-items')).toBeHidden();
          await page.keyboard.press('Space');
          await expect(page.locator('.console-navigation-items')).toBeVisible();
          // macOS WebKit uses Option-Tab for links without changing OS/Safari settings.
          await page.keyboard.press(process.platform === 'darwin' && browserName === 'webkit' ? 'Alt+Tab' : 'Tab');
          await expect(page.locator('.console-navigation-items').getByRole('link').first()).toBeFocused();
        }
        if (width >= 1000 || identity === 'member') await expect(page.locator(".nav-toggle-label")).toBeHidden();
        if (identity === 'member') await expect(page.locator('.console-navigation-items')).toBeVisible();
        await page.getByRole('button', {name:'账号菜单',exact:true}).click();
        await page.locator('.account-menu-identity strong').evaluate(element => { element.textContent = 'long.member.display.name.for.shell.geometry@example.test'; });
        expect(await page.locator('.account-menu-identity').evaluate(element => element.getBoundingClientRect().right <= innerWidth + 1)).toBe(true);
        await page.keyboard.press('Escape');
        // Escape restores focus asynchronously. Finish that public interaction
        // before resizing and focusing the native navigation checkbox again.
        await expect(accountTrigger).toBeFocused();
        const links = await page.locator('.nav-rail a:visible').evaluateAll(elements => elements.map(element => {
          const box = element.getBoundingClientRect();
          return { width: box.width, height: box.height };
        }));
        expect(links.every(box => box.width >= 44 && box.height >= 44)).toBe(true);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
        evidence.push({ identity, cssViewport: width, zoom: 1, colorScheme: width < 1000 ? "dark" : "light", links });
        if (width === 390 || width === 1440) {
          if (width < 1000 && identity === 'admin') { await toggle.focus(); await page.keyboard.press('Space'); }
          await expect.poll(() => page.locator('[data-one-time-key],[data-created-token]').count()).toBe(0);
          await page.evaluate(() => document.fonts.ready);
          const path = testInfo.outputPath(`safe-shell-${identity}-${width}.png`);
          await page.screenshot({ path, animations: 'disabled' });
          await testInfo.attach(`safe ${identity} shell ${width}px`, { path, contentType: 'image/png' });
        }
      }
      const path = testInfo.outputPath('safe-shell-geometry.json');
      writeFileSync(path, JSON.stringify(evidence, null, 2));
      await testInfo.attach('shell geometry', { path, contentType: 'application/json' });
      await page.setViewportSize({ width: 390, height: 900 });
      if (identity === 'admin') {
        await page.getByRole('button', { name: '账号菜单', exact: true }).click();
        await page.getByRole('menuitem', { name: '我的空间', exact: true }).click();
        await expect(page).toHaveURL(/area=me&view=home/);
        await expect(page.locator('[data-member-view="home"]')).toBeVisible();
      }
      await page.getByRole('navigation', { name: '成员页面' }).getByRole('link', { name: '我的密钥' }).click();
      await expect(page).toHaveURL(/area=me&view=keys/);
      await page.reload();
      await expect(page.locator('[data-member-view="keys"]')).toBeVisible();
      await page.goBack();
      await expect(page.locator('[data-member-view="home"]')).toBeVisible();
    });
  });
}

test.describe('native member navigation without JavaScript', () => {
  test.use({ identity: 'member', script: false, viewport: { width: 320, height: 740 }, colorScheme: 'dark' });
  test('opens personal deep links and remains usable with enlarged text', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('navigation',{name:'成员页面'}).getByRole('link',{name:'我的额度'})).toBeVisible();
    await page.getByRole('navigation', { name: '成员页面' }).getByRole('link', { name: '我的额度' }).click();
    await expect(page).toHaveURL(/area=me&view=quota/);
    await expect(page.getByRole('heading', { name: '我的额度' })).toBeVisible();
    // CSS text magnification; not physical-device or browser-chrome zoom evidence.
    await page.evaluate(() => { document.documentElement.style.fontSize = '28px'; document.querySelectorAll<HTMLElement>('.nav-rail a,.nav-toggle-label,.identity').forEach(element => { element.style.fontSize = '28px'; }); });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await page.getByRole('link', { name: '我的用量' }).click();
    await expect(page.getByRole('heading', { name: '我的用量', exact: true, level: 1 })).toBeVisible();
  });
});

test('HTTPS image credentials and Chromium manifest/worker requests use the browser session', async ({ browser, browserName, worker }, testInfo) => {
  const context = await browser.newContext({ baseURL: ORIGIN, proxy: { server: worker.proxy }, ignoreHTTPSErrors: true, serviceWorkers: 'allow' });
  try {
    await authenticate(context, worker, 'member');
    const page = await context.newPage();
    await page.goto('/');
    const metadata = page.locator('link[rel="manifest"]');
    await expect(metadata).toHaveAttribute('crossorigin', 'use-credentials');
    if (browserName === 'chromium') {
      // DevTools asks Chromium's manifest loader; no handcrafted fetch/cookie header.
      const cdp = await context.newCDPSession(page);
      const manifest = await cdp.send('Page.getAppManifest');
      expect(manifest.errors).toEqual([]);
      expect(JSON.parse(manifest.data ?? '{}').start_url).toBe('/');
      await cdp.detach();
    } else {
      // Engine support differs. Mark exactly what this engine establishes.
      testInfo.annotations.push({ type: 'manifest', description: 'Only Chromium manifest/worker-loader requests are instrumented; WebKit metadata and image credentials are checked without an OS install claim' });
    }
    // Headless browsers need not fetch a favicon. Exercise the native image loader
    // using the exact declared icon, without fetching or supplying headers ourselves.
    expect(await page.evaluate(async () => { const icon = document.querySelector<HTMLLinkElement>('link[rel="icon"]'); if (!icon) return false; return new Promise<boolean>(resolve => { const image = new Image(); image.onload = () => resolve(image.naturalWidth === 192); image.onerror = () => resolve(false); image.src = icon.href; }); })).toBe(true);
    await expect.poll(() => worker.requests.some(request => request.path === '/admin/app-icon-192.png' && request.cookiePresent)).toBe(true);
    if (browserName === 'chromium') {
      await expect.poll(() => worker.requests.some(request => request.path === '/admin/app-worker.js' && request.cookiePresent)).toBe(true);
      expect(worker.requests.filter(request => request.path === '/admin/app.webmanifest').every(request => request.cookiePresent)).toBe(true);
    }
    testInfo.annotations.push({ type: 'https-worker-registration', description: 'Not established: the fixture certificate is self-signed and the browser rejects it for service-worker registration. No certificate exception or trust change is used.' });
    worker.expireSessions();
    await page.goto('/');
    await expect(page).toHaveURL(`${ORIGIN}/login`);
    await expect(page.locator('[data-member-view],[data-dashboard-view]')).toHaveCount(0);
  } finally { await context.close(); }
});

for (const destination of ['用量报告', '上游连接', '成员与服务']) test(`a confirmed role change removes organization content before ${destination} recovery`, async ({ page, worker }, testInfo) => {
  await page.goto('/admin?view=access');
  await expect(page.locator('[data-user-id="other"]')).toContainText('other@example.test');
  const changed = await page.evaluate(async () => {
    const response = await fetch('/admin/ui/users/admin/role', { method: 'POST', headers: { Accept: 'text/html' }, body: new URLSearchParams({ role: 'user', confirm: '1' }) });
    return response.ok;
  });
  expect(changed).toBe(true);
  expect(worker.person('admin@example.test')?.role).toBe('user');
  await page.getByRole('navigation', { name: '控制台页面' }).getByRole('link', { name: destination, exact: true }).click();
  await expect(page.locator('[data-dashboard-notice]')).toContainText('当前角色已改变');
  await expect(page.locator('[data-user-id],[data-dashboard-view],.nav-rail,.identity-person strong')).toHaveCount(0);
  await expect.poll(() => page.locator('[data-one-time-key],[data-created-token]').count()).toBe(0);
  const path = testInfo.outputPath('safe-role-changed.png');
  await page.screenshot({ path, animations: 'disabled' });
  await testInfo.attach('role changed recovery', { path, contentType: 'image/png' });
  await page.getByRole('link', { name: '打开我的首页' }).click();
  await expect(page.locator('[data-member-view="home"]')).toBeVisible();
  await expectAccountRole(page,'成员');
});

// A separate, lower-boundary test uses the browser's native localhost secure context.
// It does not authenticate Agency Relay, prove protected HTTPS registration or install an app.
for (const disruption of ['origin-stop', 'offline-emulation'] as const) test(`unchanged worker source recovers from ${disruption} in native localhost secure context`, async ({ browser, browserName }, testInfo) => {
  test.skip(disruption === 'offline-emulation' && browserName !== 'chromium', 'Playwright 1.63 WebKit offline emulation rejects service-worker navigation even for literal worker responses (microsoft/playwright#42775). Both engines must pass the separate actual origin-stop case.');
  let writes = 0;
  const server = createServer(async (request, outgoing) => {
    if (request.method !== 'GET') { writes++; outgoing.writeHead(405).end(); return; }
    const resource = dashboardAppResponse('/admin/app-worker.js')!;
    if (request.url === '/admin/app-worker.js') {
      outgoing.writeHead(resource.status, Object.fromEntries(resource.headers));
      outgoing.end(await resource.text());
    } else {
      outgoing.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      outgoing.end('<!doctype html><html><head><meta charset="utf-8"><title>Local worker fixture</title></head><body><h1>Local worker fixture</h1></body></html>');
    }
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Local worker fixture unavailable');
  const origin = `http://localhost:${address.port}`;
  const context = await browser.newContext({ baseURL: origin, serviceWorkers: 'allow' });
  try {
    const page = await context.newPage();
    await page.goto('/');
    expect(await page.evaluate(() => isSecureContext)).toBe(true);
    await page.evaluate(async () => { await navigator.serviceWorker.register('/admin/app-worker.js', { scope: '/', updateViaCache: 'none' }); await navigator.serviceWorker.ready; });
    await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true);
    if (disruption === 'offline-emulation') await context.setOffline(true);
    else {
      const stopped = new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      server.closeAllConnections();
      await stopped;
      expect(server.listening).toBe(false);
    }
    expect(await page.evaluate(async () => { try { await fetch('/admin/ui/fixture', { method: 'POST', body: 'synthetic' }); return false; } catch { return true; } })).toBe(true);
    const response = await page.goto('/admin?target=exact-fixture');
    expect(response?.status()).toBe(503);
    expect(response?.fromServiceWorker()).toBe(true);
    await expect(page.getByRole('heading', { name: '无法连接 Agency Relay' })).toBeVisible();
    await expect(page.getByText('这个画面不能显示当前账号和访问状态。没有排队任何操作。')).toBeVisible();
    expect(await page.evaluate(async () => (await caches.keys()).length)).toBe(0);
    const geometry=[];
    for (const width of [320,768,1440]) {
      await page.setViewportSize({width,height:900});
      await page.emulateMedia({colorScheme:width===320?'dark':'light'});
      const facts=await page.locator('main').evaluate(main=>({viewport:innerWidth,documentWidth:document.documentElement.scrollWidth,
        actions:[...main.querySelectorAll('a')].map(link=>{const box=link.getBoundingClientRect();return {width:box.width,height:box.height,right:box.right};})}));
      expect(facts.documentWidth).toBeLessThanOrEqual(width+1);
      expect(facts.actions.every(box=>box.width>=44&&box.height>=44&&box.right<=width+1)).toBe(true);
      geometry.push({head:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),...facts,theme:width===320?'dark':'light',zoom:1,engine:testInfo.project.name,role:'offline-generic'});
    }
    const geometryPath=testInfo.outputPath('offline-layout-geometry.json');writeFileSync(geometryPath,JSON.stringify(geometry,null,2));
    await testInfo.attach('offline layout geometry',{path:geometryPath,contentType:'application/json'});
    const imagePath=testInfo.outputPath('safe-offline-1440.png');await page.screenshot({path:imagePath,animations:'disabled'});
    await testInfo.attach('generic offline entry',{path:imagePath,contentType:'image/png'});
    if (disruption === 'offline-emulation') await context.setOffline(false);
    else await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(address.port, '127.0.0.1', resolve); });
    await page.getByRole('link', { name: '重试这个页面' }).click();
    await expect(page.getByRole('heading', { name: 'Local worker fixture' })).toBeVisible();
    await expect(page).toHaveURL(`${origin}/admin?target=exact-fixture`);
    expect(writes).toBe(0);
    testInfo.annotations.push({ type: 'worker-boundary', description: `Production worker source on native HTTP localhost secure context; disruption=${disruption}. Origin stop is server unavailability, not browser/device offline emulation. No HTTPS registration, authenticated page caching, Feishu or OS-install claim` });
  } finally {
    await context.close();
    if (server.listening) {
      const stopped = new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      server.closeAllConnections(); await stopped;
    }
  }
});


test('administrator personal content keeps its own area through ordinary links',async({page})=>{
  await page.goto('/admin?area=me&view=home');
  await page.getByRole('navigation',{name:'成员页面'}).getByRole('link',{name:'我的密钥',exact:true}).click();
  await expect(page).toHaveURL(/area=me&view=keys/);
  await expect(page.locator('[data-member-view="keys"]')).toBeVisible();
  await expect(page.locator('[data-dashboard-panel]')).toHaveCount(0);
  await page.getByRole('navigation',{name:'成员页面'}).getByRole('link',{name:'客户端配置',exact:true}).click();
  await expect(page).toHaveURL(/area=me&view=setup/);
  await page.getByRole('button',{name:'账号菜单',exact:true}).click();
  await page.getByRole('menuitem',{name:'组织管理',exact:true}).click();
  await expect(page.locator('[data-dashboard-panel]')).toBeVisible();
});
