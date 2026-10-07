import {test,expect,authenticate,openMemberCreate} from './fixtures';

// Controlled foreground-handler triggers with real browser layout/network/SQL.
// Neither synthetic visibilitychange nor these reads prove OS resume or BFCache.
async function foreground(page: import('@playwright/test').Page) {
  await page.evaluate(()=>document.dispatchEvent(new Event('visibilitychange')));
}
async function ready(page: import('@playwright/test').Page) {
  await expect(page.locator('[data-confirmation-fallback]:visible')).toHaveCount(0);
  await expect(page.locator('[data-console-actor-id]')).toHaveCount(1);
}

test('an in-flight real navigation cannot escape the pending document privacy mask',async({page,worker})=>{
  await page.goto('/admin?view=access'); await ready(page);
  const navigation=worker.hold({method:'GET',path:'/admin',view:'usage'});
  await page.getByRole('navigation',{name:'控制台页面'}).getByRole('link',{name:'用量报告',exact:true}).click(); await navigation.entered;
  const authority=worker.hold({method:'GET',path:'/me'}); await foreground(page); await authority.entered;
  navigation.release();
  await expect.poll(()=>page.locator('[data-dashboard-view="usage"]').count()).toBe(1);
  expect(await page.evaluate(async()=>{
    await new Promise<void>(done=>requestAnimationFrame(()=>requestAnimationFrame(()=>done())));
    return document.documentElement.hasAttribute('data-console-authority-pending') && document.body.inert
      && document.querySelector('.shell')!.getClientRects().length===0;
  })).toBe(true);
  await expect(page.locator('[data-console-authority-status]')).toBeVisible();
  authority.release(403);
  await expect(page.locator('[data-console-recovery]')).toBeVisible();
  expect(await page.locator('.shell,.identity,[data-ui-props]').count()).toBe(0);
  expect(worker.requests.filter(request=>request.method==='POST').length).toBe(0);
});

test('a confirmed admin write stays masked while identity is pending and is never replayed',async({page,worker})=>{
  await page.goto('/admin?view=access&person=other'); await ready(page);
  const write=worker.hold({method:'POST',path:'/admin/ui/users/other/status'});
  await page.getByRole('switch',{name:/启用账号/}).click();
  await page.getByRole('alertdialog').getByRole('button',{name:'停用账号',exact:true}).click(); await write.entered;
  expect(worker.status('other')).toBe('disabled');
  const authority=worker.hold({method:'GET',path:'/me'}); await foreground(page); await authority.entered;
  write.release(); await expect.poll(()=>page.locator('[data-dashboard-mutation="user_status"]').count()).toBe(1);
  expect(await page.evaluate(()=>document.documentElement.hasAttribute('data-console-authority-pending') && document.querySelector('.shell')!.getClientRects().length===0)).toBe(true);
  authority.release(403); await expect(page.locator('[data-console-recovery]')).toBeVisible();
  await expect(page.locator('[data-console-recovery] [data-console-outcome]')).toHaveAttribute('data-console-outcome','confirmed');
  await expect(page.locator('[data-console-recovery]')).toContainText('服务器已确认');
  expect(await page.locator('.shell,.identity,[data-ui-props]').count()).toBe(0);
  expect(worker.requests.filter(request=>request.method==='POST'&&request.path==='/admin/ui/users/other/status').length).toBe(1);
  expect(worker.status('other')).toBe('disabled');
});

test.describe('stable member actor',()=>{
  test.use({identity:'member'});
  test('a real mailbox migration and new JIT session cannot recover the former actor content',async({page,worker,context})=>{
    await page.goto('/admin?area=me&view=keys'); await ready(page);
    await expect(page.locator('[data-console-actor-id]')).toHaveAttribute('data-console-actor-id','member');
    await expect(page.locator('[data-key-id="member-key"]')).toHaveCount(1);
    await worker.moveMemberMailbox(); await authenticate(context,worker,'member');
    expect(worker.person('member@example.test')?.id==='member').toBe(false);
    await foreground(page); await expect(page.locator('[data-console-recovery]')).toBeVisible();
    expect(await page.locator('.shell,.identity,[data-key-id],[data-ui-props]').count()).toBe(0);
    expect(worker.requests.filter(request=>request.method==='POST').length).toBe(0);
  });
  test('a one-time member result cannot become visible through a pending foreground mask',async({page,worker})=>{
    await page.goto('/admin?area=me&view=keys'); await ready(page);
    const form=page.locator('[data-member-key-create]');
    await openMemberCreate(page);
    await form.getByRole('textbox',{name:'名称',exact:true}).fill('Private pending result');
    await form.getByRole('checkbox',{name:'Codex',exact:true}).check();
    const write=worker.hold({method:'POST',path:'/me/ui/keys'});
    await form.getByRole('button',{name:'创建密钥',exact:true}).click(); await write.entered;
    const authority=worker.hold({method:'GET',path:'/me'}); await foreground(page); await authority.entered;
    write.release(); await expect.poll(()=>page.locator('[data-one-time-key]').count()).toBe(1);
    // Scalar-only checks avoid putting even synthetic one-time secrets in failures.
    expect(await page.evaluate(()=>document.documentElement.hasAttribute('data-console-authority-pending') && document.querySelector('[data-one-time-key]')!.getClientRects().length===0)).toBe(true);
    authority.release(403); await expect(page.locator('[data-console-recovery]')).toBeVisible();
    await expect(page.locator('[data-console-recovery] [data-console-outcome]')).toHaveAttribute('data-console-outcome','confirmed');
    expect(await page.locator('[data-one-time-key],[data-created-token],.identity,[data-ui-props]').count()).toBe(0);
    expect(worker.requests.filter(request=>request.method==='POST'&&request.path==='/me/ui/keys').length).toBe(1);
    expect(worker.countKeys()).toBe(2);
  });
});
