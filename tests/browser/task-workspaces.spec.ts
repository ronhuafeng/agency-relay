import { test, expect } from './fixtures';

test('an unknown creation outcome recovers the current collection without reopening the old task on reload', async ({page,worker}) => {
  await page.goto('/admin?view=access&task=add-person&q=recovered&range=30d');
  const form=page.locator('[data-dashboard-draft="person"]');
  await form.getByRole('textbox',{name:'组织邮箱',exact:true}).fill('recovered.person@example.test');
  const action=(await form.getAttribute('action'))!;
  const write=worker.hold({method:'POST',path:action});
  await form.getByRole('button',{name:'添加成员',exact:true}).click();
  await write.entered;
  const created=worker.person('recovered.person@example.test');
  expect(created?.role).toBe('user');
  await page.getByRole('button',{name:'停止等待',exact:true}).click();
  await expect(page.locator('[data-dashboard-notice]')).toContainText('操作结果尚未确认');
  await expect(form.getByRole('button',{name:'添加成员',exact:true})).toBeDisabled();
  write.release();
  const read=worker.hold({method:'GET',path:'/admin',view:'access'});
  await page.getByRole('link',{name:'查看当前状态',exact:true}).click();
  await read.entered;
  await expect(form.getByRole('button',{name:'添加成员',exact:true})).toBeDisabled();
  read.release();
  await expect(page.locator(`[data-user-id="${created!.id}"]`)).toBeVisible();
  expect(new URL(page.url()).searchParams.get('task')).toBeNull();
  expect(new URL(page.url()).searchParams.get('q')).toBe('recovered');
  expect(new URL(page.url()).searchParams.get('range')).toBe('30d');
  await page.reload();
  await expect(page.locator('#add-person')).not.toBeVisible();
  await expect(page.locator(`[data-user-id="${created!.id}"]`)).toBeVisible();
  expect(worker.requests.filter(request=>request.method==='POST'&&request.path===action)).toHaveLength(1);
});

test('closing exact key tasks retains safe expiry drafts separately for management and configuration', async ({page,worker}) => {
  await page.goto('/admin?view=access&person=member&key=member-key');
  const replacement=page.locator('[data-action="replace-key"] input[name="expires_at_utc"]');
  await replacement.fill('2026-11-11T12:30');
  await page.getByRole('link',{name:'收起密钥详情',exact:true}).click();
  await page.locator('[data-key-id="member-key"]').getByRole('link',{name:'管理密钥',exact:true}).click();
  await expect(replacement).toHaveValue('2026-11-11T12:30');
  await page.locator('[data-key-id="member-key"]').getByRole('link',{name:'配置客户端',exact:true}).click();
  const configuration=page.locator('[data-action="create-setup-package"] input[name="expires_at_utc"]');
  await expect(configuration).toHaveValue('');
  await configuration.fill('2026-12-12T13:40');
  await page.getByRole('link',{name:'收起密钥配置',exact:true}).click();
  await page.locator('[data-setup-key-id="member-key"] a').click();
  await expect(configuration).toHaveValue('2026-12-12T13:40');
  await page.getByRole('link',{name:'管理密钥',exact:true}).click();
  await expect(replacement).toHaveValue('2026-11-11T12:30');
  expect(worker.requests.every(request=>request.method==='GET')).toBe(true);
});

test('local client drafts survive exact selection while held secrets and selected-key evidence stay separate',async({page,worker})=>{
  worker.seedCredentialTasks();
  await page.goto('/admin?view=setup');
  await page.getByRole('tab',{name:'xAI API',exact:true}).click();
  const form=page.locator('[data-local-config-sync]');
  await form.getByLabel('已有密钥',{exact:true}).fill('cfwd_invalid');
  await page.locator('#setup-list>summary').click();
  await page.locator('[data-setup-key-id="member-key"] a').click();
  await expect(page.getByRole('tab',{name:'Codex CLI',exact:true})).toHaveAttribute('aria-selected','true');
  await expect(page.getByRole('tab',{name:'xAI API',exact:true})).toHaveCount(0);
  await page.getByRole('button',{name:'已有密钥',exact:true}).click();
  await expect(page.getByRole('tab',{name:'xAI API',exact:true})).toHaveAttribute('aria-selected','true');
  await expect(page.getByRole('heading',{name:'xai-api.env',exact:true})).toBeVisible();
  await expect(form.locator('select[name="client"]')).toHaveValue('xai');
  await expect(form.getByLabel('已有密钥',{exact:true})).toHaveValue('');
  await expect(page.locator('[data-client-verification]')).toHaveCount(0);
  await page.getByRole('link',{name:'收起密钥配置',exact:true}).click();
  await expect(page.getByRole('tab',{name:'xAI API',exact:true})).toHaveAttribute('aria-selected','true');
  await expect(form.locator('select[name="client"]')).toHaveValue('xai');
  await expect(form.getByLabel('已有密钥',{exact:true})).toHaveValue('');
  await page.locator('[data-setup-key-id="task-move"] a').click();
  await expect(page.getByRole('tab',{name:'Grok Build',exact:true})).toHaveAttribute('aria-selected','true');
  await page.getByRole('button',{name:'已有密钥',exact:true}).click();
  await expect(page.getByRole('tab',{name:'xAI API',exact:true})).toHaveAttribute('aria-selected','true');
  await expect(form.locator('select[name="client"]')).toHaveValue('xai');
  await form.getByRole('button',{name:'放弃修改',exact:true}).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('tab',{name:'Codex CLI',exact:true})).toBeFocused();
  await expect(form.locator('select[name="client"]')).toHaveValue('codex');
  await expect(page.getByRole('heading',{name:'codex-config.toml',exact:true})).toBeVisible();
  expect(worker.requests.every(request=>request.method==='GET')).toBe(true);
});

test('discard focuses the restored client even when a frame precedes the React commit',async({page,worker})=>{
  await page.setViewportSize({width:390,height:900});
  await page.emulateMedia({colorScheme:'dark'});
  await page.goto('/admin?view=setup');
  await page.getByRole('tab',{name:'xAI API',exact:true}).click();
  const form=page.locator('[data-local-config-sync]');
  await form.getByRole('button',{name:'放弃修改',exact:true}).focus();
  // Hold scheduler tasks until after a frame. A frame is not a React commit barrier.
  await page.evaluate(()=>{
    const postMessage=MessagePort.prototype.postMessage;
    const pending:Array<()=>void>=[];
    MessagePort.prototype.postMessage=function(...args:[message:unknown,options?:Transferable[] | StructuredSerializeOptions]){
      pending.push(()=>Reflect.apply(postMessage,this,args));
    };
    addEventListener('fixture:release-render',()=>{
      MessagePort.prototype.postMessage=postMessage;
      pending.forEach(task=>task());
    },{once:true});
  });
  await page.keyboard.press('Enter');
  await page.evaluate(()=>new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>{
    dispatchEvent(new Event('fixture:release-render'));
    resolve();
  }))));
  await expect(page.getByRole('tab',{name:'Codex CLI',exact:true})).toBeFocused();
  await expect(form.locator('select[name="client"]')).toHaveValue('codex');
  await expect(page.getByRole('heading',{name:'codex-config.toml',exact:true})).toBeVisible();
  expect(worker.requests.every(request=>request.method==='GET')).toBe(true);
});

for(const script of [true,false]) test.describe(`pending OAuth task with script=${script}`,()=>{
  test.use({script});
  test('keeps its exact callback task until explicit departure and requires a fresh start afterward',async({page,worker})=>{
    worker.setBoundCredentialStatus('reauth_required');
    await page.goto('/admin?view=credentials&account=codex%3Afixture-codex&q=Synthetic');
    if(!script) await page.locator('[data-action="oauth-codex-start"] [data-confirmation-fallback] input').check();
    await page.getByRole('button',{name:'重新连接',exact:true}).click();
    if(script) await page.getByRole('alertdialog').getByRole('button',{name:'重新连接',exact:true}).click();
    await page.waitForFunction(()=>document.querySelector('[data-authorizing]')!==null);
    // Pending sessions are usable authority. Only scalar assertions; no DOM captures.
    expect(await page.locator('#accounts-list input[name="q"]').evaluate(input=>input.matches(':disabled'))).toBe(true);
    expect(await page.locator('#accounts-list a').count()).toBe(0);
    expect(await page.locator('.account-defaults button[type="submit"]:enabled').count()).toBe(0);
    expect(await page.locator('[data-authorizing] input[name="callback_url"]').evaluate(input=>input.matches(':disabled'))).toBe(false);
    expect(await page.locator('[data-action="oauth-codex-complete"]').getAttribute('method')).toBe('post');
    await page.getByRole('link',{name:'放弃授权并收起连接详情',exact:true}).click();
    await page.waitForFunction(()=>document.querySelector('[data-authorizing]')===null);
    expect(await page.locator('#accounts-list input[name="q"]').inputValue()).toBe('Synthetic');
    await page.locator('[data-account-key="codex:fixture-codex"] a').click();
    await page.waitForFunction(()=>document.querySelector('[data-account-detail="codex:fixture-codex"]')!==null);
    expect(await page.locator('input[name="callback_url"]').count()).toBe(0);
    expect(await page.getByRole('button',{name:'重新连接',exact:true}).count()).toBe(1);
    expect(worker.requests.filter(request=>request.method==='POST')).toHaveLength(1);
  });
});
