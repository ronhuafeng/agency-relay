import type { Page } from '@playwright/test';
import { test, expect, authenticate, openMemberCreate, openKeyEditor } from './fixtures';
import { ORIGIN } from './worker';

async function createKey(page: Page, enhanced = true) {
  if (enhanced) await openMemberCreate(page);
  const form = page.locator('[data-member-key-create]');
  await form.getByRole('textbox', {name: '名称', exact: true}).fill('Automation key');
  await form.getByRole('checkbox', {name: 'Codex', exact: true}).check();
  await form.getByRole('button', {name: '创建密钥', exact: true}).click();
  // A failure reports only a boolean, never the secret-bearing result DOM.
  await expect.poll(() => page.locator('[data-one-time-key]').isVisible()).toBe(true);
}
async function leaveSecret(page: Page) {
  await page.getByRole('link', {name: '管理新密钥', exact: true}).click();
  await expect.poll(() => page.locator('[data-one-time-key],[data-created-token]').count()).toBe(0);
}

test.describe('delegated service management', () => {
  test.use({identity: 'member'});
  test('narrow enhanced create, rename, replace and setup retain the service context', async ({page, worker}) => {
    await page.setViewportSize({width: 390, height: 900});
    const id = await worker.seedDelegatedService(); const prefix = `/me/service-accounts/${id}`;
    worker.seedUsageTrends(id);
    await page.goto('/admin?area=me&view=home');
    await page.getByRole('link', {name: `Nightly build（${id}）`, exact: true}).click();
    await expect(page.getByRole('heading', {name: 'Nightly build · 工作台', exact: true})).toBeVisible();
    await page.getByRole('navigation',{name:'成员页面'}).getByRole('link', {name:'服务密钥',exact:true}).click();
    await expect(page.locator('[data-key-id]')).toHaveCount(0);
    await createKey(page);
    expect(await page.locator('[data-one-time-key] h1').textContent()).toBe('Nightly build · 密钥已创建');
    expect(await page.evaluate(() => {
      const value = document.querySelector('[data-created-token]')?.textContent;
      return Boolean(value) && ![localStorage, sessionStorage].some(store => Object.values(store).some(item => String(item).includes(value!)))
        && !JSON.stringify(history.state).includes(value!) && !location.href.includes(value!);
    })).toBe(true);
    expect(await page.evaluate(async () => (await caches.keys()).length)).toBe(0);
    expect(worker.countKeys(id)).toBe(1); expect(worker.countKeys()).toBe(1);
    await leaveSecret(page); await expect(page).toHaveURL(new RegExp(`${prefix}\\?view=keys&key=`));
    const first = worker.keyMetadata(id)[0]!; const key = page.locator(`[data-key-detail="${first.id}"]`);
  await openKeyEditor(page, 'rename');
    await key.getByRole('textbox', {name: '密钥名称', exact: true}).fill('Build runner');
  await openKeyEditor(page, 'rename');
    await key.getByRole('button', {name: '保存名称', exact: true}).click();
    await expect(page.locator('[data-member-feedback]')).toContainText('当前列表已更新');
    expect(worker.keyMetadata(id)[0]?.name).toBe('Build runner');
  await openKeyEditor(page, 'replace');
    await key.getByRole('combobox', {name: '有效期', exact: true}).selectOption({label: '30 天'});
  await openKeyEditor(page, 'replace');
    await key.getByRole('button', {name: '更换', exact: true}).click();
    await expect(page.getByRole('alertdialog')).toContainText(id);
    await page.getByRole('alertdialog').getByRole('button', {name: '更换', exact: true}).click();
    await expect.poll(() => page.locator('[data-one-time-key]').isVisible()).toBe(true);
    expect(await page.locator('[data-one-time-key]').evaluate(node => node.textContent?.includes('仍可认证'))).toBe(true);
    await leaveSecret(page);
    const replacement = worker.keyMetadata(id).find(row => row.id !== first.id)!;
    expect(replacement.family_id).toBe(first.family_id); expect(replacement.expires_at).toBe('2026-07-24T12:00:00.000Z');
    expect(await page.locator(`[data-key-detail="${replacement.id}"] [data-key-task]`).textContent()).toContain('未记录成功任务');
    await page.locator(`[data-key-id="${replacement.id}"]`).getByRole('link', {name: /配置客户端：/}).click();
    await expect(page.getByRole('heading', {name: 'Nightly build · 客户端配置', exact: true})).toBeVisible();
    await expect(page).toHaveURL(prefix+'?view=setup');
    await expect(page.locator('.member-setup-config')).toBeVisible();
    await expect(page.locator('[data-setup-key]')).toHaveCount(0);
    await expect(page.locator('[data-service-id]')).toHaveAttribute('data-service-id',id);
    await page.goto(prefix + '?view=quota');
    await expect(page.locator('[data-member-quota] [data-surface=codex] td.number')).toHaveText(['12','12']);
    await page.goto(prefix + '?view=usage'); await expect(page.getByRole('heading', {name: 'Nightly build · 用量', exact: true, level: 1})).toBeVisible();
    await page.getByRole('navigation', {name: 'UTC 时间范围'}).getByRole('link', {name: '30 天', exact: true}).click();
    await expect(page.locator('[data-usage-range-label]')).toHaveAttribute('data-usage-range-label', '2026-05-26 至 2026-06-24 UTC');
    await expect(page).toHaveURL(prefix + '?view=usage&range=30d');
    await expect(page.locator('[data-service-id]')).toHaveAttribute('data-service-id', id);
    await expect(page.locator('a[download]')).toHaveAttribute('href', prefix + '/usage?from=2026-05-26&to=2026-06-24');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.goto('/admin?area=me&view=keys'); await expect(page.locator('[data-key-id]')).toHaveCount(1);
    await expect(page.locator('[data-key-id]')).toHaveAttribute('data-key-id', 'member-key');
  });

  test('transfer warns that bearers remain, rejects a stale owner write, and offers separate admin revocation', async ({page, browser, worker}) => {
    const id = await worker.seedDelegatedService(); const prefix = `/me/service-accounts/${id}`;
    await page.goto(prefix + '?view=keys'); await createKey(page); await leaveSecret(page);
    const keyId = String(worker.keyMetadata(id)[0]!.id);
    const admin = await browser.newContext({baseURL: ORIGIN, proxy: {server: worker.proxy}, ignoreHTTPSErrors: true});
    try {
      await authenticate(admin, worker, 'admin'); const manager = await admin.newPage();
      await manager.goto(`/admin?view=access&person=${id}`);
      const form = manager.locator(`form[action="/admin/ui/services/${id}/owner"]`);
      await form.getByRole('combobox', {name: '新的管理人'}).selectOption('user:other');
      await form.getByRole('button', {name: '更新管理人', exact: true}).click();
      await expect(manager.getByRole('alertdialog')).toContainText('仍可进行 API 调用');
      await expect(manager.getByRole('alertdialog')).toContainText('other@example.test');
      await manager.getByRole('alertdialog').getByRole('button', {name: '取消', exact: true}).click();
      expect(worker.serviceOwner(id)?.owner_user_id).toBe('member');
      await form.getByRole('button', {name: '更新管理人', exact: true}).click();
      await manager.getByRole('alertdialog').getByRole('button', {name: '更新管理人', exact: true}).click();
      await expect(manager.locator('[data-mutation-flash="service_owner_changed"]')).toContainText('密钥没有更改');
      expect(worker.serviceOwner(id)?.owner_user_id).toBe('other'); expect(worker.keyMetadata(id)[0]?.status).toBe('active');
      await openKeyEditor(page, 'rename');
      await page.locator(`[data-key-detail="${keyId}"]`).getByRole('textbox', {name: '密钥名称', exact: true}).fill('Rejected former-owner rename');
      const rejected = page.waitForResponse(response=>response.request().method()==='POST'&&new URL(response.url()).pathname===`${prefix}/ui/keys/${keyId}/rename`);
      await page.locator(`[data-key-detail="${keyId}"]`).getByRole('button', {name: '保存名称', exact: true}).click();
      const response=await rejected;
      expect(response.status()).toBe(404);
      expect(response.headers()['content-type']?.includes('application/json')).toBe(true);
      expect((await response.json()).error.code).toBe('service_not_found');
      await expect(page.locator('[data-console-recovery]')).toBeVisible();
      await expect(page.locator('[data-console-recovery]')).toContainText('刚才的操作未执行');
      expect(await page.locator('.shell,.identity,[data-service-id],[data-key-detail],[data-ui-props]').count()).toBe(0);
      expect(worker.keyMetadata(id)[0]?.name).toBe('Automation key');
      expect(worker.keyMetadata(id)[0]?.status).toBe('active');expect(worker.countKeys(id)).toBe(1);
      expect(worker.requests.filter(request=>request.method==='POST'&&request.path===`${prefix}/ui/keys/${keyId}/rename`)).toHaveLength(1);
      await manager.getByRole('link', {name: '管理服务密钥', exact: true}).click();
      await manager.goto(prefix + '?view=keys&key=' + keyId);
      await manager.locator(`[data-key-detail="${keyId}"]`).getByRole('button', {name: '撤销密钥', exact: true}).click();
      await manager.getByRole('alertdialog').getByRole('button', {name: '撤销密钥', exact: true}).click();
      await expect(manager.locator('[data-member-feedback]')).toContainText('当前列表已更新');
      expect(worker.keyMetadata(id)[0]?.status).toBe('revoked');
    } finally { await admin.close(); }
  });

  test('stopping the wait for service creation leads to readback without a repeated write', async ({page, worker}) => {
    const id = await worker.seedDelegatedService(); const prefix = `/me/service-accounts/${id}`;
    await page.goto(prefix + '?view=keys'); const gate = worker.hold({method: 'POST', path: prefix + '/ui/keys'});
    await openMemberCreate(page);
    const form = page.locator('[data-member-key-create]');
    await form.getByRole('textbox', {name: '名称', exact: true}).fill('Uncertain build');
    await form.getByRole('checkbox', {name: 'Codex', exact: true}).check();
    await form.getByRole('button', {name: '创建密钥', exact: true}).click();
    await gate.entered; await page.getByRole('button', {name: '停止等待', exact: true}).click(); gate.release();
    await expect(page.locator('[data-member-feedback]')).toContainText('不要重复提交');
    await expect(form.getByRole('button', {name: '创建密钥', exact: true})).toBeDisabled();
    await page.getByRole('link', {name: '查看当前密钥', exact: true}).click();
    await expect(page).toHaveURL(prefix + '?view=keys');
    await expect(page.locator('[data-key-id]')).toHaveCount(1);
    expect(worker.requests.filter(request => request.method === 'POST' && request.path === prefix + '/ui/keys')).toHaveLength(1);
    expect(await page.locator('[data-one-time-key]').count()).toBe(0);
  });
});

test.describe('native delegated recovery', () => {
  test.use({identity: 'member', script: false});
  test('native creation replay stays metadata-only and a disabled service remains revocable', async ({page, worker}) => {
    const id = await worker.seedDelegatedService(); const prefix = `/me/service-accounts/${id}`;
    await page.goto(prefix + '?view=keys'); await createKey(page, false); expect(worker.countKeys(id)).toBe(1);
    await page.reload(); await expect.poll(() => page.locator('[data-member-result="confirmed"]').isVisible()).toBe(true);
    expect(await page.locator('[data-one-time-key]').count()).toBe(0); expect(worker.countKeys(id)).toBe(1);
    await page.getByRole('link', {name: '查看当前密钥', exact: true}).click();
    await expect(page).toHaveURL(new RegExp(`${prefix}\\?view=keys&key=`));
    worker.setServiceStatus(id, 'disabled'); await page.reload();
    await expect(page.locator('[data-member-key-create] button')).toBeDisabled();
    await expect(page.getByRole('button', {name: '更换', exact: true})).toHaveCount(0);
    const form = page.locator(`form[action="${prefix}/ui/keys/revoke-all"]`);
    await page.locator('thead .member-bulk-actions > button').click();
    await form.getByRole('checkbox').check(); await form.getByRole('button').click();
    await expect(page.locator('[data-member-result="confirmed"]')).toContainText('已撤销 1 个密钥');
    worker.setServiceStatus(id, 'active'); await page.getByRole('link', {name: '查看当前密钥', exact: true}).click();
    await expect(page.locator('[data-key-state="revoked"]')).toHaveCount(1);
    expect(worker.keyMetadata(id)[0]?.status).toBe('revoked'); expect(worker.keyMetadata()[0]?.status).toBe('active');
  });
});

test.describe('service owner review regressions', () => {
  test.use({identity:'admin'});
  test('a disabled owner cannot disappear through omitted Chromium FormData', async ({page,worker}) => {
    const id=await worker.seedDelegatedService();
    await page.goto('/admin?view=access&person=member');
    await page.locator('[data-action="user-status"]').getByRole('switch',{name:/启用账号/}).click();
    await page.getByRole('alertdialog').getByRole('button',{name:'停用账号',exact:true}).click();
    await expect(page.locator('[data-mutation-flash="user_status"]')).toBeVisible();
    await page.goto(`/admin?view=access&person=${id}`);
    const form=page.locator(`form[action="/admin/ui/services/${id}/owner"]`);
    const result=await form.evaluate(async node=>{
      const form=node as HTMLFormElement; const fields=new FormData(form);
      const response=await fetch(form.action,{method:'POST',body:new URLSearchParams([...fields] as [string,string][]),headers:{Accept:'application/json'}});
      return {ownerPresent:fields.has('owner_user_id') || fields.has('owner_selection'),status:response.status};
    });
    expect(result).toEqual({ownerPresent:false,status:400});
    expect(worker.serviceOwner(id)).toEqual({owner_user_id:'member',revision:1});
    await expect(form.getByRole('combobox',{name:'新的管理人'})).toHaveValue('');
    await expect(page.getByRole('region',{name:'服务管理人'})).toContainText('成员已停用');
    await form.getByRole('combobox',{name:'新的管理人'}).selectOption('remove');
    await form.getByRole('button',{name:'更新管理人',exact:true}).click();
    await expect(page.getByRole('alertdialog')).toContainText('新的管理人：移除分配');
    await page.getByRole('alertdialog').getByRole('button',{name:'更新管理人',exact:true}).click();
    await expect(page.locator('[data-mutation-flash="service_owner_changed"]')).toBeVisible();
    expect(worker.serviceOwner(id)).toEqual({owner_user_id:null,revision:2});
    await form.getByRole('combobox',{name:'新的管理人'}).selectOption('user:other');
    await form.getByRole('button',{name:'更新管理人',exact:true}).click();
    await expect(page.getByRole('alertdialog')).toContainText('other@example.test');
    await page.getByRole('alertdialog').getByRole('button',{name:'更新管理人',exact:true}).click();
    await expect.poll(()=>worker.serviceOwner(id)?.revision).toBe(3);
    await expect(form.locator('[name="expected_revision"]')).toHaveValue('3');
    expect(worker.serviceOwner(id)?.owner_user_id).toBe('other');
  });

  test('human offboarding names surviving service credentials and offers a separate exact-key revoke', async ({page,worker})=>{
    await page.setViewportSize({width:390,height:900});
    const id=await worker.seedDelegatedService();const prefix=`/me/service-accounts/${id}`;
    await page.goto(prefix+'?view=keys');await createKey(page);await leaveSecret(page);
    const keyId=String(worker.keyMetadata(id)[0]!.id);
    await page.goto('/admin?view=access&person=member');
    const impact=page.locator('[data-assigned-service-impact]');
    await expect(impact).toContainText('Nightly build');await expect(impact).toContainText('Automation key');
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    await expect(impact.getByRole('link',{name:'单独撤销或更换',exact:true})).toHaveAttribute('href',prefix+'?view=keys&key='+keyId);
    const form=page.locator('[data-action="user-status"]');
    await form.getByRole('switch',{name:/启用账号/}).click();
    await expect(page.getByRole('alertdialog')).toContainText('个人 API 鉴权');
    await expect(page.getByRole('alertdialog')).toContainText('服务账号密钥仍可能用于 API 调用');
    await page.getByRole('alertdialog').getByRole('button',{name:'取消',exact:true}).click();
    expect(worker.status('member')).toBe('active');expect(worker.keyMetadata(id)[0]?.status).toBe('active');
    await form.getByRole('switch',{name:/启用账号/}).click();
    await page.getByRole('alertdialog').getByRole('button',{name:'停用账号',exact:true}).click();
    await expect(page.locator('[data-mutation-flash="user_status"]')).toBeVisible();
    expect(worker.status('member')).toBe('disabled');expect(worker.status(id)).toBe('active');expect(worker.serviceOwner(id)?.owner_user_id).toBe('member');expect(worker.keyMetadata(id)[0]?.status).toBe('active');
    await impact.getByRole('link',{name:'单独撤销或更换',exact:true}).click();
    await expect(page).toHaveURL(prefix+'?view=keys&key='+keyId);
    await page.locator(`[data-key-detail="${keyId}"]`).getByRole('button',{name:'撤销密钥',exact:true}).click();
    await page.getByRole('alertdialog').getByRole('button',{name:'撤销密钥',exact:true}).click();
    await expect(page.locator('[data-member-feedback]')).toContainText('当前列表已更新');
    expect(worker.keyMetadata(id)[0]?.status).toBe('revoked');
  });
});

test.describe('native owner removal',()=>{
  test.use({identity:'admin',script:false});
  test('native disabled-owner form requires an explicit choice before removing assignment',async({page,worker})=>{
    const id=await worker.seedDelegatedService();
    await page.goto('/admin?view=access&person=member');
    const status=page.locator('[data-action="user-status"]');await status.getByRole('checkbox').check();await status.getByRole('switch',{name:/启用账号/}).click();
    await expect(page.locator('[data-mutation-flash="user_status"]')).toBeVisible();
    await page.goto(`/admin?view=access&person=${id}`);
    const form=page.locator(`form[action="/admin/ui/services/${id}/owner"]`);
    expect(await form.evaluate(node=>(node as HTMLFormElement).checkValidity())).toBe(false);
    await form.getByRole('checkbox').check();await form.getByRole('button',{name:'更新管理人',exact:true}).click();
    expect(worker.serviceOwner(id)).toEqual({owner_user_id:'member',revision:1});
    await form.getByRole('combobox',{name:'新的管理人'}).selectOption('remove');
    await form.getByRole('button',{name:'更新管理人',exact:true}).click();
    await expect(page.locator('[data-mutation-flash="service_owner_changed"]')).toBeVisible();
    expect(worker.serviceOwner(id)).toEqual({owner_user_id:null,revision:2});
  });
});
