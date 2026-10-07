import { test, expect } from './fixtures';
import { ORIGIN } from './worker';

test('admin creates and renames the exact service, then disables and enables it without login controls', async ({ page, worker }) => {
  await page.goto('/admin?view=access');
  await page.locator('#people-create-root').getByRole('button', { name: '创建服务账号', exact: true }).click();
  await expect(page.locator('#add-service')).toBeVisible();
  await page.getByRole('textbox', { name: '服务名称', exact: true }).fill('Nightly builds');
  await page.locator('#add-service').getByRole('button', { name: '创建服务账号',exact:true }).click();
  await expect(page.locator('[data-mutation-flash="service_changed"]')).toContainText('三个服务额度均为停用');
  const id = await page.locator('[data-person-detail]').getAttribute('data-person-detail');
  expect(id).toBeTruthy();
  expect(worker.serviceIdentity(id!)).toMatchObject({ account_kind: 'service', display_name: 'Nightly builds', login_capable: 0, role: 'user', status: 'active' });
  await expect(page.getByRole('button', { name: '设为管理员' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '迁移邮箱' })).toHaveCount(0);
  await expect(page.locator('#credits')).toContainText('已停用');
  await page.screenshot({ path: 'tmp/browser-results/service-created-desktop.png', fullPage: true });
  // The selected ID is unchanged while a rename is pending; it cannot prove
  // completion. Hold the real request before dispatch to exercise that boundary.
  let releaseRename!: () => void;
  let renameEntered!: () => void;
  const pendingRename = new Promise<void>(resolve => { releaseRename = resolve; });
  const renameRequested = new Promise<void>(resolve => { renameEntered = resolve; });
  const renamePath = `**/admin/ui/services/${id}/name`;
  await page.route(renamePath, async route => { renameEntered(); await pendingRename; await route.continue(); });
  await page.getByRole('textbox', { name: '服务名称', exact: true }).fill('Nightly builds renamed');
  try {
    await page.getByRole('button', { name: '保存名称' }).click();
    await renameRequested;
    await expect(page.locator('[data-person-detail]')).toHaveAttribute('data-person-detail', id!);
    expect(worker.serviceIdentity(id!)?.display_name).toBe('Nightly builds');
  } finally { releaseRename(); }
  await expect(page.locator('[data-mutation-flash="service_changed"]')).toContainText('服务名称已更新');
  await expect(page.locator('[data-mutation-flash="service_changed"]')).toContainText('Nightly builds renamed');
  await expect(page.locator('[data-person-detail]')).toHaveAttribute('data-person-detail', id!);
  expect(worker.serviceIdentity(id!)?.display_name).toBe('Nightly builds renamed');
  await page.unroute(renamePath);
  const detail = page.locator('[data-person-detail]');
  await detail.getByRole('switch', { name: /启用账号/ }).first().click();
  await page.getByRole('alertdialog').getByRole('button', { name: '停用账号', exact: true }).click();
  await expect(page.locator('[data-mutation-flash="user_status"]')).toContainText('已停用');
  expect(worker.status(id!)).toBe('disabled');
  await detail.getByRole('switch', { name: /启用账号/ }).first().click();
  await page.getByRole('alertdialog').getByRole('button', { name: '启用账号', exact: true }).click();
  await expect(page.locator('[data-mutation-flash="user_status"]')).toContainText('已启用');
  expect(worker.status(id!)).toBe('active');
  await page.goto(`/admin?view=access&person=${encodeURIComponent(id!)}`);
  await expect(page.getByRole('heading', { name: 'Nightly builds renamed', exact: true })).toBeVisible();
  expect(worker.serviceCount()).toBe(1);
  const creditRow = page.locator('[data-credit-surface="codex"]');
  const credit = page.locator(`[id="credit-policy-${id}-codex-editor"]`);
  await creditRow.getByRole('button',{name:'调整 Codex 额度',exact:true}).click();
  await credit.getByRole('combobox', { name: '策略' }).selectOption('limited');
  await credit.getByRole('spinbutton', { name: '每月额度' }).fill('12');
  await creditRow.getByRole('button',{name:'调整 Codex 额度',exact:true}).click();
  await expect(credit.getByRole('spinbutton')).toBeHidden();
  await creditRow.getByRole('button',{name:'调整 Codex 额度',exact:true}).click();
  await expect(credit.getByRole('spinbutton')).toHaveValue('12');
  await credit.getByRole('button', { name: '保存', exact: true }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.locator('[data-mutation-flash="credit_policy"]')).toContainText('Codex 额度已更新');
  expect(worker.servicePolicy(id!)).toEqual([{ surface_grant: 'surface:codex:production', monthly_allowance: 12 }]);
  await page.goto('/admin?view=access&kind=service&q=Nightly');
  await expect(page.locator('[data-user-id]')).toHaveCount(1);
  await expect(page.locator('[data-user-id]')).toHaveAttribute('data-user-id', id!);
});

test.describe('narrow keyboard classification and recovery', () => {
  test.use({ viewport: { width: 390, height: 900 } });
  test('a stale reviewed target rejects safely, then a fresh keyboard confirmation preserves the legacy allowance', async ({ page, worker }) => {
    worker.seedLegacyService('legacy-build');
    await page.goto('/admin?view=access&person=legacy-build');
    const form = page.locator('form[action="/admin/ui/services/legacy-build/classify"]');
    await form.getByRole('textbox', { name: '服务名称' }).fill('Existing build');
    worker.driftLegacyService('legacy-build');
    await form.getByRole('button', { name: '确认为服务账号' }).click();
    const dialog = page.getByRole('alertdialog');
    await expect(dialog).toContainText('legacy-build');
    await expect(dialog.getByRole('button', { name: '取消' })).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(dialog.getByRole('button', { name: '确认为服务账号' })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.locator('[data-dashboard-notice]')).toContainText('账号身份已变化');
    await expect(form.getByRole('textbox', { name: '服务名称' })).toHaveValue('Existing build');
    expect(worker.serviceIdentity('legacy-build')?.account_kind).toBe('legacy_unresolved');
    await page.screenshot({ path: 'tmp/browser-results/service-stale-narrow.png', fullPage: true });
    await page.reload();
    await form.getByRole('textbox', { name: '服务名称' }).fill('Existing build');
    await form.getByRole('button', { name: '确认为服务账号' }).click();
    await page.keyboard.press('Tab');
    await page.keyboard.press('Enter');
    await expect(page.locator('[data-mutation-flash="service_changed"]')).toContainText('原有密钥、绑定、额度、消耗和历史保留');
    expect(worker.serviceIdentity('legacy-build')).toMatchObject({ account_kind: 'service', display_name: 'Existing build' });
    expect(worker.servicePolicy('legacy-build')).toEqual([{ surface_grant: 'surface:codex:production', monthly_allowance: 17 }]);
    await page.screenshot({ path: 'tmp/browser-results/service-classified-narrow.png', fullPage: true });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
});

test.describe('native service creation', () => {
  test.use({ script: false });
  test('rejects invalid label and retains input before native successful creation', async ({ page, worker }) => {
    await page.goto('/admin?view=access&task=add-service');
    const field = page.getByRole('textbox', { name: '服务名称' });
    await field.fill('Invalid\u202ename');
    await page.locator('#add-service').getByRole('button', { name: '创建服务账号',exact:true }).click();
    await expect(page.locator('[data-mutation-input-error]')).toContainText('控制字符');
    await expect(field).toHaveValue('Invalid\u202ename');
    expect(worker.serviceCount()).toBe(0);
    await field.fill('Native build');
    await page.locator('#add-service').getByRole('button', { name: '创建服务账号',exact:true }).click();
    await expect(page.locator('[data-mutation-flash="service_changed"]')).toContainText('Native build');
    expect(worker.serviceCount()).toBe(1);
    const url = new URL(await page.locator('main').getAttribute('data-dashboard-url') ?? '', ORIGIN);
    expect(url.searchParams.get('person')).toBeTruthy();
    worker.expireSessions();
    await page.getByRole('textbox', { name: '服务名称' }).fill('Expired edit');
    await page.getByRole('button', { name: '保存名称' }).click();
    await expect(page.locator('[data-console-terminal-result]')).toContainText('这次管理操作没有执行');
    await expect(page.locator('[data-dashboard-nav]')).toHaveCount(0);
    expect(worker.serviceIdentity(url.searchParams.get('person')!)?.display_name).toBe('Native build');
  });
});
