import { test, expect, authenticate, openKeyEditor } from './fixtures';
import { buildClientSetupFiles, CLIENT_SETUP_TOKEN_PLACEHOLDER, PRODUCT_ACCESS } from '../../src/admin/client-setup';

test('configuration path copy remains usable when the Clipboard API is unavailable', async ({page}) => {
  await page.addInitScript(() => { Object.defineProperty(navigator, 'clipboard', {value: undefined, configurable: true}); });
  await page.goto('/admin?view=setup&person=member&key=member-key');
  const target = page.locator('[data-setup-selected-key="member-key"] [data-setup-client="codex"]');
  await target.getByRole('button', {name: '复制 Codex CLI 安装位置', exact: true}).click();
  await expect(target.getByRole('status')).toHaveText('无法自动复制，请选择并复制路径。');
  await expect(target.locator('code')).toHaveText('~/.codex/config.toml');
});
for (const script of [true, false]) test.describe(`contextual help with script=${script}`, () => {
  test.use({identity: 'member', script, viewport: {width: 390, height: 900}});
  test('opens task help with keyboard and returns to the same account without privileged documentation', async ({page, worker}) => {
    await page.goto('/admin?area=me&view=keys');
    await page.locator('[data-key-id="member-key"]').getByRole('link',{name:/配置客户端：/}).click();
    await page.waitForURL(/\/admin\?area=me&view=setup$/, {waitUntil: 'load'});
    const configuration = page.locator('[data-task-help="configuration"]');
    const files = buildClientSetupFiles({token: CLIENT_SETUP_TOKEN_PLACEHOLDER, scopes: Object.values(PRODUCT_ACCESS).map(item => item.grant)});
    for (const file of files) {
      if (script) await page.getByRole('tab', {name:file.clientLabel,exact:true}).click();
      const example = configuration.locator(`[data-setup-client="${file.client}"]`);
      await expect(example).toBeVisible();
      expect(await example.locator('h3').textContent()).toBe(file.filename);
      expect(await example.locator('code').textContent()).toBe(file.installTarget);
      if(script && await configuration.locator('.setup-template-disclosure').getAttribute('open') === null) await configuration.getByText('查看配置模板',{exact:true}).click();
      const templateScope = script ? configuration.locator('.setup-template-disclosure') : example;
      await expect(templateScope.locator('figure.setup-template figcaption')).toHaveText('配置模板 · 密钥为占位符');
      const template=templateScope.locator('figure.setup-template pre');
      expect(await template.getAttribute('aria-label')).toBeNull();
      await template.focus();await expect(template).toBeFocused();
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    const recovery = configuration;
    await expect(page.getByRole('button', {name:'配置说明',exact:true})).toHaveCount(1);
    await recovery.getByRole('button', {name:'配置说明',exact:true}).focus(); await page.keyboard.press('Enter');
    expect(await recovery.locator('a').evaluateAll(links=>links.map(link=>link.getAttribute('href')))).toEqual(['/admin?area=me&view=keys','/admin?area=me&view=quota']);
    await recovery.getByRole('link', {name: '只读查看本账号的密钥', exact: true}).click();
    await page.waitForURL(/\/admin\?area=me&view=keys$/, {waitUntil: 'load'});
    await expect(page.locator('[data-key-id="member-key"]')).toBeVisible();
    await page.locator('[data-key-id="member-key"]').getByRole('link', {name:'管理密钥',exact:false}).click();
    if(script) await openKeyEditor(page,'replace');
    const form=page.locator('form[action$="/member-key/replace"]');
    expect(await form.getAttribute('data-confirmation')).toContain('旧密钥在到期或另行撤销之前仍可认证');
    expect(worker.requests.every(request => request.method === 'GET')).toBe(true);
  });
});

for (const script of [true, false]) test.describe(`assigned-service contextual help with script=${script}`, () => {
  test.use({identity: 'member', script, viewport: {width: 390, height: 900}});
  test('keeps setup and recovery navigation in the exact assigned service', async ({page, worker}) => {
    const service = await worker.seedDelegatedService();
    const prefix = `/me/service-accounts/${service}?view=`;
    await page.goto(prefix + 'keys');
    await page.getByRole('navigation',{name:'成员页面'}).getByRole('link',{name:'客户端配置',exact:true}).click();
    await page.waitForURL(prefix + 'setup', {waitUntil: 'load'});
    await expect(page.getByRole('heading', {name: 'Nightly build · 客户端配置', exact: true})).toBeVisible();
    const recovery = page.locator('[data-task-help="configuration"]');
    await expect(page.getByRole('button', {name:'配置说明',exact:true})).toHaveCount(1);
    await recovery.getByRole('button', {name:'配置说明',exact:true}).focus(); await page.keyboard.press('Enter');
    await expect(recovery.getByRole('link', {name: '只读查看本账号的密钥', exact: true})).toHaveAttribute('href', prefix + 'keys');
    await expect(recovery.getByRole('link', {name: '查看本账号的额度', exact: true})).toHaveAttribute('href', prefix + 'quota');
    await recovery.getByRole('link', {name: '只读查看本账号的密钥', exact: true}).click();
    await page.waitForURL(prefix + 'keys', {waitUntil: 'load'});
    await expect(page.locator('[data-service-id]')).toHaveAttribute('data-service-id', service);
    await expect(page.locator('[data-key-id="member-key"]')).toHaveCount(0);
    expect(worker.requests.every(request => request.method === 'GET')).toBe(true);
  });
});

for (const owner of ['personal','delegated','administrator'] as const) test(`local ${owner} client choice matches its download and displayed destination`, async ({page,context,worker}) => {
  const service = owner === 'delegated' ? await worker.seedDelegatedService() : null;
  await authenticate(context,worker,owner === 'administrator' ? 'admin' : 'member');
  await page.goto(service ? `/me/service-accounts/${service}?view=setup` : owner === 'administrator' ? '/admin?view=setup' : '/admin?area=me&view=setup');
  const form = page.locator('[data-local-config-sync]');
  await expect(form).toBeVisible();
  // Invalid fixture input has no corresponding key hash or server authority.
  await form.getByLabel('已有密钥',{exact:true}).fill('cfwd_invalid');
  const expected = buildClientSetupFiles({token:'cfwd_invalid',scopes:Object.values(PRODUCT_ACCESS).map(item=>item.grant)});
  for (const file of expected) {
    await page.getByRole('tab',{name:file.clientLabel,exact:true}).click();
    const displayed = page.locator(`[data-task-help="configuration"] [data-setup-client="${file.client}"]`);
    await expect(displayed).toBeVisible();
    await expect(displayed.getByRole('heading',{level:3})).toHaveText(file.filename);
    await expect(displayed.locator('.setup-destination code')).toHaveText(file.installTarget);
    const template=page.locator('.setup-template-disclosure');
    if(await template.getAttribute('open') === null) await template.locator('summary').click();
    await expect(template.locator('pre')).toBeVisible();
    await expect(template.locator('figure.setup-template figcaption')).toHaveText('配置模板 · 密钥为占位符');
    expect(await template.locator('pre').getAttribute('aria-label')).toBeNull();
    const result = page.waitForEvent('download');
    await form.getByRole('button',{name:'下载配置文件',exact:true}).click();
    const download = await result;
    expect(download.suggestedFilename()).toBe(file.filename);
    const stream = await download.createReadStream();
    expect(Boolean(stream)).toBe(true);
    if (!stream) throw new Error('Fixture download stream unavailable');
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(Buffer.from(chunk));
    expect(Buffer.concat(chunks).toString('utf8') === file.content,'Generated bytes match the chosen public client template').toBe(true);
  }
  expect(worker.requests.every(request=>request.method==='GET')).toBe(true);
});
