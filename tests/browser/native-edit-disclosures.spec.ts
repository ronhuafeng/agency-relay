import { test, expect, openNativeConfirmation } from './fixtures';

// Native disclosure must expose the same mounted, editable task without a
// runtime. An SSR-expanded fallback or an inert hidden form fails this journey.
test.describe('native edit disclosures', () => {
  test.use({script:false});
  test('quota disclosure preserves its draft and submits the reviewed policy', async ({page,worker}) => {
    await page.goto('/admin?view=access&person=member');
    const trigger = page.locator('[data-credit-user=member][data-credit-surface=codex]').getByRole('button',{name:'调整 Codex 额度',exact:true});
    const editor = page.locator('#credit-policy-member-codex-editor');
    await expect(editor).toBeHidden();
    await trigger.focus(); await page.keyboard.press('Enter');
    await expect(editor).toBeVisible();
    await editor.getByRole('spinbutton').fill('28');
    await trigger.click(); await expect(editor).toBeHidden();
    await trigger.click(); await expect(editor.getByRole('spinbutton')).toHaveValue('28');
    await editor.getByRole('button',{name:'保存',exact:true}).click();
    expect(worker.requests.filter(request=>request.method==='POST')).toHaveLength(0);
    await openNativeConfirmation(editor.locator('form[data-action=credit-set]')); 
    await editor.locator('form[data-action=credit-set]').getByRole('checkbox').check();
    await editor.getByRole('button',{name:'保存',exact:true}).click();
    await expect(page.locator('[data-mutation-flash=credit_policy]')).toHaveText('Codex 额度已更新');
    expect(worker.servicePolicy('member')).toEqual(expect.arrayContaining([expect.objectContaining({monthly_allowance:28})]));
  });
  test('email task opens by keyboard and keeps input on collapse', async ({page}) => {
    await page.goto('/admin?view=access&person=other');
    const trigger = page.getByRole('button',{name:'更改登录邮箱',exact:true});
    const email = page.getByRole('textbox',{name:'新的组织邮箱',exact:true});
    await expect(email).toBeHidden();
    await trigger.focus(); await page.keyboard.press('Space');
    await email.fill('unfinished@example.test');
    await trigger.click(); await expect(email).toBeHidden();
    await trigger.click(); await expect(email).toHaveValue('unfinished@example.test');
    await expect(page.getByRole('button',{name:'迁移邮箱',exact:true})).toBeVisible();
  });
});
