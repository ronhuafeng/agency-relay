import { test, expect, authenticate, openMemberCreate, openKeyEditor } from "./fixtures";
import { ATTACKER_ORIGIN, ORIGIN } from "./worker";
import { request as apiRequest, type Page } from "@playwright/test";

async function ready(page: Page) {
  await expect(page.locator('#console-dialog-root')).toBeAttached();
  // This is a production enhancement outcome, not a test-only readiness hook.
  await expect(page.locator('[data-confirmation-fallback]:visible')).toHaveCount(0);
}

async function noSecretPersistence(page: Page) {
  const safe = await page.evaluate(async () => {
    const containsSecret = (value: string) => /cfwd_[A-Za-z0-9_-]{20,}/.test(value);
    const stores = [localStorage, sessionStorage];
    return !stores.some((storage) => Array.from({ length: storage.length }, (_, index) => storage.getItem(storage.key(index)!) ?? "").some(containsSecret))
      && !containsSecret(JSON.stringify(history.state)) && !containsSecret(location.href)
      && (await caches.keys()).length === 0;
  });
  expect(safe, "Secrets must not persist in storage, history, URL or CacheStorage").toBe(true);
}

test('real role projection, cookie, CSRF and own-object routes', async ({ page, context, worker }) => {
  const response = await page.goto('/admin?view=access');
  expect(response?.status()).toBe(200);
  expect(response?.headers()['content-security-policy']).toContain("default-src 'none'");
  expect(response?.headers()['content-security-policy']).toMatch(/script-src 'nonce-/);
  expect(response?.headers()['cache-control']).toBe('no-store');
  await expect(page.getByRole('navigation', { name: '控制台页面' })).toBeVisible();
  await expect(page.locator('[data-user-id="other"]')).toContainText('other@example.test');
  const cookie = (await context.cookies()).find((item) => item.name === '__Host-mini-console');
  expect(Boolean(cookie?.secure && cookie.httpOnly && cookie.sameSite === 'Lax' && !cookie.domain.startsWith('.'))).toBe(true);

  await authenticate(context, worker, 'member');
  await page.goto('/admin?view=keys');
  await expect.poll(() => page.getByRole('heading', { name: '我的密钥', exact: true }).isVisible()).toBe(true);
  expect(await page.locator('body').textContent()).not.toContain('other@example.test');
  expect(await page.locator('body').textContent()).not.toContain('fixture-codex');
  await expect(page.getByRole('navigation', { name: '控制台页面' })).toHaveCount(0);
  const outcomes = await page.evaluate(async () => {
    const request = async (path: string, init?: RequestInit) => {
      const response = await fetch(path, { ...init, headers: { Accept: 'application/json' } }); const body = await response.json() as { error?: { code?: string } };
      return { status: response.status, code: body.error?.code };
    };
    return {
      admin: await request('/admin/ui/users/other/status', { method: 'POST', body: new URLSearchParams({ status: 'disabled', confirm: '1' }) }),
      foreign: await request('/me/keys/other-key', { method: 'DELETE' }),
      absent: await request('/me/keys/absent-key', { method: 'DELETE' })
    };
  });
  expect(outcomes.admin).toEqual({ status: 403, code: 'admin_required' });
  expect(outcomes.foreign).toEqual(outcomes.absent);
  expect(outcomes.foreign.status).toBe(404);
  expect(worker.status('other')).toBe('active');
  const invalidOrigins: Array<Record<string, string>> = [{}, { Origin: 'https://foreign.invalid' }, { Origin: ORIGIN, 'Sec-Fetch-Site': 'cross-site' }];
  // The Origin guard runs before session auth. Keep these header probes cookie-free:
  // APIRequestContext failure steps include headers even when a caller catches errors.
  const probe = await apiRequest.newContext({ baseURL: ORIGIN, proxy: { server: worker.proxy }, ignoreHTTPSErrors: true });
  try {
    for (const headers of invalidOrigins) {
      const rejected = await probe.post('/me/ui/keys/member-key/revoke', { headers });
      expect(rejected.status()).toBe(403);
      expect((await rejected.json() as { error: { code: string } }).error.code).toBe('browser_write_rejected');
      expect(worker.requests.at(-1)?.cookiePresent).toBe(false);
    }
  } finally { await probe.dispose(); }
  // Separate authenticated-browser proof: SameSite allows this same-site form to
  // carry the target's host-only cookie, while the actual foreign Origin is rejected.
  await page.goto(ATTACKER_ORIGIN);
  const attack = page.waitForResponse(response => response.url().endsWith('/me/ui/keys/member-key/revoke'));
  await page.getByRole('button', { name: 'Attempt foreign-origin revoke' }).click();
  const rejectedAttack = await attack;
  expect(rejectedAttack.status()).toBe(403);
  expect((await rejectedAttack.json() as { error: { code: string } }).error.code).toBe('browser_write_rejected');
  expect(worker.requests.at(-1)).toMatchObject({ path: '/me/ui/keys/member-key/revoke', cookiePresent: true, origin: ATTACKER_ORIGIN, fetchSite: 'same-site' });
  expect(worker.keyMetadata().find((key) => key.id === 'member-key')?.status).toBe('active');
  const blocked = await page.goto('/admin?view=credentials');
  expect(blocked?.status()).toBe(404);
  expect(await page.locator('body').textContent()).not.toContain('Synthetic Codex');
});

test('cookie-free API transport failures cannot carry browser-session authority into reports', async ({ page, worker }) => {
  await page.goto('/admin?view=access');
  expect(worker.requests.some(request => request.cookiePresent)).toBe(true);
  const probe = await apiRequest.newContext({ baseURL: ORIGIN, proxy: { server: worker.proxy }, ignoreHTTPSErrors: true });
  try {
    const fault = worker.hold({ method: 'POST', path: '/me/ui/keys/member-key/revoke' });
    const result = probe.post('/me/ui/keys/member-key/revoke', { maxRetries: 0 }).then(() => ({ failed: false, credentialInError: false }), error => ({
      failed: true,
      credentialInError: /__Host-mini-console=|(?:^|\n)\s*-?\s*(?:cookie|authorization):/i.test(String(error))
    }));
    await fault.entered; fault.disconnect();
    expect(await result).toEqual({ failed: true, credentialInError: false });
    expect(worker.requests.at(-1)).toMatchObject({ cookiePresent: false, authorizationPresent: false });
    expect(worker.keyMetadata().find(key => key.id === 'member-key')?.status).toBe('active');
  } finally { await probe.dispose(); }
});

for (const width of [390, 1440]) {
  test.describe(`navigation at ${width}px`, () => {
    test.use({ viewport: { width, height: 900 } });
    test('filtered list, detail, Back and confirmation cancellation preserve context', async ({ page, worker }) => {
      await page.goto('/admin?view=access');
      await ready(page);
      const search = page.getByRole('searchbox', { name: '搜索邮箱、名称或 ID' });
      await search.fill('person-');
      await search.press('Enter');
      await expect(page).toHaveURL(/q=person-/);
      const source = page.locator('[data-user-id="person-12"] .person-link');
      await source.scrollIntoViewIfNeeded();
      const before = await page.evaluate(() => scrollY);
      await source.click();
      await expect(page.locator('[data-person-detail="person-12"]')).toBeVisible();
      await expect(page.locator('[data-person-detail="person-12"]')).toBeFocused();
      const action = page.getByRole('switch', { name: /启用账号/ });
      await action.click();
      const dialog = page.getByRole('alertdialog');
      await expect(dialog).toBeVisible();
      await expect(dialog.getByRole('button', { name: '取消' })).toBeFocused();
      await page.keyboard.press('Tab');
      await expect(dialog.getByRole('button', { name: '停用账号', exact: true })).toBeFocused();
      await page.keyboard.press('Escape');
      await expect(dialog).toHaveCount(0);
      await expect(action).toBeFocused();
      expect(worker.status('person-12')).toBe('active');
      expect(worker.requests.filter((request) => request.method === 'POST')).toHaveLength(0);
      await page.goBack();
      await expect(search).toHaveValue('person-');
      await expect(source).toBeFocused();
      expect(Math.abs(await page.evaluate(() => scrollY) - before)).toBeLessThan(40);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    });
  });
}

test('latest navigation wins; failed read and expired session have distinct recovery', async ({ page, worker }) => {
  await page.goto('/admin?view=access');
  await ready(page);
  const slow = worker.hold({ method: 'GET', path: '/admin', view: 'usage' });
  const firstRead = page.waitForRequest((request) => new URL(request.url()).searchParams.get('view') === 'usage');
  await page.getByRole('navigation', { name: '控制台页面' }).getByRole('link', { name: '用量报告', exact: true }).click();
  await slow.entered;
  const firstRequest = await firstRead;
  const oldSettled = Promise.race([
    page.waitForEvent('requestfinished', { predicate: (request) => request === firstRequest }),
    page.waitForEvent('requestfailed', { predicate: (request) => request === firstRequest })
  ]);
  await page.getByRole('navigation', { name: '控制台页面' }).getByRole('link', { name: '额度政策', exact: true }).click();
  await expect(page.locator('[data-view-role="quotas"]')).toBeVisible();
  slow.release();
  // Observe settlement, then let the browser paint any response-driven DOM work.
  // Merely releasing the server gate could otherwise assert before a stale write.
  await oldSettled;
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await expect(page).toHaveURL(/view=quotas/);
  await expect(page.locator('[data-view-role="quotas"]')).toBeVisible();
  const failed = worker.hold({ method: 'GET', path: '/admin', view: 'usage' });
  await page.getByRole('navigation', { name: '控制台页面' }).getByRole('link', { name: '用量报告', exact: true }).click();
  await failed.entered; failed.release(503);
  await expect(page.locator('[data-dashboard-notice]')).toContainText('页面暂时打不开');
  await expect(page.locator('[data-dashboard-notice]').getByRole('link', { name: '重试' })).toBeVisible();
  await expect(page.locator('[data-view-role="quotas"]')).toBeVisible();
  worker.expireSessions();
  const usageLink = page.getByRole('navigation', { name: '控制台页面' }).getByRole('link', { name: '用量报告', exact: true });
  const target = new URL((await usageLink.getAttribute('href'))!, page.url());
  await usageLink.click();
  await expect(page.locator('[data-dashboard-notice]')).toContainText('登录状态无法验证');
  await expect(page.locator('[data-dashboard-notice]').getByRole('link', { name: '重新登录' })).toHaveAttribute('href', `${ORIGIN}/login?${new URLSearchParams({return: target.pathname + target.search + target.hash})}`);
  await expect(page.locator('[data-view-role="quotas"],.nav-rail,.identity-person strong')).toHaveCount(0);
});

test('pending admin write, Back and stop waiting never replay the committed operation', async ({ page, worker }) => {
  await page.goto('/admin?view=access');
  await ready(page);
  await page.locator('[data-user-id="other"] .person-link').click();
  const held = worker.hold({ method: 'POST', path: '/admin/ui/users/other/status' });
  await page.getByRole('switch', { name: /启用账号/ }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: '停用账号', exact: true }).click({ clickCount: 2 });
  await held.entered;
  expect(worker.status('other')).toBe('disabled');
  await page.goBack();
  await expect(page).toHaveURL(/person=other/);
  await page.getByRole('button', { name: '停止等待' }).click();
  await expect(page.locator('[data-dashboard-notice]')).toContainText('操作结果尚未确认');
  await expect(page.getByRole('switch', { name: /启用账号/ })).toBeDisabled();
  held.release();
  await page.getByRole('link', { name: '查看当前状态' }).click();
  await expect(page.getByRole('switch', { name: /启用账号/ })).toHaveAttribute('aria-checked', 'false');
  expect(worker.requests.filter((request) => request.path === '/admin/ui/users/other/status')).toHaveLength(1);
});

test.describe('member secret lifecycle (no recordings)', () => {
  test.use({ identity: 'member' });
  test('creation and replacement results are one-time and never restored after leaving', async ({ page, worker }, testInfo) => {
    await page.goto('/admin?view=keys');
    await ready(page);
    await openMemberCreate(page);
    await page.getByRole('textbox', { name: '名称', exact: true }).fill('Browser laptop');
    await page.getByRole('checkbox', { name: 'Codex', exact: true }).check();
    const created = page.waitForResponse((response) => response.request().method() === 'POST' && response.url().endsWith('/me/ui/keys'));
    await page.locator('[data-member-key-create]').getByRole('button', { name: '创建密钥' }).click();
    expect((await created).headers()['cache-control']).toBe('no-store');
    await expect.poll(() => page.locator('[data-one-time-key]').isVisible()).toBe(true);
    expect(await page.evaluate(() => Array.from(document.querySelectorAll('[data-created-token]')).some((element) => /^cfwd_[A-Za-z0-9_-]{20,}$/.test(element.textContent ?? '')))).toBe(true);
    expect(worker.countKeys()).toBe(2);
    await noSecretPersistence(page);
    const createdUrl = page.url();
    await page.getByRole('navigation', { name: '成员页面' }).getByRole('link', { name: '我的额度' }).click();
    await page.waitForURL(`${ORIGIN}/admin?area=me&view=quota`, { waitUntil: 'load' });
    await expect(page.getByRole('heading', { name: '我的额度' })).toBeVisible();
    await page.goBack();
    await page.waitForURL(createdUrl, { waitUntil: 'load' });
    await expect.poll(() => page.getByRole('heading', { name: '我的密钥', exact: true }).isVisible()).toBe(true);
    await expect.poll(() => page.locator('[data-one-time-key]').count()).toBe(0);
    await expect.poll(() => page.locator('[data-created-token]').count()).toBe(0);
    const restored = await page.evaluate(() => (window as unknown as { restoredFromCache: boolean }).restoredFromCache);
    testInfo.annotations.push({ type: 'bfcache', description: restored ? 'Actual persisted pageshow observed' : 'Ordinary Back navigation only; no bfcache claim' });
    await noSecretPersistence(page);
    await ready(page);
    // The recovered URL selects the newly created key. Collapse it before
    // locally opening a different exact key for replacement.
    await expect(page.locator('[data-key-id="member-key"]')).toHaveCount(1);
    await expect(page.locator('[data-key-detail]:visible')).not.toHaveAttribute('data-key-detail','member-key');
    await page.locator('[data-member-key-close]:visible').click();
    await expect(page.locator('[data-member-key-row]:not([hidden])')).toHaveCount(0);
    await ready(page);
    await page.locator('[data-key-id="member-key"]').getByRole('link', {name:'管理密钥',exact:false}).click();
  await openKeyEditor(page, 'replace');
    await page.locator('[data-key-detail="member-key"]').getByRole('button', { name: '更换', exact: true }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: '更换', exact: true }).click();
    await expect.poll(() => page.locator('[data-one-time-key]').isVisible()).toBe(true);
    expect(await page.evaluate(() => document.querySelector('[data-one-time-key]')?.textContent?.includes('display_member') === true)).toBe(true);
    expect(worker.countKeys()).toBe(3);
    expect(worker.keyMetadata().filter((row) => row.family_id === 'member-family' && row.status === 'active')).toHaveLength(2);
    await noSecretPersistence(page);
    const replacementUrl = page.url();
    await page.getByRole('navigation', { name: '成员页面' }).getByRole('link', { name: '我的用量' }).click();
    await page.waitForURL(`${ORIGIN}/admin?area=me&view=usage&range=7d`, { waitUntil: 'load' });
    await expect(page.getByRole('heading', { name: '我的用量', exact: true, level: 1 })).toBeVisible();
    await page.goBack();
    await page.waitForURL(replacementUrl, { waitUntil: 'load' });
    await expect.poll(() => page.getByRole('heading', { name: '我的密钥', exact: true }).isVisible()).toBe(true);
    await expect.poll(() => page.locator('[data-created-token]').count()).toBe(0);
    expect(worker.countKeys()).toBe(3);
  });

  test('stop waiting reconciles a created key without automatic replay', async ({ page, worker }) => {
    await page.goto('/admin?view=keys'); await ready(page);
    const held = worker.hold({ method: 'POST', path: '/me/ui/keys' });
    await openMemberCreate(page);
    await page.getByRole('textbox', { name: '名称', exact: true }).fill('Uncertain result');
    await page.getByRole('checkbox', { name: 'Codex', exact: true }).check();
    await page.locator('[data-member-key-create]').getByRole('button', { name: '创建密钥' }).click({ clickCount: 2 });
    await held.entered;
    await page.getByRole('button', { name: '停止等待' }).click();
    await expect(page.locator('[data-member-feedback]')).toContainText('操作结果尚未确认');
    await expect(page.locator('[data-member-key-create]').getByRole('button', { name: '创建密钥' })).toBeDisabled();
    held.release();
    await page.getByRole('link', { name: '查看当前密钥' }).click();
    await expect(page.locator('.member-keys-table')).toContainText('Uncertain result');
    await expect.poll(() => page.locator('[data-created-token]').count()).toBe(0);
    expect(worker.countKeys()).toBe(2);
    expect(worker.requests.filter((request) => request.method === 'POST' && request.path === '/me/ui/keys')).toHaveLength(1);
  });
});

test.describe('native HTML without JavaScript', () => {
  test.use({ script: false });
  test('read a filtered person and submit a supported status change', async ({ page, worker }) => {
    await page.goto('/admin?view=access');
    await page.getByRole('searchbox', { name: '搜索邮箱、名称或 ID' }).fill('other@example.test');
    await page.getByRole('button', { name: '搜索邮箱、名称或 ID' }).click();
    await page.locator('[data-user-id="other"] .person-link').click();
    await expect(page.getByRole('heading', { name: 'other@example.test', exact: true })).toBeVisible();
    const form = page.locator('[data-action="user-status"]');
    await form.getByRole('checkbox').check();
    await form.getByRole('switch', { name: /启用账号/ }).click();
    await expect(page.getByRole('switch', { name: /启用账号/ })).toHaveAttribute('aria-checked', 'false');
    await expect(page.locator('[data-mutation-flash]')).toBeVisible();
    expect(worker.status('other')).toBe('disabled');
    await page.getByRole('navigation',{name:'控制台页面'}).getByRole('link',{name:'组织概览',exact:true}).click();
    await expect(page).toHaveURL(/\/admin\?view=overview/);
    await expect(page.locator('main[data-dashboard-view=overview]')).toBeVisible();
    expect(worker.status('other')).toBe('disabled');
    expect(worker.requests.some((request) => request.path === '/admin/console.js')).toBe(false);
  });
});


test.describe('native administrator issuance recovery',()=>{
  test.use({script:false,viewport:{width:390,height:900}});
  test('creation returns to the issued key without replay or secret recovery',async({page,worker})=>{
    await page.goto('/admin?view=access&person=member&task=give-access');
    const form=page.locator('form[action="/admin/ui/keys"]');
    await form.getByRole('checkbox',{name:'Codex',exact:true}).check();
    await form.getByRole('combobox',{name:'Codex 账号',exact:true}).selectOption('fixture-codex');
    await form.getByRole('button',{name:'创建密钥',exact:true}).click();
    await expect.poll(()=>page.locator('[data-one-time-key]').isVisible()).toBe(true);
    const issued=worker.keyMetadata().find(row=>row.id!=='member-key')!;
    const writes=worker.requests.filter(r=>r.method!=='GET').length;
    await page.locator('.setup-package .action-link').click();
    await expect(page).toHaveURL(new RegExp(`/admin\\?view=access&person=member&key=${issued.id}`));
    await expect.poll(()=>page.locator(`[data-key-detail="${issued.id}"]`).isVisible()).toBe(true);
    expect(await page.locator('[data-one-time-key]').count()).toBe(0);
    expect(worker.requests.filter(r=>r.method!=='GET').length).toBe(writes);
  });
  for(const view of ['access','setup']) for(const invalid of ['2026-06-01T12:00','2028-01-01T12:00']) test(`rejected ${view} expiry ${invalid} remains a correctable task`,async({page,worker})=>{
    await page.goto(`/admin?view=${view}&person=member&key=member-key`);
    const form=page.locator('form[action="/admin/ui/keys/member-key/replace"]');
    await form.getByLabel('到期时间（UTC，可选）').fill(invalid);
    await form.getByRole('checkbox').check();
    const response=page.waitForResponse(r=>r.request().method()==='POST' && r.url().endsWith('/admin/ui/keys/member-key/replace'));
    await form.getByRole('button').click();
    const rejected=await response;
    expect(rejected.status()).toBe(400);
    expect(rejected.headers()['content-type']).toContain('text/html');
    await expect(page.getByRole('heading',{name:'密钥没有换发',exact:true})).toBeVisible();
    expect(worker.countKeys()).toBe(1);
    await form.getByLabel('到期时间（UTC，可选）').fill('2026-07-24T12:00');
    await form.getByRole('checkbox').check();
    await form.getByRole('button').click();
    await expect.poll(()=>page.locator('[data-one-time-key]').isVisible()).toBe(true);
    expect(worker.countKeys()).toBe(2);
  });
  for(const view of ['access','setup']) test(`replacement from ${view} applies the selected expiry and returns to metadata`,async({page,worker})=>{
    await page.goto(`/admin?view=${view}&person=member&key=member-key`);
    const form=page.locator('form[action="/admin/ui/keys/member-key/replace"]');
    await form.getByLabel('到期时间（UTC，可选）').fill('2026-07-24T12:00');
    await form.getByRole('checkbox').check();
    await form.getByRole('button').click();
    await expect.poll(()=>page.locator('[data-one-time-key]').isVisible()).toBe(true);
    const issued=worker.keyMetadata().find(row=>row.id!=='member-key')!;
    expect(issued.expires_at).toBe('2026-07-24T12:00:00.000Z');
    expect(issued.family_id).toBe('member-family');
    // The package element is visible before the previous-prefix caption is parsed.
    await page.waitForLoadState('domcontentloaded');
    expect(await page.locator('[data-one-time-key]').evaluate(node=>{
      const codes=Array.from(node.querySelectorAll('.panel-caption code'));
      return codes.length===2 && codes[0].textContent!==codes[1].textContent && codes[1].textContent==='display_member';
    })).toBe(true);
    const writes=worker.requests.filter(r=>r.method!=='GET').length;
    await page.locator('.setup-package .action-link').click();
    await expect.poll(()=>{const url=new URL(page.url());return url.pathname==='/admin' && url.searchParams.get('view')==='access' && url.searchParams.get('person')==='member' && url.hash==='#keys';}).toBe(true);
    await expect.poll(()=>page.locator(`[data-key-id="${issued.id}"]`).isVisible()).toBe(true);
    expect(await page.locator('[data-one-time-key]').count()).toBe(0);
    expect(worker.requests.filter(r=>r.method!=='GET').length).toBe(writes);
  });
});
