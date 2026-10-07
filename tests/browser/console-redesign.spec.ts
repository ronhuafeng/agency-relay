import { test, expect, authenticate, openMemberCreate } from './fixtures';
import { NOW } from './worker';

test('service admission is confirmed and enabling requires a reviewed policy', async ({page, worker}) => {
  await page.goto('/admin?view=access&person=member');
  const row = page.locator('[data-credit-user=member][data-credit-surface=codex]');
  const admission = row.locator('[role=switch]');
  await expect(admission).toBeChecked();
  await admission.click();
  await expect(admission).toBeChecked();
  await page.getByRole('alertdialog').getByRole('button',{name:'取消',exact:true}).click();
  expect(worker.requests.filter(request=>request.method==='POST')).toHaveLength(0);
  await admission.click();
  await page.getByRole('alertdialog').getByRole('button',{name:'停用 Codex',exact:true}).click();
  await expect(page.locator('[data-mutation-flash=credit_policy]')).toHaveText('Codex 额度已更新');
  await expect(admission).not.toBeChecked();
  expect(worker.keyMetadata().find(key=>key.id==='member-key')?.status).toBe('active');
  await admission.click();
  const editor = page.locator('#credit-policy-member-codex-editor');
  await expect(editor).toBeVisible();
  await expect(admission).not.toBeChecked();
  expect(worker.requests.filter(request=>request.method==='POST')).toHaveLength(1);
  await editor.getByRole('spinbutton').fill('28');
  await editor.getByRole('button',{name:'保存',exact:true}).click();
  await page.getByRole('alertdialog').getByRole('button',{name:'保存',exact:true}).click();
  await expect(admission).toBeChecked();
  await expect(row).toContainText('28');
  expect(worker.servicePolicy('member')).toEqual(expect.arrayContaining([expect.objectContaining({monthly_allowance:28})]));
  await row.getByRole('button',{name:'调整 Codex 额度',exact:true}).click();
  await editor.getByRole('button',{name:'使用组织默认',exact:true}).click();
  await page.getByRole('alertdialog').getByRole('button',{name:'使用组织默认',exact:true}).click();
  await expect(row).toContainText('组织默认');
  expect(worker.servicePolicy('member')).toHaveLength(0);
  expect(worker.requests.filter(request=>request.method==='POST').every(request=>request.path==='/admin/ui/users/member/credits/codex')).toBe(true);
});

test('a changed read waits for an open policy editor even without a changed field', async ({page, worker}) => {
  await page.clock.install({time:new Date(NOW)});
  await page.goto('/admin?view=access&person=member');
  await page.getByRole('button',{name:'调整 Codex 额度',exact:true}).click();
  const editor=page.locator('#credit-policy-member-codex-editor');
  await page.locator('main#content').focus();
  const revision=await page.locator('main').getAttribute('data-console-revision');
  worker.expireKey('member-key'); worker.advanceClock(120000);
  await page.clock.fastForward(120000);
  await expect(page.locator('[data-console-status]')).toHaveText('有新数据');
  await expect(editor).toBeVisible();
  expect(await page.locator('main').getAttribute('data-console-revision')).toBe(revision);
  expect(worker.requests.every(request=>request.method==='GET')).toBe(true);
});

test('service tabs retain exact hash, independent filters and keyboard selection', async ({page, worker}) => {
  worker.seedAdminLayouts();
  await page.goto('/admin?view=surfaces#route-host-1-title');
  await expect(page.getByRole('tab',{name:'Grok',exact:true})).toHaveAttribute('aria-selected','true');
  await expect(page.locator('[data-surface-hostname="api.trustedtunnel.app"]')).toBeHidden();
  await page.getByRole('tab',{name:'Codex',exact:true}).click();
  const codex=page.locator('[data-surface-hostname="api.trustedtunnel.app"]');
  await codex.getByRole('searchbox').fill('/v1/responses');
  await page.getByRole('tab',{name:'Grok',exact:true}).click();
  await page.getByRole('tab',{name:'Grok',exact:true}).focus();
  await page.keyboard.press('ArrowLeft');
  await expect(page.getByRole('tab',{name:'Codex',exact:true})).toBeFocused();
  await expect(codex.getByRole('searchbox')).toHaveValue('/v1/responses');
  await expect(codex.locator('[data-route-id="codex.models"]')).toBeHidden();
  expect(worker.requests.filter(request=>request.method==='POST')).toHaveLength(0);
});

test('member creation opens on demand and cancel preserves its safe draft', async ({page, context, worker}) => {
  await authenticate(context,worker,'member');
  await page.goto('/admin?area=me&view=keys&key=member-key');
  await expect(page.locator('.member-keys-table [data-key-id=member-key]')).toBeVisible();
  await expect(page.locator('[data-key-detail=member-key]')).toBeVisible();
  await expect(page.locator('[data-member-key-create]')).toBeHidden();
  await openMemberCreate(page);
  const form=page.locator('[data-member-key-create]');
  await form.getByRole('textbox',{name:'名称',exact:true}).fill('Unfinished device');
  await form.getByRole('link',{name:'取消',exact:true}).click();
  await expect(form).toBeHidden();
  await expect(page.locator('a[data-member-create-toggle]')).toBeFocused();
  await openMemberCreate(page);
  await expect(form.getByRole('textbox',{name:'名称',exact:true})).toHaveValue('Unfinished device');
  expect(worker.requests.every(request=>request.method==='GET')).toBe(true);
});

test('administrator service switches stage only the reviewed new-key grants', async ({page, worker}) => {
  await page.goto('/admin?view=access&person=member&task=give-access');
  const form = page.locator('form[data-dashboard-draft=access]');
  const codex = form.getByRole('switch', {name:'新密钥包含 Codex',exact:true});
  const grok = form.getByRole('switch', {name:'新密钥包含 Grok',exact:true});
  await expect(codex).not.toBeChecked();
  await codex.click();
  await grok.click();
  await grok.click();
  expect(worker.requests.filter(request=>request.method==='POST')).toHaveLength(0);
  await form.getByRole('textbox', {name:'密钥名称',exact:true}).fill('Reviewed workstation');
  await form.getByRole('combobox', {name:'Codex 账号',exact:true}).selectOption({index:1});
  expect(await form.evaluate(node=>new FormData(node as HTMLFormElement).getAll('clients'))).toEqual(['codex']);
  const before = worker.keyMetadata().length;
  const result = page.waitForResponse(response=>response.request().method()==='POST' && response.url().endsWith('/admin/ui/keys'));
  await form.getByRole('button', {name:'创建密钥',exact:true}).click();
  expect((await result).status()).toBe(200);
  const keys = worker.keyMetadata();
  expect(keys).toHaveLength(before + 1);
  await page.getByRole('button',{name:'手动复制密钥',exact:true}).click();
  try { await expect.poll(()=>page.locator('[data-created-token]').count()).toBe(1); }
  catch (error) {
    console.info('admin-created-diagnostic', JSON.stringify({mutation:await page.locator('main').getAttribute('data-dashboard-mutation'),resultContainers:await page.locator('[data-one-time-key]').count(),recovery:await page.locator('[data-console-recovery]').count(),notice:await page.locator('[data-dashboard-notice]').getAttribute('data-state')}));
    throw error;
  }
  const created = keys.find(key=>key.name==='Reviewed workstation');
  expect(typeof created?.id).toBe('string');
  expect(worker.keyGrants(String(created!.id))).toEqual(['surface:codex:production']);
  expect(worker.requests.filter(request=>request.method==='POST' && request.path==='/admin/ui/keys')).toHaveLength(1);
});
