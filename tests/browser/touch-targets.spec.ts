import { writeFileSync } from 'node:fs';
import type { Locator, Page, TestInfo } from '@playwright/test';
import { test, expect, authenticate, openMemberCreate, openKeyEditor } from './fixtures';

// Scope: primary actions, navigation, editable fields and the actual associated
// labels of compact checkbox/radio indicators. Inline prose links are not actions.
const targets = [
  'button:not([role="checkbox"]):not([role="radio"]):not(:disabled)',
  '[data-slot="button"]', '.identity a', '.nav-rail a', '.action-link',
  '.nav-toggle-label', '.section-links a', '.ranges a', '.person-link', '.account-link',
  '.linked-key-link', '.console-simple .keys a',
  '[data-slot="input"]:not(:disabled)', '[data-slot="native-select"]:not(:disabled)',
  '.radix-check label', 'label.radix-check', '.access-choice > label',
  'label.confirmation-fallback'
].join(',');

async function inventory(scope: Locator) {
  return scope.locator(targets).evaluateAll((elements) => elements.filter((element) => {
    const box = element.getBoundingClientRect();
    // Closed native details can retain layout bounds for unrendered descendants.
    // Measure rendered controls only; the expanded key detail is measured below.
    return element.checkVisibility() && box.width > 0 && box.height > 0 && getComputedStyle(element).visibility !== 'hidden';
  }).map((element) => {
    const box = element.getBoundingClientRect();
    const label = element.getAttribute('aria-label') ?? (element instanceof HTMLInputElement || element instanceof HTMLSelectElement
      ? Array.from(element.labels ?? []).map((item) => item.textContent?.trim()).join(' ') : element.textContent?.trim()) ?? '';
    return {
      name: label.replace(/\s+/g, ' ').slice(0, 120), tag: element.tagName.toLowerCase(),
      width: box.width, height: box.height, font: Number.parseFloat(getComputedStyle(element).fontSize),
      editable: element.matches('input,select,textarea'),
      zone: element.closest('[role="alertdialog"]') ? 'dialog' : element.closest('.nav-rail') ? 'navigation' : element.closest('.site-header') ? 'header' : 'content',
      x: box.x, y: box.y
    };
  }));
}

async function inspect(page: Page, testInfo: TestInfo, name: string, width: number, scope = page.locator('body')) {
  await page.evaluate(() => document.fonts.ready);
  await expect.poll(() => page.locator('[data-one-time-key],[data-created-token]').count()).toBe(0);
  const controls = await inventory(scope);
  expect(controls.length).toBeGreaterThan(0);
  expect(controls.every((control) => control.name.length > 0), `${name}: accessible control names`).toBe(true);
  const report = {
    surface: name, viewport: width,
    ...await page.evaluate(() => ({
      documentWidth: document.documentElement.scrollWidth,
      rootFont: Number.parseFloat(getComputedStyle(document.documentElement).fontSize),
      colorScheme: matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
    })),
    controls
  };
  expect(report.rootFont, 'Root typography remains unchanged').toBe(14);
  // Only display fixtures, names and geometry are retained, never field values,
  // full HTML, session cookies or the result of a secret-generating operation.
  const geometryPath = testInfo.outputPath(`${name}-geometry.json`);
  writeFileSync(geometryPath, JSON.stringify(report, null, 2));
  await testInfo.attach(`${name} geometry`, { path: geometryPath, contentType: 'application/json' });
  await page.evaluate(() => scrollTo(0, 0));
  const path = testInfo.outputPath(`safe-${name}.png`);
  await page.screenshot({ path, animations: 'disabled', fullPage: true });
  await testInfo.attach(`${name} display fixture`, { path, contentType: 'image/png' });
  expect.soft(controls.filter((control) => control.width < 44 || control.height < 44), `${name}: actual 44×44 CSS pixel targets`).toEqual([]);
  if (width < 600) expect.soft(controls.filter((control) => control.editable && control.font < 16), `${name}: phone input font`).toEqual([]);
  // Existing narrow person-credit table layout belongs to #360. It is contained
  // by its scroller; this gate rejects page-level horizontal overflow instead.
  expect.soft(report.documentWidth, `${name}: page overflow`).toBeLessThanOrEqual(width + 1);
  const overlaps: Array<{ first: string; second: string }> = [];
  controls.forEach((first, index) => controls.slice(index + 1).forEach((second) => {
    if (first.zone !== second.zone) return;
    const sharedWidth = Math.min(first.x + first.width, second.x + second.width) - Math.max(first.x, second.x);
    const sharedHeight = Math.min(first.y + first.height, second.y + second.height) - Math.max(first.y, second.y);
    if (sharedWidth > 1 && sharedHeight > 1) overlaps.push({ first: first.name, second: second.name });
  }));
  expect.soft(overlaps, `${name}: adjacent targets do not overlap`).toEqual([]);
  return controls;
}

async function reachable(control: Locator) {
  await expect(control).toBeVisible();
  const box = await control.boundingBox();
  expect(box).not.toBeNull();
  // Trial clicks prove that the corners belong to this target without submitting
  // login, opening OAuth or changing fixture data merely to measure geometry.
  await control.click({ trial: true, position: { x: 4, y: 4 } });
  await control.click({ trial: true, position: { x: box!.width - 4, y: box!.height - 4 } });
}

for (const viewport of [{width:390,height:300}, {width:320,height:300}]) test.describe(`short confirmation ${viewport.width}px`, () => {
  test.use({viewport});
  test('a long account identity stays inside the dialog and both actions remain reachable', async ({page,worker}) => {
    worker.seedRemainingLayouts();
    await page.goto('/admin?view=access&person=layout-long');
    const trigger = page.getByRole('switch',{name:/启用账号/});
    await trigger.click();
    const dialog = page.getByRole('alertdialog');
    await expect(dialog).toBeVisible();
    const box = await dialog.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0); expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width);
    expect(box!.y).toBeGreaterThanOrEqual(0); expect(box!.y + box!.height).toBeLessThanOrEqual(viewport.height);
    expect(await dialog.evaluate(node=>node.scrollWidth<=node.clientWidth)).toBe(true);
    const cancel = dialog.getByRole('button',{name:'取消',exact:true});
    await expect(cancel).toBeFocused();
    await page.keyboard.press('Tab');
    const action = dialog.getByRole('button',{name:'停用账号',exact:true});
    await expect(action).toBeFocused();
    await reachable(action); await reachable(cancel);
    await cancel.click();
    await expect(dialog).toHaveCount(0); await expect(trigger).toBeFocused();
    expect(worker.status('layout-long')).toBe('active');
    expect(worker.requests.every(request=>request.method==='GET')).toBe(true);
  });
});

async function visibleFocus(control: Locator) {
  await expect(control).toBeFocused();
  expect(await control.evaluate((element) => {
    const style = getComputedStyle(element);
    return element.matches(':focus-visible') && style.outlineStyle !== 'none' && Number.parseFloat(style.outlineWidth) >= 2;
  })).toBe(true);
}

for (const width of [320, 390, 768, 1440]) for (const colorScheme of ['light', 'dark'] as const) {
  test.describe(`44px targets at ${width}px ${colorScheme}`, () => {
    test.use({ viewport: { width, height: 900 }, colorScheme });
    test('login, member, admin and confirmation preserve measured targets and keyboard access', async ({ page, context, worker }, testInfo) => {
      await context.clearCookies();
      await page.goto('/login');
      await inspect(page, testInfo, 'login', width);
      const login = page.getByRole('button', { name: '使用飞书继续' });
      await reachable(login);
      await login.focus();
      await page.keyboard.press('Tab');
      await page.keyboard.press('Shift+Tab');
      await visibleFocus(login);

      await authenticate(context, worker, 'member');
      await page.goto('/admin?view=keys');
      await expect(page.locator('[data-confirmation-fallback]:visible')).toHaveCount(0);
      await inspect(page, testInfo, 'member-keys', width);
      const headerContainsActions = await page.locator('.member-keys-table').evaluate(table => {
        const header = table.querySelector('thead')!.getBoundingClientRect();
        const firstKey = table.querySelector('tr[data-key-id]')!.getBoundingClientRect();
        return [...table.querySelectorAll('thead [data-member-create-toggle],thead button[popovertarget]')].every(control => control.getBoundingClientRect().bottom <= header.bottom + 1)
          && header.bottom <= firstKey.top + 1;
      });
      expect(headerContainsActions).toBe(true);
      await openMemberCreate(page);
    const name = page.getByRole('textbox', { name: '名称', exact: true });
      await name.focus();
      await page.keyboard.press('Tab');
      await visibleFocus(page.getByRole('checkbox', { name: 'Codex', exact: true }));
      const codexLabel = page.locator('label[for="check-surfaces-codex"]');
      await reachable(codexLabel);
      await codexLabel.click({ position: { x: 4, y: 4 } });
      await expect(page.getByRole('checkbox', { name: 'Codex', exact: true })).toBeChecked();
      await reachable(page.locator('[data-member-key-create]').getByRole('button', { name: '创建密钥', exact: true }));
      // Full-page images place fixed navigation at its viewport position. Keep a
      // viewport image after actual scrolling to show the action above that rail.
      const reachablePath = testInfo.outputPath('safe-member-primary-reachable.png');
      await page.screenshot({ path: reachablePath, animations: 'disabled' });
      await testInfo.attach('member primary action viewport', { path: reachablePath, contentType: 'image/png' });
      await page.locator('thead .member-bulk-actions > button').click();
      await reachable(page.locator('#key-bulk-actions').getByRole('button', { name: '撤销我的全部密钥', exact: true }));
      await page.locator('[data-key-id="member-key"]').getByRole('link', {name:'管理密钥',exact:false}).click();
      await openKeyEditor(page, 'rename');
      await expect(page.locator('[data-key-detail="member-key"] input[name="name"]')).toBeVisible();
      await inspect(page, testInfo, 'member-key-detail', width);
      await openKeyEditor(page, 'replace');
    await page.getByRole('button', { name: '更换', exact: true }).click();
      const dialog = page.getByRole('alertdialog');
      await expect(dialog).toBeVisible();
      await inspect(page, testInfo, 'member-confirmation', width, dialog);
      const cancel = dialog.getByRole('button', { name: '取消', exact: true });
      await expect(cancel).toBeFocused();
      await page.keyboard.press('Tab');
      await visibleFocus(dialog.getByRole('button', { name: '更换', exact: true }));
      await page.keyboard.press('Shift+Tab');
      await visibleFocus(cancel);
      await reachable(cancel);
      await cancel.click();
      await expect(dialog).toHaveCount(0);
      await expect(page.getByRole('button', { name: '更换', exact: true })).toBeFocused();

      await authenticate(context, worker, 'admin');
      await page.goto('/admin?view=access');
      await inspect(page, testInfo, 'admin-people', width);
      await reachable(page.getByRole('button', { name: '搜索邮箱、名称或 ID', exact: true }));

      await page.locator('[data-user-id="other"] .person-link').click();
      await expect(page.locator('[data-person-detail="other"]')).toBeVisible();
      await inspect(page, testInfo, 'admin-person', width);
      await page.getByRole('button',{name:'更改登录邮箱',exact:true}).click();
      await reachable(page.getByRole('button', { name: '迁移邮箱', exact: true }));
      const disable = page.getByRole('switch', { name: /启用账号/ });
      await disable.click();
      await expect(dialog).toBeVisible();
      await inspect(page, testInfo, 'admin-confirmation', width, dialog);
      await expect(dialog.getByRole('button', { name: '取消', exact: true })).toBeFocused();
      await page.keyboard.press('Tab');
      await visibleFocus(dialog.getByRole('button', { name: '停用账号', exact: true }));
      await reachable(dialog.getByRole('button', { name: '停用账号', exact: true }));
      await page.keyboard.press('Escape');
      await expect(dialog).toHaveCount(0);
      await expect(disable).toBeFocused();
      expect(worker.status('other')).toBe('active');
      if (width < 1000) await page.locator('.nav-toggle-label').click();
      await page.getByRole('navigation', { name: '控制台页面' }).getByRole('link', { name: '额度政策', exact: true }).click();
      await expect(page.locator('[data-view-role="quotas"]')).toBeVisible();
      await inspect(page, testInfo, 'admin-quotas', width);
      await reachable(page.locator('.organization-policy-form').getByRole('button', { name: '保存', exact: true }));
      await page.goto('/admin?view=credentials&task=add-account');
      await expect(page.getByRole('radio', { name: 'ChatGPT', exact: true })).toBeVisible();
      await inspect(page, testInfo, 'admin-add-account', width);
      await page.locator('label[for="add-grok"]').click({ position: { x: 4, y: 4 } });
      await expect(page.getByRole('radio', { name: 'Grok', exact: true })).toBeChecked();
      await reachable(page.getByRole('button', { name: '添加账号', exact: true }));
      expect(worker.requests.filter((request) => request.method === 'POST')).toHaveLength(0);
    });
  });
}

for (const scenario of [{ width: 320, colorScheme: 'dark' }, { width: 1440, colorScheme: 'light' }] as const) {
  test.describe(`native target labels at ${scenario.width}px`, () => {
    test.use({ viewport: { width: scenario.width, height: 900 }, colorScheme: scenario.colorScheme, script: false, identity: 'member' });
    test('native confirmation and checkbox labels retain their real click area', async ({ page, context, worker }, testInfo) => {
      await page.goto('/admin?view=keys');
      await inspect(page, testInfo, 'native-member-keys', scenario.width);
      await page.locator('[data-key-id="member-key"]').getByRole('link', {name:'管理密钥',exact:false}).click();
      await inspect(page, testInfo, 'native-member-key-detail', scenario.width);
      const confirmation = page.locator('form[action="/me/ui/keys/member-key/replace"] label.confirmation-fallback');
      await reachable(confirmation);
      await confirmation.click({ position: { x: 4, y: 4 } });
      await expect(confirmation.getByRole('checkbox')).toBeChecked();
      await confirmation.getByRole('checkbox').press('Space');
      await expect(confirmation.getByRole('checkbox')).not.toBeChecked();
      await authenticate(context, worker, 'admin');
      await page.goto('/admin?view=access&person=other');
      await inspect(page, testInfo, 'native-admin-person', scenario.width);
      await reachable(page.getByRole('switch', { name: /启用账号/ }));
      expect(worker.requests.filter((request) => request.method === 'POST')).toHaveLength(0);
    });
  });
}

test.describe('enlarged content', () => {
  test.use({ viewport: { width: 1440, height: 1000 }, identity: 'member' });
  test('200% CSS zoom preserves the editable value and keyboard confirmation', async ({ page, worker }, testInfo) => {
    await page.goto('/admin?view=keys');
    await expect(page.locator('[data-confirmation-fallback]:visible')).toHaveCount(0);
    await openMemberCreate(page);
    const name = page.getByRole('textbox', { name: '名称', exact: true });
    await name.fill('Synthetic workstation with enlarged content');
    // CSS zoom exercises enlarged content in both native engines. This is not
    // evidence of a physical device or an OS/browser chrome zoom setting.
    await page.evaluate(() => { document.documentElement.style.zoom = '2'; });
    await expect(name).toHaveValue('Synthetic workstation with enlarged content');
    // The underlying collection must reflow too; a contained modal alone does
    // not prove the creation form and expanded inventory remain usable.
    await inspect(page, testInfo, 'enlarged-member-keys', 1440);
    const creation = await page.locator('[data-member-create-row]').boundingBox();
    const inventory = await page.locator('.member-key-inventory').boundingBox();
    expect(creation).not.toBeNull();
    expect(inventory).not.toBeNull();
    expect(creation!.y).toBeGreaterThanOrEqual(inventory!.y);
    expect(creation!.y + creation!.height).toBeLessThanOrEqual(inventory!.y + inventory!.height);
    await expect(page.locator('.member-key-inventory thead [data-member-create-toggle]')).toBeVisible();
    await page.locator('[data-key-id="member-key"]').getByRole('link', {name:'管理密钥',exact:false}).click();
    await page.evaluate(() => { document.documentElement.style.zoom = '2'; });
    await inspect(page, testInfo, 'enlarged-member-key-detail', 1440);
    const selectedName = page.locator('form[action="/me/ui/keys/member-key/rename"] input[name="name"]');
    await openKeyEditor(page, 'rename');
    await selectedName.fill('Synthetic selected key with enlarged content');
    await openKeyEditor(page, 'replace');
    await page.getByRole('button', { name: '更换', exact: true }).click();
    const dialog = page.getByRole('alertdialog');
    await expect(dialog).toBeVisible();
    await inspect(page, testInfo, 'enlarged-confirmation', 1440, dialog);
    await page.keyboard.press('Tab');
    await visibleFocus(dialog.getByRole('button', { name: '更换', exact: true }));
    await reachable(dialog.getByRole('button', { name: '取消', exact: true }));
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(page.getByRole('button', { name: '更换', exact: true })).toBeFocused();
    await inspect(page, testInfo, 'enlarged-member-cancelled', 1440);
    await expect(selectedName).toHaveValue('Synthetic selected key with enlarged content');
    expect(worker.requests.filter((request) => request.method === 'POST')).toHaveLength(0);
  });
});
