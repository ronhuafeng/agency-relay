import { writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import type { Page, TestInfo } from '@playwright/test';
import { consoleStyles } from '../../src/admin/generated/console-styles';
import { test, expect, authenticate, openMemberCreate } from './fixtures';

const head=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();
const stylesSha256=createHash('sha256').update(consoleStyles).digest('hex');
const targets='button:not(:disabled):not([role="checkbox"]):not([role="radio"]),.radix-check label,label.confirmation-fallback,input:not([type=hidden]):not([type=checkbox]):not([type=radio]),select,summary,.action-link,.section-links a,.ranges a,.person-link,.key-link,.console-simple .keys a';
async function inspect(page:Page,info:TestInfo,scene:string,role:string,zoom=1) {
  await page.evaluate(()=>document.fonts.ready);
  expect(await page.locator('[data-one-time-key],[data-created-token],[data-authorizing]').count()).toBe(0);
  const measurement=await page.locator('main').evaluate((main,selector)=>{
    const shown=[...main.querySelectorAll(selector)].filter(element=>element.checkVisibility());
    const boxes=shown.map(element=>{const box=element.getBoundingClientRect();return {tag:element.tagName,type:element.getAttribute('type'),name:element.getAttribute('name'),width:box.width,height:box.height,left:box.left,right:box.right,tableRegion:Boolean(element.closest('.table-wrap,.table-scroll'))};});
    const scrollRegions=[...main.querySelectorAll('*')].filter(element=>{
      const style=getComputedStyle(element);return element.checkVisibility()&&['auto','scroll'].includes(style.overflowY)&&element.scrollHeight>element.clientHeight+1;
    }).map(element=>({tag:element.tagName,label:element.getAttribute('aria-label')}));
    return {viewport:{width:innerWidth,height:innerHeight},documentWidth:document.documentElement.scrollWidth,
      smallTargets:boxes.filter(box=>box.width<44||box.height<44),outsideTargets:boxes.filter(box=>(box.left < -1 || box.right>innerWidth+1) && !box.tableRegion),scrollRegions,
      theme:matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light'};
  },targets);
  expect.soft(measurement.documentWidth,`${scene}: document overflow`).toBeLessThanOrEqual(measurement.viewport.width+1);
  expect.soft(measurement.smallTargets,`${scene}: 44px primary controls`).toEqual([]);
  expect.soft(measurement.outsideTargets,`${scene}: controls in viewport`).toEqual([]);
  expect.soft(measurement.scrollRegions,`${scene}: one primary document scroll region`).toEqual([]);
  const result={head,stylesSha256,scene,role,engine:info.project.name,zoom,zoomKind:zoom===1?'CSS pixels, default browser zoom':'CSS magnification, not browser-chrome zoom',...measurement};
  const path=info.outputPath(`${scene}-geometry.json`);writeFileSync(path,JSON.stringify(result,null,2));await info.attach(scene+' geometry',{path,contentType:'application/json'});
  return result;
}
async function screenshot(page:Page,info:TestInfo,scene:string) {
  expect(await page.locator('[data-one-time-key],[data-created-token],[data-authorizing]').count()).toBe(0);
  await page.evaluate(()=>scrollTo(0,0));const path=info.outputPath(`safe-${scene}.png`);
  await page.screenshot({path,animations:'disabled'});await info.attach(scene,{path,contentType:'image/png'});
}
for(const width of [320,390,768,999,1000,1024,1199,1200,1440,1920,2560]) {
  test.describe(`remaining workspace ${width}px`,()=>{
    test.use({viewport:{width,height:900},colorScheme:width<1000?'dark':'light'});
    test('People, Activity, member Keys and usage reflow without hidden primary actions',async({page,context,worker},info)=>{
      worker.seedRemainingLayouts();worker.seedRequestHistory();worker.seedUsageTrends();
      for(const [scene,url] of [['people','/admin?view=access&person=member'],['activity','/admin?view=audit'],['admin-usage','/admin?view=usage']] as const) {
        await page.goto(url);await inspect(page,info,scene,'admin');
        if([390,1440].includes(width))await screenshot(page,info,`${scene}-${width}`);
      }
      await authenticate(context,worker,'member');await page.goto('/admin?area=me&view=keys');
      await inspect(page,info,'member-keys','member');
      await openMemberCreate(page);
      const form=page.locator('[data-member-key-create]');await form.getByRole('textbox',{name:'名称',exact:true}).focus();
      await page.keyboard.press('Tab');await expect(form.getByRole('checkbox',{name:'Codex',exact:true})).toBeFocused();
      if([390,1440].includes(width))await screenshot(page,info,`member-keys-${width}`);
      // No business mutation is needed to measure or show these display fixtures.
      expect(worker.requests.filter(request=>request.method==='POST')).toHaveLength(0);
    });
  });
}
for(const width of [390,1440])test.describe(`remaining journeys ${width}px`,()=>{
  test.use({viewport:{width,height:900},colorScheme:width===390?'light':'dark'});
  test('exact people/key return, member pages, unknown states and login remain reachable',async({page,context,worker},info)=>{
    worker.seedRemainingLayouts();worker.seedUsageTrends();
    await page.goto('/admin?view=access&q=long.person');
    await page.locator('[data-user-id="layout-long"] .person-link').click();
    await expect(page.locator('[data-person-detail="layout-long"]')).toBeVisible();
    await inspect(page,info,'long-person','admin');
    await page.getByRole('link',{name:'收起人员详情',exact:true}).click();await expect(page.getByRole('searchbox',{name:'搜索邮箱、名称或 ID'})).toHaveValue('long.person');
    await page.goto('/admin?view=access&person=member&q=member');
    await page.getByRole('navigation',{name:'人员内容'}).getByRole('link',{name:'密钥',exact:true}).click();
    expect(await page.locator('.person-key-inventory').evaluate(root=>[...root.querySelectorAll('a[data-slot="button"]')].filter(link=>link.checkVisibility()).every(link=>{
      const rect=link.getBoundingClientRect();return rect.left>=-1&&rect.right<=innerWidth+1&&rect.width>=44&&rect.height>=44;
    }))).toBe(true);
    await page.getByRole('link',{name:'管理密钥 display_member'}).click();
    await expect(page.locator('[data-key-detail="member-key"]')).toBeVisible();
    await page.getByRole('link',{name:'收起密钥详情',exact:true}).click();await expect(page).toHaveURL(/person=member/);await expect(page).toHaveURL(/q=member/);
    await authenticate(context,worker,'member');
    for(const view of ['home','quota','usage','setup','keys&key=member-key','setup&key=member-key']) {
      await page.goto(`/admin?area=me&view=${view}`);await inspect(page,info,`member-${view.replaceAll(/[^a-z-]/g,'')}`,'member');
    }
    const setupHelp=page.locator('[data-task-help="configuration"]');
    await setupHelp.getByRole('button',{name:'配置说明',exact:true}).click();
    await setupHelp.getByRole('link',{name:'只读查看本账号的密钥',exact:true}).click();
    await page.locator('[data-key-id="member-key"]').getByRole('link',{name:'管理密钥',exact:false}).click();
    await expect(page.locator('[data-key-detail="member-key"]')).toBeVisible();
    await page.locator('[data-member-key-close]:visible').click();await expect(page.locator('[data-member-key-row]:not([hidden])')).toHaveCount(0);
    worker.failMemberRead('inventory');await page.reload();await expect(page.locator('[data-read-state="unknown"]')).toContainText('密钥列表暂时未读到');
    await inspect(page,info,'unknown-inventory','member');worker.failMemberRead(null);
    await page.goto('/admin?area=me&view=keys&key=not-owned');await expect(page.locator('[data-key-detail]:visible')).toHaveCount(0);await expect(page.locator('[data-key-state="missing"]')).toBeVisible();
    await context.clearCookies();await page.goto('/login');await inspect(page,info,'login','unauthenticated');
    const login=page.getByRole('button',{name:'使用飞书继续'});await login.focus();await page.keyboard.press('Tab');await page.keyboard.press('Shift+Tab');await expect(login).toBeFocused();
    await screenshot(page,info,`login-${width}`);
    expect(worker.requests.filter(request=>request.method==='POST')).toHaveLength(0);
  });
});
test.describe('native narrow policy and key controls',()=>{
  test.use({script:false,viewport:{width:320,height:900},colorScheme:'dark'});
  test('native policy form keeps the exact person and acknowledgement',async({page,worker},info)=>{
    await page.goto('/admin?view=access&person=member&q=member');
    await page.getByRole('navigation',{name:'人员内容'}).getByRole('link',{name:'额度',exact:true}).click();
    const policy=page.locator('#credit-policy-member-codex-editor');
    await policy.getByRole('spinbutton').fill('37');await policy.getByRole('checkbox').check();
    await inspect(page,info,'native-person-policy','admin');
    await policy.getByRole('button',{name:'保存',exact:true}).click();
    await expect(page.locator('[data-mutation-flash]')).toBeVisible();
    await expect(page.locator('[data-person-detail="member"]')).toBeVisible();
    await expect(page.locator('[data-credit-user="member"][data-credit-surface="codex"]')).toContainText('37');
    expect(worker.requests.filter(request=>request.method==='POST')).toHaveLength(1);
  });
});
test.describe('200 percent CSS magnification',()=>{
  test.use({viewport:{width:1440,height:1000},colorScheme:'dark'});
  test('People, usage comparison and member actions keep keyboard access',async({page,context,worker},info)=>{
    worker.seedUsageTrends();
    for(const url of ['/admin?view=access&person=member','/admin?view=audit','/admin?view=usage']) {
      await page.goto(url);await page.evaluate(()=>{document.documentElement.style.zoom='2';});
      await inspect(page,info,`zoom-${new URL(page.url()).searchParams.get('view')}`,'admin',2);
    }
    const summary=page.locator('.usage-data-trigger').first();await summary.focus();await page.keyboard.press('Enter');
    const comparison=page.locator('.usage-trend-data .table-scroll').first();await comparison.focus();await expect(comparison).toBeFocused();
    await page.keyboard.press('ArrowRight');expect(await comparison.evaluate(element=>element.scrollWidth>=element.clientWidth)).toBe(true);
    await screenshot(page,info,'usage-css-zoom-200');
    await page.keyboard.press('Escape');
    await authenticate(context,worker,'member');
    for(const view of ['keys','setup','setup&key=member-key','keys&key=member-key']) {
      await page.goto(`/admin?area=me&view=${view}`);
      const workspace=page.locator(view.startsWith('setup')?'.member-setup-config':'.member-key-workspace');
      expect(await workspace.evaluate(element=>element.getBoundingClientRect().right<=innerWidth)).toBe(true);
      await page.evaluate(()=>{document.documentElement.style.zoom='2';});
      if(view.startsWith('setup')) {
        await expect(workspace.locator('[data-local-config-sync]')).toBeVisible();
        await expect(workspace.getByRole('button',{name:'配置说明',exact:true})).toHaveCount(1);
        await expect(page.locator('[data-setup-key]')).toHaveCount(0);
      }
      await inspect(page,info,`zoom-member-${view.replaceAll(/[^a-z-]/g,'')}`,'member',2);
    }
    const revoke=page.locator('[data-key-detail="member-key"]').getByRole('button',{name:'撤销密钥',exact:true});await revoke.focus();await page.keyboard.press('Enter');
    const dialog=page.getByRole('alertdialog');await expect(dialog.getByRole('button',{name:'取消'})).toBeFocused();await page.keyboard.press('Escape');await expect(revoke).toBeFocused();
    expect(worker.requests.filter(request=>request.method==='POST')).toHaveLength(0);
  });
});


test.describe('selected key safe identity',()=>{
  test.use({identity:'member',script:false,viewport:{width:390,height:900},colorScheme:'dark'});
  test('same-name old and replacement prefixes stay exact in personal and assigned-service Keys',async({page,worker},info)=>{
    const service=await worker.seedDelegatedService();
    for(const owner of ['member',service]) {
      worker.seedSetupOverlap(owner);
      const base=owner==='member'?'/admin?area=me&view=':`/me/service-accounts/${owner}?view=`;
      for(const suffix of ['old','new']) {
        const id=`${owner}-setup-${suffix}`; const prefix=`display_${owner==='member'?'member':'service'}_${suffix}`;
        await page.goto(`${base}keys&key=${id}`);
        await expect(page.locator(`[data-key-detail="${id}"]`).getByRole('heading',{name:'Workstation',exact:true})).toBeVisible();
        const selectedRow=page.locator(`[data-key-id="${id}"]`);
        await expect(selectedRow).toHaveAttribute('data-state','selected');
        await expect(selectedRow.locator('code')).toHaveText(prefix);
        await expect(selectedRow.locator('.key-manage-link')).toHaveAttribute('href',`${base}keys&key=${id}`);
        if(owner===service) await expect(page.getByRole('complementary',{name:'当前服务账号'})).toContainText('Nightly build');
      }
      await inspect(page,info,owner==='member'?'keys-overlap-personal':'keys-overlap-service',owner==='member'?'member':'assigned-service-member');
      await screenshot(page,info,owner==='member'?'keys-overlap-personal':'keys-overlap-service');
      await page.locator('[data-member-key-close]:visible').click();
      await expect(page).toHaveURL(new URL(`${base}keys`,page.url()).href);
    }
    expect(worker.requests.filter(request=>request.method==='POST')).toHaveLength(0);
  });
});


for(const [width,zoom] of [[320,1],[390,1],[1200,1],[1440,1],[1440,2]] as const) test.describe(`selected key long name ${width}px at ${zoom}x`,()=>{
  test.use({identity:'member',script:false,viewport:{width,height:900},colorScheme:'light'});
  test('a valid unbroken key name stays inside its detail and never overlaps the return action',async({page,worker},info)=>{
    const name='W'.repeat(64);worker.seedSetupOverlap('member',name);
    await page.goto('/admin?area=me&view=keys&key=member-setup-new');
    if(zoom!==1)await page.evaluate(value=>{document.documentElement.style.zoom=String(value);},zoom);
    await page.evaluate(()=>document.fonts.ready);
    const selected=page.locator('[data-key-detail="member-setup-new"]');
    await expect(selected.getByRole('heading',{name,exact:true})).toBeVisible();
    await expect(page.locator('[data-key-id="member-setup-new"]')).toHaveAttribute('data-state','selected');
    await expect(page.locator('[data-key-id="member-setup-new"] code')).toHaveText('display_member_new');
    expect(await page.locator('.member-keys-table tr[data-key-id]').evaluateAll(rows=>rows.every(row=>{
      const column=row.querySelector('td:first-child')!.getBoundingClientRect();
      const range=document.createRange();range.selectNodeContents(row.querySelector('td:first-child strong')!);
      return [...range.getClientRects()].every(rect=>rect.left>=column.left-1&&rect.right<=column.right+1);
    }))).toBe(true);
    const geometry=await selected.evaluate(panel=>{
      const box=panel.getBoundingClientRect();const neighbor=panel.querySelector('header a')!.getBoundingClientRect();
      const range=document.createRange();range.selectNodeContents(panel.querySelector('h2')!);
      const rects=[...range.getClientRects()].map(rect=>({left:rect.left,right:rect.right,top:rect.top,bottom:rect.bottom}));
      const descendants=[...panel.querySelectorAll('h2,code,p,a')].map(element=>{const rect=element.getBoundingClientRect();return {tag:element.tagName,left:rect.left,right:rect.right};});
      return {column:{left:box.left,right:box.right,width:box.width},neighbor:{left:neighbor.left,right:neighbor.right,top:neighbor.top,bottom:neighbor.bottom},rects,descendants};
    });
    expect(geometry.rects.every(rect=>rect.left>=geometry.column.left-1&&rect.right<=geometry.column.right+1)).toBe(true);
    expect(geometry.descendants.every(rect=>rect.left>=geometry.column.left-1&&rect.right<=geometry.column.right+1)).toBe(true);
    expect(geometry.rects.some(rect=>Math.min(rect.right,geometry.neighbor.right)-Math.max(rect.left,geometry.neighbor.left)>1&&Math.min(rect.bottom,geometry.neighbor.bottom)-Math.max(rect.top,geometry.neighbor.top)>1)).toBe(false);
    const report={head,stylesSha256,role:'member',engine:info.project.name,viewport:{width,height:900},theme:'light',zoom,syntheticNameLength:name.length,...geometry};
    const path=info.outputPath('selected-key-descendant-geometry.json');writeFileSync(path,JSON.stringify(report,null,2));await info.attach('selected key text containment',{path,contentType:'application/json'});
    await screenshot(page,info,`key-long-name-${width}-${zoom}x`);
    expect(worker.requests.filter(request=>request.method==='POST')).toHaveLength(0);
  });
});
