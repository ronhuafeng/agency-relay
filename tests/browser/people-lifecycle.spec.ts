import { test, expect } from './fixtures';
import { ORIGIN } from './worker';

// Feature-owned extension for #354; SQL races and last-admin policy stay in Vitest.
test('email-only creation rejects foreign/colliding identities and preserves a generated member result', async ({ page, worker }) => {
  await page.goto('/admin?view=access&task=add-person');
  const form = page.locator('[data-dashboard-draft="person"]');
  await expect(form.locator('input[name="id"]')).toHaveCount(0);
  const before = worker.totalKeys();
  const email = page.getByRole('textbox', { name: '组织邮箱', exact: true });
  for (const rejected of ['outsider@foreign.test', 'member@example.test']) {
    await email.fill(rejected);
    await form.getByRole('button', { name: '添加成员', exact: true }).click();
    await expect(page.locator('#add-person-error')).toBeVisible();
    await expect(email).toHaveValue(rejected);
    await expect(email).toBeFocused();
  }
  expect(worker.person('outsider@foreign.test')).toBeUndefined();
  await email.fill('new.person@example.test');
  await form.getByRole('button', { name: '添加成员', exact: true }).click();
  await expect(page.locator('[data-mutation-flash="user_created"]')).toContainText('new.person@example.test');
  await expect(page.locator('[data-mutation-flash="user_created"]')).toContainText('尚未生成密钥');
  const created = worker.person('new.person@example.test');
  expect(created?.role).toBe('user');
  expect(typeof created?.id === 'string' && created.id.startsWith('usr_')).toBe(true);
  expect(worker.totalKeys()).toBe(before);
  await expect(page.locator('[data-person-detail]')).toHaveAttribute('data-person-detail', String(created?.id));
});

test.describe('native role/email results', () => {
  test.use({ script: false });
  test('both native writes render their exact outcome and preserve the selected person', async ({ page, worker }) => {
    await page.goto('/admin?view=access&person=other&q=other&range=30d');
    const role = page.locator('form[action="/admin/ui/users/other/role"]');
    await role.getByRole('checkbox').check();
    await role.getByRole('button', { name: '设为管理员' }).click();
    await expect(page.locator('[data-mutation-flash="user_role"]')).toContainText('当前角色为管理员');
    expect(worker.person('other@example.test')?.role).toBe('admin');
    const email = page.locator('form[action="/admin/ui/users/other/email"]');
    await email.getByRole('textbox', { name: '新的组织邮箱' }).fill('renamed@example.test');
    await email.getByRole('checkbox').check();
    await email.getByRole('button', { name: '迁移邮箱' }).click();
    await expect(page.locator('[data-mutation-flash="user_email"]')).toContainText('other@example.test → renamed@example.test');
    await expect(page.locator('[data-person-detail]')).toHaveAttribute('data-person-detail', 'other');
    const current = new URL(await page.locator('main').getAttribute('data-dashboard-url') ?? '', ORIGIN);
    expect(current.searchParams.get('q')).toBe('other');
    expect(current.searchParams.get('range')).toBe('30d');
    expect(worker.person('renamed@example.test')?.id).toBe('other');
  });
});

test('self-demotion keeps the confirmed result and hands off to the personal entry', async ({ page, worker }) => {
  await page.goto('/admin?view=access&person=admin');
  await expect(page.locator('[data-confirmation-fallback]:visible')).toHaveCount(0);
  await page.getByRole('button',{name:'更改角色',exact:true}).click();
  await page.getByRole('button', { name: '设为普通成员' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: '设为普通成员' }).click();
  await expect(page.locator('[data-console-terminal-result]')).toContainText('你现在是普通成员');
  await expect(page.locator('[data-dashboard-nav]')).toHaveCount(0);
  expect(worker.person('admin@example.test')?.role).toBe('user');
  await page.getByRole('link', { name: '打开我的密钥' }).click();
  // The confirmed outcome must lead to the member UI, not a raw metadata API.
  await expect(page.getByRole('heading', { name: '我的密钥', exact: true })).toBeVisible();
  expect(worker.requests.filter((request) => request.method === 'POST' && request.path.endsWith('/role'))).toHaveLength(1);
});

test.describe('390px self-email confirmation', () => {
  test.use({ viewport: { width: 390, height: 900 } });
  test('the dialog names the submitted mailbox, then ends at reauthentication and rejects the old cookie', async ({ page, context, worker }) => {
    await page.goto('/admin?view=access&person=admin');
    await expect(page.locator('[data-confirmation-fallback]:visible')).toHaveCount(0);
    const oldCookies = await context.cookies();
    await page.getByRole('button',{name:'更改登录邮箱',exact:true}).click();
    const email = page.getByRole('textbox', { name: '新的组织邮箱' });
    await email.fill('admin.changed@example.test');
    await page.getByRole('button', { name: '迁移邮箱' }).click();
    const dialog = page.getByRole('alertdialog');
    await expect(dialog).toContainText('admin.changed@example.test');
    await expect(dialog.getByRole('button', { name: '取消' })).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(dialog.getByRole('button', { name: '迁移邮箱' })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.locator('[data-console-terminal-result]')).toContainText('旧控制台会话已失效');
    await expect(page.locator('[data-dashboard-nav]')).toHaveCount(0);
    expect(worker.person('admin.changed@example.test')?.id).toBe('admin');
    expect((await context.cookies()).some((cookie) => cookie.name === '__Host-mini-console')).toBe(false);
    // Restore only the old, now-invalid browser authority to prove a real route rejection.
    await context.addCookies(oldCookies);
    const rejected = await page.evaluate(async () => {
      const response = await fetch('/admin/ui/users/other/role', { method: 'POST', headers: { Accept: 'application/json' }, body: new URLSearchParams({ role: 'admin', confirm: '1' }) });
      return response.status;
    });
    expect(rejected).toBe(403);
    expect(worker.person('other@example.test')?.role).toBe('user');
    await page.getByRole('link', { name: '重新登录' }).click();
    await expect(page).toHaveURL(`${ORIGIN}/login`);
    await expect(page.getByRole('heading', { name: /登录/ })).toBeVisible();
  });
});
