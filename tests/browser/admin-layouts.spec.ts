import { writeFileSync } from 'node:fs';
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures';

async function geometry(page: Page) {
  return page.locator('main').evaluate(main => {
    const targets = [...main.querySelectorAll('button:not(:disabled),input:not([type=hidden]):not([type=checkbox]),select,summary,.action-link,.account-link,.linked-key-link')]
      .filter(element => element.checkVisibility());
    return { documentWidth: document.documentElement.scrollWidth, viewport: innerWidth,
      tooSmall: targets.filter(element => { const box = element.getBoundingClientRect(); return box.width < 44 || box.height < 44; }).length,
      outside: targets.filter(element => { const box = element.getBoundingClientRect(); return (box.x < -1 || box.right > innerWidth + 1) && !element.closest('.table-wrap,.table-scroll'); }).length,
      paths: [...main.querySelectorAll('.route-path')].filter(element=>element.checkVisibility()).map(element => { const box = element.getBoundingClientRect(); return { width: box.width, height: box.height }; }) };
  });
}

for (const width of [320,390,768,999,1000,1024,1199,1200,1440,1920,2560]) {
  test.describe(`admin task layouts ${width}px`, () => {
    const colorScheme = width < 1000 ? 'dark' : 'light';
    test.use({ viewport: { width, height: 900 }, colorScheme });
    test('display-only task surfaces reflow and keep full facts reachable', async ({ page, worker }, testInfo) => {
      worker.seedAdminLayouts();
      const reports: unknown[] = [];
      for (const view of ['surfaces','credentials','credentials&account=grok%3Afixture-codex','quotas','control-audit','setup','setup&person=member&key=member-key']) {
        await page.goto(`/admin?view=${view}`);
        await page.evaluate(() => document.fonts.ready);
        await expect(page.locator('[data-one-time-key],[data-created-token],[data-authorizing]')).toHaveCount(0);
        const measurement = await geometry(page);
        reports.push({ view, role: 'admin', cssViewport: width, scale: 1, colorScheme, browser: testInfo.project.name, ...measurement });
        expect.soft(measurement.documentWidth, view).toBeLessThanOrEqual(width + 1);
        expect.soft(measurement.tooSmall, `${view} 44px targets`).toBe(0);
        expect.soft(measurement.outside, `${view} controls within viewport`).toBe(0);
        if (view === 'surfaces') {
          expect(measurement.paths.every(path => path.width >= Math.min(width - 48, 120))).toBe(true);
          const route = page.locator('[data-route-id="codex.responses"]');
          await route.getByRole('button', {name:'请求与授权详情',exact:true}).click();
          await expect(route.getByText('最近失败', { exact: true })).toBeVisible();
          await expect(route.getByText('需要的授权', { exact: true })).toBeVisible();
          await page.keyboard.press('Escape');
        }
        if (view === 'control-audit') {
          await expect(page.locator('.control-record')).toHaveCount(100);
          await expect(page.getByText(/未显示全部记录/)).toBeVisible();
          await page.locator('.control-record').first().getByRole('button', {name:'操作详情',exact:true}).click();
          await expect(page.locator('.control-record').first().getByText('对象标识')).toBeVisible();
          await page.keyboard.press('Escape');
        }
        if (view === 'quotas') {
          const form = page.locator('.organization-policy-form');
          await expect(form.getByRole('button', {name:'保存',exact:true})).toHaveCount(1);
          const placement = await form.evaluate(element => {
            const row = element.querySelector('tbody tr:last-child')!.getBoundingClientRect();
            const footer = element.querySelector('[data-slot=card-footer]')!.getBoundingClientRect();
            const save = element.querySelector('button[type=submit]')!.getBoundingClientRect();
            return { below: save.top >= row.bottom, rightInset: footer.right - save.right };
          });
          expect(placement.below).toBe(true);
          expect(placement.rightInset).toBeLessThanOrEqual(18);
          await expect(form.locator('[data-slot=card-header],[data-slot=badge]')).toHaveCount(0);
        }
        if (view === 'setup&person=member&key=member-key') {
          await expect(page.locator('[data-setup-selected-key="member-key"]').getByText('~/.codex/config.toml', { exact: true })).toBeVisible();
        }
        if ([390,1440].includes(width)) {
          // Capture only fixture metadata and invalid display prefixes, never a write result.
          await page.evaluate(() => scrollTo(0,0));
          const name = `safe-admin-${view.replaceAll(/[^a-z0-9-]/g,'-')}-${width}-${colorScheme}.png`;
          const path = testInfo.outputPath(name);
          await page.screenshot({ path, animations: 'disabled', fullPage: view !== 'surfaces' && view !== 'control-audit' && view !== 'credentials' });
          await testInfo.attach(name,{ path, contentType:'image/png' });
        }
      }
      const path = testInfo.outputPath('admin-layout-geometry.json');
      writeFileSync(path,JSON.stringify(reports,null,2));
      await testInfo.attach('safe display geometry',{path,contentType:'application/json'});
    });
  });
}

test('route filtering, exact provider selection and Back retain context', async ({ page, worker }) => {
  worker.seedAdminLayouts();
  await page.goto('/admin?view=surfaces');
  const host = page.locator('[data-surface-hostname="api.trustedtunnel.app"]');
  await expect(host.locator('[data-visible-row-filter-ready=true]')).toBeAttached();
  await host.getByRole('searchbox').fill('/v1/responses');
  await expect(host.locator('[data-route-id="codex.responses"]')).toBeVisible();
  await expect(host.locator('[data-route-id="codex.models"]')).toBeHidden();
  await page.goto('/admin?view=credentials&q=shared');
  await page.locator('[data-account-key="grok:fixture-codex"] a').click();
  await expect(page.locator('[data-account-detail="grok:fixture-codex"] h2').first()).toContainText('Synthetic Grok shared identifier');
  await expect(page).toHaveURL(/q=shared/);
  await page.goBack();
  await expect(page.getByRole('searchbox', { name:'搜索账号' })).toHaveValue('shared');
  await expect(page.locator('[data-account-key="grok:fixture-codex"] a')).toBeFocused();
});

test('quota drafts survive navigation and cancellation never writes', async ({ page, worker }) => {
  await page.goto('/admin?view=quotas');
  await expect(page.locator('[data-confirmation-fallback]:visible')).toHaveCount(0);
  const quota = page.locator('[data-quota-default="codex"]');
  await quota.getByRole('spinbutton').fill('123');
  await page.locator('.organization-policy-form').getByRole('button', { name:'保存', exact:true }).click();
  const dialog = page.getByRole('alertdialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('button', { name:'取消' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.locator('.organization-policy-form').getByRole('button', { name:'保存', exact:true })).toBeFocused();
  expect(worker.requests.filter(request => request.method === 'POST').length).toBe(0);
  await page.getByRole('navigation', { name:'控制台页面' }).getByRole('link', { name:'管理记录', exact:true }).click();
  await expect(page.locator('[data-view-role="control-audit"]')).toBeVisible();
  await page.goBack();
  await expect(quota.getByRole('spinbutton')).toHaveValue('123');
  await expect(page.locator('.organization-policy-form').getByText('有未保存的修改')).toBeVisible();
});

for(const script of [true,false]) test.describe(`administrator local configuration with script=${script}`,()=>{
  test.use({script,viewport:{width:390,height:900}});
  test('existing-key configuration remains with exact selection and retains inventory context',async({page,worker})=>{
    await page.goto('/admin?view=setup&person=member&key=member-key&range=30d&q=member&page=2');
    if(script) await page.getByRole('button',{name:'已有密钥',exact:true}).click();
    else await page.getByRole('link',{name:'用已有密钥生成配置',exact:true}).click();
    await expect(page.locator('[data-sync-configuration="local-only"]')).toBeVisible();
    const current=new URL(page.url());
    expect(current.searchParams.get('view')).toBe('setup');
    expect(current.searchParams.get('task')).toBe(script ? null : 'sync-configuration');
    expect(current.searchParams.get('range')).toBe('30d');
    expect(current.searchParams.get('q')).toBe('member');
    expect(current.searchParams.get('page')).toBe('2');
    expect(current.searchParams.get('person')).toBe('member');
    expect(current.searchParams.get('key')).toBe('member-key');
    await expect(page.locator('[data-setup-selected-key="member-key"]')).toBeVisible();
    await expect(page.getByRole('searchbox',{name:'搜索账号或密钥'})).toHaveValue('member');
    const form=page.locator('[data-local-config-sync]');
    if(script) await expect(form).toBeVisible(); else await expect(form).toBeHidden();
    expect(await form.getAttribute('method')).toBeNull();
    expect(await form.getAttribute('action')).toBeNull();
    expect(worker.requests.every(request=>request.method==='GET')).toBe(true);
  });
});

test.describe('native narrow administrator details', () => {
  test.use({ script:false, viewport:{width:390,height:900}, colorScheme:'light' });
  test('disclosures and exact parent links work without scripting', async ({ page, worker }) => {
    worker.seedAdminLayouts();
    await page.goto('/admin?view=surfaces');
    await expect(page.getByRole('searchbox')).toHaveCount(0);
    const route=page.locator('[data-route-id="codex.responses"]');
    await route.getByRole('button', {name:'请求与授权详情',exact:true}).click();
    await expect(route.getByText('ChatGPT',{exact:true})).toBeVisible();
    await page.goto('/admin?view=credentials&account=grok%3Afixture-codex&q=shared');
    await page.getByRole('link',{name:'收起连接详情',exact:true}).click();
    await expect(page.getByRole('searchbox',{name:'搜索账号'})).toHaveValue('shared');
    await page.goto('/admin?view=setup&person=member&key=member-key');
    await expect(page.locator('[data-setup-selected-key="member-key"]').getByText('~/.codex/config.toml',{exact:true})).toBeVisible();
    await page.getByRole('link',{name:'收起密钥配置',exact:true}).click();
    await page.locator('#setup-list>summary').click();
    await expect(page.locator('[data-setup-key-id="member-key"]')).toBeVisible();
  });
});

test.describe('enlarged administrator workspace', () => {
  test.use({ viewport:{width:1440,height:1000},colorScheme:'dark' });
  test('200 percent CSS magnification preserves tasks and keyboard disclosure',async ({ page,worker },testInfo) => {
    worker.seedAdminLayouts();
    await page.goto('/admin?view=surfaces');
    await expect(page.getByRole('tab', {name:'Codex',exact:true})).toHaveAttribute('aria-selected','true');
    // CSS zoom tests 2x layout magnification. This is not browser-chrome or device zoom evidence.
    await page.evaluate(() => { document.documentElement.style.zoom='2'; });
    const route=page.locator('[data-route-id="codex.responses"]');
    const summary=route.getByRole('button', {name:'请求与授权详情',exact:true});
    await summary.focus();
    await page.keyboard.press('Enter');
    await expect(route.getByText('需要的授权',{exact:true})).toBeVisible();
    const safe=await page.locator('main').evaluate(main => [...main.querySelectorAll('button[popovertarget]')].filter(element=>element.checkVisibility() && !element.closest('.table-wrap')).every(element=>element.getBoundingClientRect().right <= innerWidth + 1));
    expect(safe).toBe(true);
    await expect(page.locator('[data-one-time-key],[data-created-token],[data-authorizing]')).toHaveCount(0);
    const path=testInfo.outputPath('safe-routes-200-percent-css-zoom-dark.png');
    await page.screenshot({path,animations:'disabled'});
    await testInfo.attach('200 percent CSS zoom, not browser-chrome zoom',{path,contentType:'image/png'});
  });
});

test('one quota save commits all three confirmed values in the enhanced workspace', async ({ page, worker }) => {
  await page.goto('/admin?view=quotas');
  await expect(page.locator('[data-confirmation-fallback]:visible')).toHaveCount(0);
  const quota=page.locator('[data-quota-default="codex"]');
  await quota.getByRole('spinbutton').fill('123');
  await page.locator('[data-quota-default="grok"]').getByRole('spinbutton').fill('456');
  await page.locator('[data-quota-default="xai"]').getByRole('spinbutton').fill('0');
  await page.locator('.organization-policy-form').getByRole('button',{name:'保存',exact:true}).click();
  await page.getByRole('alertdialog').getByRole('button',{name:'保存',exact:true}).click();
  await expect(page.locator('[data-mutation-flash="credit_default"]')).toContainText('组织额度已更新');
  await expect(quota.getByRole('spinbutton')).toHaveValue('123');
  await expect(page).toHaveURL(/\/admin\?view=quotas/);
  expect(['codex','grok','xai'].map(surface => worker.quotaDefault(surface))).toEqual([123,456,0]);
  expect(worker.requests.filter(request=>request.method==='POST'&&request.path==='/admin/ui/credit-defaults')).toHaveLength(1);
});

test('stale organization quota form rejects every change and offers a fresh read', async ({page,worker}) => {
  await page.goto('/admin?view=quotas');
  await expect(page.locator('[data-confirmation-fallback]:visible')).toHaveCount(0);
  const initial = ['codex','grok','xai'].map(surface => worker.quotaDefault(surface));
  await page.locator('[data-quota-default="codex"]').getByRole('spinbutton').fill('321');
  worker.setQuotaDefault('grok',333);
  await page.locator('.organization-policy-form').getByRole('button',{name:'保存',exact:true}).click();
  await page.getByRole('alertdialog').getByRole('button',{name:'保存',exact:true}).click();
  await expect(page.locator('[data-dashboard-notice]')).toContainText('组织额度已变化');
  expect(['codex','grok','xai'].map(surface=>worker.quotaDefault(surface))).toEqual([initial[0],333,initial[2]]);
  await page.getByRole('link',{name:'查看当前组织额度',exact:true}).click();
  await expect(page.locator('[data-quota-default="grok"]').getByRole('spinbutton')).toHaveValue('333');
  await expect(page.locator('[data-quota-default="codex"]').getByRole('spinbutton')).toHaveValue(String(initial[0]));
  expect(worker.requests.filter(request=>request.method==='POST'&&request.path==='/admin/ui/credit-defaults')).toHaveLength(1);
});

test.describe('native quota save',()=>{
  test.use({script:false});
  test('acknowledges the native POST and offers an explicit read-only recovery link',async ({page,worker})=>{
    await page.goto('/admin?view=quotas');
    const quota=page.locator('[data-quota-default="codex"]');
    await quota.getByRole('spinbutton').fill('124');
    await page.locator('.organization-policy-form').getByRole('checkbox').check();
    await page.locator('.organization-policy-form').getByRole('button',{name:'保存',exact:true}).click();
    await expect(page).toHaveURL(/\/admin\/ui\/credit-defaults$/);
    await expect(page.locator('[data-mutation-flash="credit_default"]')).toContainText('每月 124 credits');
    await expect(page.getByText('请使用上方链接读取最新额度；若刷新时提示再次提交，请取消。')).toBeVisible();
    await page.getByRole('link',{name:'查看当前组织额度',exact:true}).click();
    await expect(page).toHaveURL(/\/admin\?view=quotas/);
    await expect(page.locator('[data-quota-default="codex"]').getByRole('spinbutton')).toHaveValue('124');
    await page.reload();
    expect(worker.requests.filter(request=>request.method==='POST'&&request.path==='/admin/ui/credit-defaults').length).toBe(1);
  });
  test('retains native confirmation on read failure then recovers through one GET',async ({page,worker})=>{
    await page.goto('/admin?view=quotas');
    worker.failQuotaLayoutRead(0);
    const quota=page.locator('[data-quota-default="codex"]');
    await quota.getByRole('spinbutton').fill('129');
    await page.locator('.organization-policy-form').getByRole('checkbox').check();
    await page.locator('.organization-policy-form').getByRole('button',{name:'保存',exact:true}).click();
    await expect(page.locator('[data-mutation-flash="credit_default"]')).toContainText('每月 129 credits');
    await expect(page.locator('[data-dashboard-unavailable]')).toBeVisible();
    expect(worker.quotaDefault('codex')).toBe(129);
    expect(worker.requests.filter(request=>request.method==='POST').length).toBe(1);
    worker.failQuotaLayoutRead(null);
    await page.getByRole('link',{name:'查看当前组织额度',exact:true}).click();
    await expect(page).toHaveURL(/\/admin\?view=quotas/);
    await expect(page.locator('[data-quota-default="codex"]').getByRole('spinbutton')).toHaveValue('129');
    expect(worker.requests.filter(request=>request.method==='POST').length).toBe(1);
  });
});

test('quota confirmed write survives a failed page read and recovers without replay', async ({page,worker})=>{
  await page.goto('/admin?view=quotas');
  await expect(page.locator('[data-confirmation-fallback]:visible')).toHaveCount(0);
  worker.failQuotaLayoutRead(0); // The bulk command commits before the following layout read.
  const quota=page.locator('[data-quota-default="codex"]');
  await quota.getByRole('spinbutton').fill('126');
  await page.locator('.organization-policy-form').getByRole('button',{name:'保存',exact:true}).click();
  await page.getByRole('alertdialog').getByRole('button',{name:'保存',exact:true}).click();
  await expect(page.locator('[data-mutation-flash="credit_default"]')).toContainText('组织额度已更新');
  await expect(page.locator('[data-dashboard-unavailable]')).toBeVisible();
  expect(worker.quotaDefault('codex')).toBe(126);
  await expect(page.locator('[data-dashboard-notice]')).not.toContainText('尚未确认');
  worker.failQuotaLayoutRead(null);
  await page.getByRole('link',{name:'重试',exact:true}).click();
  await expect(page.locator('[data-quota-default="codex"]').getByRole('spinbutton')).toHaveValue('126');
  expect(worker.requests.filter(request=>request.method==='POST').length).toBe(1);
});

test('quota pending actions and stop-waiting reconcile the committed value once', async ({page,worker})=>{
  await page.goto('/admin?view=quotas');
  await expect(page.locator('[data-confirmation-fallback]:visible')).toHaveCount(0);
  const hold=worker.hold({method:'POST',path:'/admin/ui/credit-defaults'});
  const quota=page.locator('[data-quota-default="codex"]');
  await quota.getByRole('spinbutton').fill('127');
  await page.locator('.organization-policy-form').getByRole('button',{name:'保存',exact:true}).click();
  await page.getByRole('alertdialog').getByRole('button',{name:'保存',exact:true}).click();
  await hold.entered;
  await expect(page.locator('.organization-policy-form')).toHaveAttribute('aria-busy','true');
  await expect(page.locator('.organization-policy-form').getByRole('button',{name:'保存',exact:true})).toBeDisabled();
  expect(worker.quotaDefault('codex')).toBe(127);
  await page.getByRole('button',{name:'停止等待'}).click();
  await expect(page.locator('[data-dashboard-notice]')).toContainText('尚未确认');
  await expect(page.locator('.organization-policy-form').getByRole('button',{name:'保存',exact:true})).toBeDisabled();
  hold.release();
  await page.getByRole('link',{name:'查看当前状态'}).click();
  await expect(page.locator('[data-quota-default="codex"]').getByRole('spinbutton')).toHaveValue('127');
  expect(worker.requests.filter(request=>request.method==='POST').length).toBe(1);
});
