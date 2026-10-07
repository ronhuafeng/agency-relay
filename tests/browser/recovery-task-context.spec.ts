import {test,expect,openMemberCreate,openKeyEditor} from './fixtures';

// These are controlled foreground-handler checks with real browser layout and
// route/SQL behavior. They do not claim OS resume or a persisted BFCache entry.
test('an email draft stays visible for its exact person and regains focus after a successful authority read',async({page,worker})=>{
  await page.goto('/admin?view=access&person=other');
  await expect(page.locator('[data-confirmation-fallback]:visible')).toHaveCount(0);
  const form=page.locator('form[action="/admin/ui/users/other/email"]');
  const trigger=page.getByRole('button',{name:'更改登录邮箱',exact:true});
  await trigger.click();
  const email=form.getByRole('textbox',{name:'新的组织邮箱',exact:true});
  await email.fill('unfinished.other@example.test');
  await expect(form.locator('[data-draft-state]')).toBeVisible();
  const authority=worker.hold({method:'GET',path:'/me'});
  await email.focus(); await page.evaluate(()=>document.dispatchEvent(new Event('visibilitychange'))); await authority.entered;
  await expect(page.locator('.shell')).toBeHidden(); authority.release();
  await expect(email).toBeFocused(); await expect(email).toHaveValue('unfinished.other@example.test');
  await form.getByRole('button',{name:'取消',exact:true}).click();
  await expect(trigger).toBeFocused(); await expect(page.locator('[data-task-draft-indicator]')).toBeVisible();
  await page.getByRole('navigation',{name:'控制台页面'}).getByRole('link',{name:'用量报告',exact:true}).click();
  await expect(page.locator('[data-dashboard-view="usage"]')).toBeVisible();
  await page.goBack();
  await expect(form).toBeVisible(); await expect(email).toHaveValue('unfinished.other@example.test');
  await expect(trigger).toHaveAttribute('aria-expanded','true');
  await page.locator('[data-user-id="member"] a.person-link').click();
  await expect(page.locator('[data-person-detail]')).toHaveAttribute('data-person-detail','member');
  await page.getByRole('button',{name:'更改登录邮箱',exact:true}).click();
  await expect(page.locator('form[action="/admin/ui/users/member/email"] input[name="email"]')).toHaveValue('');
  await page.goBack();
  await expect(form).toBeVisible(); await expect(email).toHaveValue('unfinished.other@example.test');
  await form.getByRole('button',{name:'放弃修改',exact:true}).click(); await expect(email).toHaveValue('');
  await form.getByRole('button',{name:'取消',exact:true}).click();
  await expect(page.locator('[data-task-draft-indicator]')).toHaveCount(0);
  expect(worker.requests.every(request=>request.method==='GET')).toBe(true);
});

for(const width of [390,1440]) test.describe(`stopped management wait ${width}px`,()=>{
test.use({viewport:{width,height:900}});
test('a stopped management wait remains unknown when the next foreground read requires login',async({page,worker},testInfo)=>{
  const target='/admin?view=access&range=7d&person=other';
  await page.goto(target); await expect(page.locator('[data-confirmation-fallback]:visible')).toHaveCount(0);
  const write=worker.hold({method:'POST',path:'/admin/ui/users/other/status'});
  await page.getByRole('switch',{name:/启用账号/}).click();
  await page.getByRole('alertdialog').getByRole('button',{name:'停用账号',exact:true}).click(); await write.entered;
  expect(worker.status('other')).toBe('disabled');
  await page.getByRole('button',{name:'停止等待',exact:true}).click();
  await expect(page.locator('main')).toHaveAttribute('data-dashboard-mutation-blocked','true');
  await expect(page.locator('main form[aria-busy="true"]')).toHaveCount(0); write.release();
  worker.expireSessions(); await page.evaluate(()=>document.dispatchEvent(new Event('visibilitychange')));
  const recovery=page.locator('[data-console-recovery]');
  await expect(recovery).toHaveAttribute('data-recovery-state','login');
  await expect(recovery.locator('[data-console-outcome]')).toHaveAttribute('data-console-outcome','unknown');
  await expect(recovery).toContainText('可能已经执行');
  await expect(recovery.getByRole('link',{name:'重新登录',exact:true})).toHaveAttribute('href',`/login?${new URLSearchParams({return:target})}`);
  await expect(recovery.getByRole('heading',{level:1})).toBeFocused();
  expect(await page.locator('.shell,.identity,[data-ui-props],form,[data-one-time-key],[data-created-token]').count()).toBe(0);
  expect(worker.requests.filter(request=>request.method==='POST')).toHaveLength(1);
  expect(worker.status('other')).toBe('disabled');
  await expect(recovery.getByRole('heading',{level:1})).toBeVisible();
  const action=recovery.getByRole('link',{name:'重新登录',exact:true}); await expect(action).toHaveCount(1);
  expect(await action.evaluate(node=>node.getBoundingClientRect().height)).toBeGreaterThanOrEqual(44);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
  const screenshot=testInfo.outputPath(`public-unknown-login-${width}.png`);
  await page.screenshot({path:screenshot,fullPage:true,animations:'disabled'});
  await testInfo.attach('Public unknown-result login recovery',{path:screenshot,contentType:'image/png'});
});
});

test.describe('member local selection recovery',()=>{
  test.use({identity:'member'});
  test('a native one-time result captures its confirmed GET before departure removes the private document',async({page,worker})=>{
    await page.goto('/admin?area=me&view=keys'); await openMemberCreate(page);
    const form=page.locator('[data-member-key-create]');
    await form.getByRole('textbox',{name:'名称',exact:true}).fill('Native recovery task');
    await form.getByRole('checkbox',{name:'Codex',exact:true}).check();
    const loaded=page.waitForEvent('load');
    const posted=page.waitForResponse(response=>response.request().method()==='POST' && new URL(response.url()).pathname==='/me/ui/keys');
    // The public native form API bypasses enhancement for this fallback check.
    await form.evaluate(node=>(node as HTMLFormElement).submit()); await loaded;
    expect((await posted).status()).toBe(200); expect(worker.countKeys()).toBe(2);
    await expect.poll(()=>page.evaluate(()=>document.querySelector('[data-one-time-key] .secret-copy')?.querySelectorAll('button').length??0)).toBe(2);
    const target=await page.evaluate(()=>document.querySelector<HTMLElement>('[data-one-time-key]')?.dataset.memberReturn??null);
    expect(target?.startsWith('/admin?area=me&view=keys&key=')).toBe(true);
    expect(new URL(page.url()).pathname).toBe('/me/ui/keys');
    await page.evaluate(target=>{
      sessionStorage.removeItem('native-recovery-departure');
      addEventListener('pagehide',()=>{
        const recovery=document.querySelector('[data-console-recovery]');
        const facts={exactTarget:recovery?.querySelector('a')?.getAttribute('href')===target,
          confirmed:recovery?.querySelector('[data-console-outcome]')?.getAttribute('data-console-outcome')==='confirmed',
          privateCleared:!document.querySelector('.shell,.identity,[data-ui-props],[data-one-time-key],[data-created-token]')};
        // Only boolean observations cross the real departure. No identifier,
        // return URL, secret or former document is stored by this test probe.
        sessionStorage.setItem('native-recovery-departure',JSON.stringify(facts));
      },{once:true});
    },target);
    await page.goto('/logout');
    const departure=await page.evaluate(()=>{
      const value=sessionStorage.getItem('native-recovery-departure'); sessionStorage.removeItem('native-recovery-departure');
      return value?JSON.parse(value):null;
    });
    expect(departure).toEqual({exactTarget:true,confirmed:true,privateCleared:true});
    expect(worker.requests.filter(request=>request.method==='POST').map(request=>request.path)).toEqual(['/me/ui/keys']);
    expect(worker.countKeys()).toBe(2);
  });
  for(const delegated of [false,true]) test(`session expiry uses the current local key selection (delegated=${delegated})`,async({page,worker})=>{
    const service=delegated?await worker.seedDelegatedService():null;
    const owner=service??'member'; worker.seedSetupOverlap(owner);
    const base=service?`/me/service-accounts/${service}?view=keys`:'/admin?area=me&view=keys';
    const original=`${base}${delegated?'':`&key=${owner}-setup-old`}#member-key-inventory`;
    const selected=`${owner}-setup-new`; const target=`${base}&key=${selected}#member-key-inventory`;
    await page.goto(original); await expect(page.locator('[data-confirmation-fallback]:visible')).toHaveCount(0);
    await page.locator(`[data-key-id="${selected}"] a[data-member-key-toggle]`).last().click();
    await expect(page.locator(`[data-member-key-row="${selected}"]`)).toBeVisible();
    await expect(page).toHaveURL(new URL(original,page.url()).href);
    worker.expireSessions(); worker.loginAs('member');
    await page.evaluate(()=>document.dispatchEvent(new Event('visibilitychange')));
    const recovery=page.locator('[data-console-recovery]');
    await expect(recovery).toHaveAttribute('data-recovery-state','login');
    await expect(recovery.getByRole('link',{name:'重新登录',exact:true})).toHaveAttribute('href',`/login?${new URLSearchParams({return:target})}`);
    expect(await page.locator('.shell,.identity,[data-ui-props],[data-key-detail]').count()).toBe(0);
    await recovery.getByRole('link',{name:'重新登录',exact:true}).click();
    await page.getByRole('button',{name:'使用飞书继续'}).click({noWaitAfter:true});
    await expect(page).toHaveURL(new URL(target,page.url()).href);
    await expect(page.locator(`[data-member-key-row="${selected}"]`)).toBeVisible();
    await expect(page.locator(`[data-member-key-row="${owner}-setup-old"]`)).toBeHidden();
    if(service) await expect(page.locator('[data-service-id]')).toHaveAttribute('data-service-id',service);
    expect(worker.requests.filter(request=>request.method==='POST').map(request=>request.path)).toEqual(['/login']);
  });
});

test.describe('native failed usage recovery',()=>{
  test.use({identity:'member',script:false});
  for(const delegated of [false,true]) test(`a failed 30-day read retries the same HTML scope (delegated=${delegated})`,async({page,worker})=>{
    const service=delegated?await worker.seedDelegatedService():null;
    const target=`${service?`/me/service-accounts/${service}?view=usage`:'/admin?area=me&view=usage'}&range=30d`;
    worker.failMemberRead('usage'); const response=await page.goto(target); expect(response?.status()).toBe(503);
    const unavailable=page.locator('[data-read-state="unavailable"]');
    await expect(unavailable.getByRole('link',{name:'再试一次',exact:true})).toHaveAttribute('href',target);
    expect(await page.locator('[data-trend-empty],[data-trend-plan]').count()).toBe(0);
    worker.failMemberRead(null); await unavailable.getByRole('link',{name:'再试一次',exact:true}).click();
    await expect(page).toHaveURL(new URL(target,page.url()).href);
    await expect(page.locator('[data-usage-range-label]')).toHaveAttribute('data-usage-range-label','2026-05-26 至 2026-06-24 UTC');
    if(service) await expect(page.locator('[data-service-id]')).toHaveAttribute('data-service-id',service);
    expect(worker.requests.every(request=>request.method==='GET')).toBe(true);
  });
});

for (const [script, delegated] of [[false, false], [false, true], [true, true]] as const) test.describe(`expired key submission (script=${script}, delegated=${delegated})`, () => {
  test.use({identity:'member',script});
  test('login returns to the submitted key without replaying the rejected rename', async ({page,worker}) => {
    const service = delegated ? await worker.seedDelegatedService() : undefined;
    const owner = service ?? 'member'; worker.seedSetupOverlap(owner);
    const keyId = `${owner}-setup-new`;
    const target = `${service ? `/me/service-accounts/${service}?view=keys` : '/admin?area=me&view=keys'}&key=${keyId}`;
    await page.goto(target);
    if (script) await openKeyEditor(page,'rename');
    const detail = page.locator(`[data-key-detail="${keyId}"]`);
    await detail.getByRole('textbox',{name:'密钥名称',exact:true}).fill('Rejected name');
    worker.expireSessions();
    await detail.getByRole('button',{name:'保存名称',exact:true}).click();
    await expect(page.locator('[data-console-terminal-result]')).toBeVisible();
    const login = page.getByRole('link',{name:'重新登录',exact:true});
    await expect(login).toHaveAttribute('href',`/login?${new URLSearchParams({return:target})}`);
    await expect(page.locator('[data-key-id],.identity,[data-member-nav],[data-one-time-key]')).toHaveCount(0);
    expect(worker.keyMetadata(owner).find(key=>key.id===keyId)?.name).toBe('Workstation');
    worker.loginAs('member');
    await login.click();
    await page.getByRole('button',{name:'使用飞书继续',exact:true}).click({noWaitAfter:true});
    await expect(page).toHaveURL(target);
    await expect(page.locator(`[data-member-key-row="${keyId}"]`)).toBeVisible();
    if (service) await expect(page.locator('[data-service-id]')).toHaveAttribute('data-service-id',service);
    expect(worker.requests.filter(request=>request.method==='POST'&&request.path.endsWith('/rename'))).toHaveLength(1);
    expect(worker.keyMetadata(owner).find(key=>key.id===keyId)?.name).toBe('Workstation');
  });
});
