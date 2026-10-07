import type { Locator, Page } from "@playwright/test";
import { test, expect } from "./fixtures";

async function submit(page: Page, form: Locator, button: Locator, script: boolean, label: string) {
  if (!script) await form.locator('[data-confirmation-fallback] input').check();
  await button.click();
  if (script) {
    const dialog = page.getByRole('alertdialog');
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', {name: label, exact: true}).click();
  }
}

for (const script of [true, false]) test.describe(`credential tasks script ${script}`, () => {
  test.use({script, viewport: {width: script ? 1440 : 390, height: 900}});
  test('confirmation protects default changes and retains existing key mappings', async ({page, worker}) => {
    worker.seedCredentialTasks();
    const before = worker.credentialBindings();
    await page.goto('/admin?view=credentials');
    const form = page.locator('#default-grok');
    const save = page.getByRole('button', {name: '保存 Grok 默认连接', exact: true});
    const saveGeometry = await save.evaluate(button => {
      const text = document.createRange(); text.selectNodeContents(button);
      const box = button.getBoundingClientRect();
      return {width: box.width, height: box.height, lines: text.getClientRects().length};
    });
    expect(saveGeometry.width).toBeGreaterThanOrEqual(44);
    expect(saveGeometry.height).toBeGreaterThanOrEqual(44);
    expect(saveGeometry.lines).toBe(1);
    await form.getByRole('combobox').selectOption('task-new');
    if (script) {
      await expect(page.locator('[data-confirmation-fallback]:visible')).toHaveCount(0);
      await save.click();
      const dialog = page.getByRole('alertdialog');
      await expect(dialog).toContainText('Synthetic task-new');
      await dialog.getByRole('button', {name: '取消', exact: true}).click();
      await expect(save).toBeFocused();
    } else {
      // The native required checkbox prevents submission until the human confirms.
      await save.click();
      await expect(form.locator('[data-confirmation-fallback] input')).not.toBeChecked();
    }
    expect(worker.requests.filter(request => request.method === 'POST')).toHaveLength(0);
    expect(worker.credentialDefaults().every(row => row.subscription_account_id === 'task-old')).toBe(true);
    await submit(page, form, save, script, '保存');
    await expect(page.locator('[data-mutation-flash="credential_default"]')).toContainText('Grok 默认连接已更新');
    expect(worker.credentialBindings()).toEqual(before);
    expect(worker.credentialDefaults()).toEqual([
      {surface_grant: 'surface:grok:production', subscription_account_id: 'task-new'},
      {surface_grant: 'surface:xai:production', subscription_account_id: 'task-old'}
    ]);
    expect(worker.requests.filter(request => request.method === 'POST' && request.path === '/admin/ui/credential-defaults/grok')).toHaveLength(1);
  });

  test('explicit migration keeps unselected work, then separates disconnect from cleanup', async ({page, worker}) => {
    worker.seedCredentialTasks();
    const before = worker.credentialBindings();
    await page.goto('/admin?view=credentials&account=grok%3Atask-old');
    const migration = page.locator('[data-action="credential-migrate"]');
    await page.getByText('迁移绑定与默认连接', {exact: true}).click();
    await migration.getByRole('combobox', {name: '替代连接', exact: true}).selectOption('task-new');
    await migration.locator('input[name="key_ids[]"][value="task-move"]').check();
    await migration.locator('input[name="default_surfaces[]"][value="grok"]').check();
    await submit(page, migration, migration.getByRole('button', {name: '迁移所选项目', exact: true}), script, '迁移所选项目');
    await expect(page.locator('[data-mutation-flash="credential_migrated"]')).toContainText('2 项密钥绑定、1 项默认连接已迁移');
    expect(worker.credentialStatus('task-old')).toBe('retiring');
    expect(worker.credentialCleanupCalls).toEqual([]);
    expect(worker.credentialBindings().filter(row => row.api_key_id === 'task-keep')).toEqual(before.filter(row => row.api_key_id === 'task-keep'));
    expect(worker.credentialDefaults().find(row => row.surface_grant === 'surface:xai:production')?.subscription_account_id).toBe('task-old');
    await expect(page.locator('[data-action="logout-grok"] button')).toBeDisabled();

    // Use the provided read boundary; do not reload the native POST response.
    await page.locator('[data-mutation-flash="credential_migrated"]').getByRole('link', {name: '查看当前连接', exact: true}).click();
    await page.getByText('迁移绑定与默认连接', {exact: true}).click();
    await migration.getByRole('combobox', {name: '替代连接', exact: true}).selectOption('task-new');
    await migration.locator('input[name="key_ids[]"][value="task-keep"]').check();
    await migration.locator('input[name="default_surfaces[]"][value="xai"]').check();
    await submit(page, migration, migration.getByRole('button', {name: '迁移所选项目', exact: true}), script, '迁移所选项目');
    await expect(page.locator('[data-mutation-flash="credential_migrated"]')).toBeVisible();
    expect(worker.credentialBindings().every(row => row.subscription_account_id === 'task-new')).toBe(true);
    const moved = worker.credentialBindings();
    worker.failCredentialCleanup(true);
    const disconnect = page.locator('[data-action="logout-grok"]');
    await submit(page, disconnect, disconnect.getByRole('button'), script, '断开');
    await expect(page.locator('[data-mutation-flash="credential_disconnected"]')).toContainText('连接已断开，令牌清理未确认');
    expect(worker.credentialStatus('task-old')).toBe('revoked');
    expect(worker.credentialCleanupCalls).toEqual(['subscription:task-old']);
    worker.failCredentialCleanup(false);
    const cleanup = page.locator('[data-action="credential-cleanup"]');
    await submit(page, cleanup, cleanup.getByRole('button', {name: '重试清理', exact: true}), script, '重试清理');
    await expect(page.locator('[data-mutation-flash="credential_cleanup"]')).toContainText('令牌清理已确认');
    expect(worker.credentialStatus('task-old')).toBe('revoked');
    expect(worker.credentialBindings()).toEqual(moved);
    expect(worker.requests.filter(request => request.method === 'POST' && request.path === '/admin/ui/subscriptions/task-old/logout')).toHaveLength(1);
    expect(await page.locator('[data-one-time-key],[data-created-token]').count()).toBe(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  });
});
