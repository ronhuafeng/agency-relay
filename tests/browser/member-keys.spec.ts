import { test, expect, authenticate, openKeyEditor } from './fixtures';
import { ORIGIN } from './worker';

test.use({identity:'member'});
for(const failure of ['quota','defaults'] as const) test(`known key remains manageable after ${failure} read failure`,async({page,worker})=>{
  worker.failMemberRead(failure);
  await page.goto('/admin?area=me&view=keys&key=member-key');
  const key=page.locator('[data-key-detail="member-key"]');
  await openKeyEditor(page, 'rename');
  await expect(key.getByRole('textbox',{name:'密钥名称',exact:true})).toBeVisible();
  await openKeyEditor(page, 'rename');
  await key.getByRole('textbox',{name:'密钥名称',exact:true}).fill('Laptop');
  await openKeyEditor(page, 'rename');
  await key.getByRole('button',{name:'保存名称',exact:true}).click();
  await expect(page.locator('[data-member-feedback]')).toContainText('名称已保存');
  expect(worker.keyMetadata().find(key=>key.id==='member-key')?.name).toBe('Laptop');
  await key.getByRole('button',{name:'撤销密钥',exact:true}).click();
  await page.getByRole('alertdialog').getByRole('button',{name:'撤销密钥',exact:true}).click();
  await expect(page.locator('[data-member-feedback]')).toContainText('密钥已撤销');
  expect(worker.keyMetadata().find(key=>key.id==='member-key')?.status).toBe('revoked');
});

test('a confirmed revoke survives a failed list refresh without a duplicate write',async({page,worker})=>{
  await page.goto('/admin?area=me&view=keys&key=member-key');
  const refresh=worker.hold({method:'GET',path:'/admin',view:'keys'});
  await page.locator('[data-key-detail="member-key"]').getByRole('button',{name:'撤销密钥',exact:true}).click();
  await page.getByRole('alertdialog').getByRole('button',{name:'撤销密钥',exact:true}).click();
  await refresh.entered;refresh.release(503);
  await expect(page.locator('[data-member-feedback]')).toContainText('密钥已撤销');
  await expect(page.locator('[data-member-feedback]')).toContainText('列表未刷新');
  await expect(page.locator('[data-member-feedback]')).not.toContainText('操作结果尚未确认');
  expect(worker.requests.filter(request=>request.method==='POST'&&request.path.endsWith('/revoke'))).toHaveLength(1);
  const recovery=page.locator('[data-member-feedback]').getByRole('link',{name:'查看当前密钥',exact:true});
  await expect(recovery).toHaveAttribute('href','/admin?area=me&view=keys&key=member-key');
  await recovery.click();
  await expect(page.locator('[data-member-key-row="member-key"]')).toBeVisible();
  await expect(page.locator('[data-key-id="member-key"] [data-key-state]')).toHaveAttribute('data-key-state','revoked');
  expect(worker.requests.filter(request=>request.method==='POST'&&request.path.endsWith('/revoke'))).toHaveLength(1);
});

test('expired-source replacement preserves family, selected expiry and its one-time return',async({page,worker})=>{
  worker.expireKey('member-key');
  await page.goto('/admin?area=me&view=keys&key=member-key');
  const key=page.locator('[data-key-detail="member-key"]');
  await expect(page.locator('[data-key-id=member-key] [data-key-state]')).toHaveAttribute('data-key-state','expired');
  await openKeyEditor(page, 'replace');
  await key.getByRole('combobox',{name:'有效期',exact:true}).selectOption({label:'30 天'});
  await openKeyEditor(page, 'replace');
  await key.getByRole('button',{name:'更换',exact:true}).click();
  await page.getByRole('alertdialog').getByRole('button',{name:'更换',exact:true}).click();
  await expect.poll(()=>page.locator('[data-one-time-key]').isVisible()).toBe(true);
  expect(await page.locator('[data-one-time-key]').evaluate(node=>node.textContent?.includes('不会因为这次续发恢复有效'))).toBe(true);
  expect(await page.locator('[data-one-time-key]').evaluate(node=>{
    const codes=Array.from(node.querySelectorAll('.note code'));
    return codes.length===1 && !!codes[0].textContent && codes[0].textContent!=='display_member' && node.textContent?.includes('display_member');
  })).toBe(true);
  const rows=worker.keyMetadata();expect(rows).toHaveLength(2);
  const replacement=rows.find(row=>row.id!=='member-key')!;
  expect(replacement.family_id).toBe('member-family');expect(replacement.expires_at).toBe('2026-07-24T12:00:00.000Z');
  await page.getByRole('link',{name:'管理新密钥',exact:true}).click();
  await expect(page).toHaveURL(new RegExp(`key=${replacement.id}`));
  await expect.poll(() => page.locator('[data-one-time-key],[data-created-token]').count()).toBe(0);
  expect(await page.locator(`[data-key-detail="${replacement.id}"] [data-key-task]`).textContent()).toContain('未记录成功任务');
  await page.locator(`[data-key-id="${replacement.id}"]`).getByRole('link',{name:/配置客户端：/}).click();
  await expect(page.locator('.member-setup-config')).toBeVisible();
  expect(new URL(page.url()).searchParams.has('key')).toBe(false);
  await expect(page.locator('[data-setup-key]')).toHaveCount(0);
  expect(worker.countKeys()).toBe(2);
});

test('held-key configuration is local-only and clears its input on departure',async({page,worker})=>{
  await page.goto('/admin?area=me&view=setup');
  const before=worker.requests.filter(request=>request.method!=='GET').length;
  const form=page.locator('[data-local-config-sync]');await expect(form).toBeVisible();
  // Deliberately invalid bearer; no corresponding hash exists in the fixture.
  await form.getByLabel('已有密钥').fill('cfwd_invalid');
  const download=page.waitForEvent('download');await form.getByRole('button',{name:'下载配置'}).click();await download;
  await expect(form.locator('[data-setup-feedback]')).toContainText('生成文件不代表密钥已通过验证');
  expect(worker.requests.filter(request=>request.method!=='GET')).toHaveLength(before);
  const setupUrl=ORIGIN+'/admin?area=me&view=setup';
  const keysUrl=ORIGIN+'/admin?area=me&view=keys';
  const destination=worker.hold({method:'GET',path:'/admin',view:'keys'});
  const script=worker.hold({method:'GET',path:'/admin/console.js'});
  const help=page.locator('[data-task-help="configuration"]');
  await help.getByRole('button',{name:'配置说明',exact:true}).click();
  const departure=help.getByRole('link',{name:'只读查看本账号的密钥',exact:true}).click();
  try {
    await destination.entered;
    expect(page.url()).toBe(setupUrl);
  } finally {destination.release();}
  try {
    await script.entered;
    await expect(page).toHaveURL(keysUrl);
    await expect(page.locator('[data-key-id="member-key"]')).toBeVisible();
  } finally {script.release();}
  await departure;
  // Native click waits for commit; even visible SSR can precede document load.
  // Finish this departure before testing the separate Back journey.
  await page.waitForURL(keysUrl,{waitUntil:'load'});
  await expect(page.locator('[data-key-id="member-key"]')).toBeVisible();
  await page.goBack();
  await page.waitForURL(setupUrl,{waitUntil:'load'});
  await expect(page.locator('.member-setup-config')).toBeVisible();
  await expect(page.locator('[data-setup-key]')).toHaveCount(0);
  expect(await page.locator('[name="existing_key"]').inputValue()==='').toBe(true);
  expect(await page.evaluate(()=>![localStorage,sessionStorage].some(store=>Object.values(store).some(value=>String(value).includes('cfwd_invalid'))))).toBe(true);
});

test('legacy setup key URLs stay local without selecting a substitute or depending on inventory reads',async({page,worker})=>{
  worker.failMemberRead('inventory');
  for(const key of ['member-key','not-owned']) {
    const response=await page.goto(`/admin?area=me&view=setup&key=${key}`);
    expect(response?.status()).toBe(200);
    await expect(page.locator('[data-local-config-sync]')).toBeVisible();
    await expect(page.locator('[data-setup-key],[data-key-detail]')).toHaveCount(0);
    expect(await page.getByLabel('已有密钥',{exact:true}).inputValue()==='').toBe(true);
  }
  expect(worker.requests.every(request=>request.method==='GET')).toBe(true);
});

test('native result refresh cannot issue a second secret and GET return stays exact',async({browser,worker})=>{
  const context=await browser.newContext({baseURL:ORIGIN,proxy:{server:worker.proxy},ignoreHTTPSErrors:true,javaScriptEnabled:false});
  try{await authenticate(context,worker,'member');const page=await context.newPage();await page.goto('/admin?area=me&view=keys');
    const form=page.locator('[data-member-key-create]');await form.getByRole('textbox',{name:'名称',exact:true}).fill('Native laptop');await form.getByRole('checkbox',{name:'Codex',exact:true}).check();await form.getByRole('button',{name:'创建密钥',exact:true}).click();
    await expect.poll(()=>page.locator('[data-one-time-key]').isVisible()).toBe(true);expect(worker.countKeys()).toBe(2);
    await page.reload();await expect.poll(()=>page.locator('[data-member-result="confirmed"]').isVisible()).toBe(true);expect(await page.locator('[data-one-time-key]').count()).toBe(0);expect(worker.countKeys()).toBe(2);
    await page.getByRole('link',{name:'查看当前密钥',exact:true}).click();await expect(page).toHaveURL(/view=keys&key=key_ui_/);
    await page.goto('/admin?area=me&view=setup');await expect(page.getByLabel('已有密钥')).toBeHidden();
  }finally{await context.close();}
});

test('enhanced expired-session rejection clears private member context and offers login',async({page,worker})=>{
  await page.goto('/admin?area=me&view=keys&key=member-key');
  worker.expireSessions();
  await openKeyEditor(page, 'rename');
  await page.locator('[data-key-detail="member-key"]').getByRole('button',{name:'保存名称',exact:true}).click();
  await expect(page.locator('[data-console-terminal-result]')).toBeVisible();
  await expect(page.getByRole('link',{name:'重新登录',exact:true})).toBeVisible();
  await expect(page.getByRole('link',{name:'重新登录',exact:true})).toHaveAttribute('href',`/login?${new URLSearchParams({return:'/admin?area=me&view=keys&key=member-key'})}`);
  await expect(page.locator('[data-key-id],.identity,[data-member-nav]')).toHaveCount(0);
  expect(await page.locator('main').textContent()).not.toContain('操作结果尚未确认');
  expect(worker.keyMetadata().find(key=>key.id==='member-key')?.name).toBe('member workstation');
});


test('a stale replacement refuses newly unusable bindings while rename and revoke remain available',async({page,worker})=>{
  await page.goto('/admin?area=me&view=keys&key=member-key');
  const key=page.locator('[data-key-detail="member-key"]');
  await openKeyEditor(page, 'replace');
  await expect(key.getByRole('button',{name:'更换',exact:true})).toBeVisible();
  worker.setBoundCredentialStatus('reauth_required');
  await openKeyEditor(page, 'replace');
  await key.getByRole('button',{name:'更换',exact:true}).click();
  await page.getByRole('alertdialog').getByRole('button',{name:'更换',exact:true}).click();
  await expect(page.locator('[data-member-feedback]')).toContainText('原绑定当前不可用或不完整');
  expect(await page.locator('[data-one-time-key]').count()).toBe(0);expect(worker.countKeys()).toBe(1);
  await page.reload();
  await expect(key.locator('[data-replacement-state="binding"]')).toBeVisible();
  await expect(key.getByRole('button',{name:'更换',exact:true})).toHaveCount(0);
  await openKeyEditor(page, 'rename');
  await expect(key.getByRole('button',{name:'保存名称',exact:true})).toBeVisible();
  await key.getByRole('button',{name:'撤销密钥',exact:true}).click();
  await page.getByRole('alertdialog').getByRole('button',{name:'撤销密钥',exact:true}).click();
  await expect(page.locator('[data-member-feedback]')).toContainText('密钥已撤销');
  expect(worker.keyMetadata()[0]?.status).toBe('revoked');
  expect(worker.requests.filter(request=>request.method==='POST'&&request.path.endsWith('/replace'))).toHaveLength(1);
});
