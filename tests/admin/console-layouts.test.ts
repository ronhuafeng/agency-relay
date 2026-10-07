import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { JSDOM } from 'jsdom';
import { describe, expect, it, onTestFinished } from 'vitest';
import { createTestD1 } from '../support/sqlite-d1';
import { makeFixture } from '../router/fixture';
import { createConsoleSession } from '../../src/auth/console-session';
import { handleRequest } from '../../src/router';
import { CONSOLE_RETURN_SECTIONS, consoleLoginHref, consoleReturnTarget } from '../../src/admin/return-target';
import { HomePage, type HomeModel } from '../../src/admin/ui/pages/home';
import { parseUsageTrendRange } from '../../src/admin/usage-query';

const at = '2026-06-24T12:00:00.000Z';
function fixture() {
  const db = createTestD1(); onTestFinished(() => db.close());
  const f = makeFixture({env:{DB:db.binding}});
  for (const id of ['admin','member','other']) db.sqlite.prepare(`INSERT INTO users
    (id,email,canonical_email,login_capable,account_kind,role,status,created_at,updated_at)
    VALUES (?,?,?,1,'human',?,'active',?,?)`).run(id,`${id}@example.com`,`${id}@example.com`,id==='admin'?'admin':'user',at,at);
  db.sqlite.exec(`UPDATE organization_surface_credit_defaults SET monthly_allowance=100;
    INSERT INTO codex_auths (id,kind,label,environment,status,created_at,updated_at) VALUES ('layout-account','shared','Display only','production','active','t','t');
    INSERT INTO organization_surface_credential_defaults (surface_grant,codex_auth_id,created_at,updated_at) VALUES ('surface:codex:production','layout-account','t','t');`);
  for (const id of ['first','second']) {
    db.sqlite.prepare(`INSERT INTO api_keys (id,user_id,key_prefix,key_hash,status,scopes,name,family_id,expires_at,created_at)
      VALUES (?,'member',?,?,'active','["surface:codex:production"]',?,?,'2026-09-01T00:00:00.000Z',?)`).run(id,`display_${id}`,`invalid-display-only-hash-${id}`,`Workstation ${id}`,`family-${id}`,at);
    db.sqlite.prepare(`INSERT INTO api_key_surface_credentials (api_key_id,surface_grant,codex_auth_id,created_at,updated_at) VALUES (?,'surface:codex:production','layout-account',?,?)`).run(id,at,at);
  }
  const open = async (path:string, identity='admin') => {
    const session = await createConsoleSession(f.env,{id:identity,email:`${identity}@example.com`,sessionEpoch:0},new Date(at));
    const response = await handleRequest(new Request(`https://admin.example.test${path}`,{headers:{Cookie:`__Host-mini-console=${session}`}}),f.env,f.ctx,{...f.deps,now:()=>new Date(at)});
    expect(response.status).toBe(200); return new JSDOM(await response.text()).window.document;
  };
  return {db,open};
}
describe('task-oriented console layouts',()=>{
  it.each([
    ['/admin?view=access&person=member&q=member&range=30d','admin'],
    ['/admin?area=me&view=keys','member'],
    ['/admin?view=audit&audit_user=member&audit_result=error','admin'],
    ['/admin?view=surfaces','admin']
  ])('retains rendered task-section links through exact login recovery: %s',async(path,identity)=>{
    const doc=await fixture().open(path,identity);
    const links=[...doc.querySelectorAll<HTMLAnchorElement>('main a[href^="#"]')];
    const fragments = links.map(link=>link.getAttribute("href")!);
    if (path === "/admin?area=me&view=keys") fragments.push("#member-key-form");
    if (path.startsWith("/admin?view=audit")) fragments.push("#request-history");
    expect(fragments.length).toBeGreaterThan(0);
    for(const fragment of fragments) {
      expect(doc.querySelector(fragment)).not.toBeNull();
      const target=path+fragment;
      expect(consoleReturnTarget(target)).toBe(target);
      expect(new URL(consoleLoginHref(target),'https://console.invalid').searchParams.get('return')).toBe(target);
    }
    if(path==='/admin?view=surfaces') {
      // The bounded recovery entries cover exactly the live catalog's host headings.
      const fragments=links.map(link=>link.getAttribute('href'));
      expect(CONSOLE_RETURN_SECTIONS.filter(section=>section.startsWith('#route-host-'))).toEqual(fragments);
      expect(consoleReturnTarget(`${path}#route-host-${fragments.length}-title`)).toBeNull();
    }
  });
  it('preserves the selected person, key actions, policy facts and exact filtered parent',async()=>{
    const f=fixture(); const doc=await f.open('/admin?view=access&q=member&person=member');
    const detail=doc.querySelector('[data-person-detail="member"]')!;
    expect(detail.querySelector('a[aria-label="管理密钥 display_first"]')?.getAttribute('href')).toContain('person=member');
    expect(detail.querySelector('a[aria-label="管理密钥 display_first"]')?.getAttribute('href')).toContain('key=first');
    const parent=new URL(doc.querySelector('a[aria-label="收起人员详情"]')!.getAttribute('href')!,'https://console.invalid');
    expect(parent.searchParams.get('q')).toBe('member');expect(parent.searchParams.has('person')).toBe(false);
    for(const surface of ['codex','grok','xai']) {
      const policy=detail.querySelector(`[data-credit-surface="${surface}"]`)!;
      expect(policy.textContent).toContain('组织默认');
      expect(policy.querySelector('form')?.getAttribute('action')).toBe(`/admin/ui/users/member/credits/${surface}`);
      expect(detail.querySelector(`#credit-policy-member-${surface}-editor select[name="mode"]`)?.querySelectorAll('option')).toHaveLength(3);
    }
    expect(detail.querySelector('[data-action="user-status"]')?.getAttribute('data-confirmation')).toContain('已复制的服务账号密钥');
    for(const link of detail.querySelectorAll<HTMLAnchorElement>('nav[aria-label="人员内容"] a')) expect(doc.querySelector(link.hash)).not.toBeNull();
    expect(doc.body.textContent).not.toContain('invalid-display-only-hash');
  });
  it('keeps member creation and selected/missing keys exact',async()=>{
    const f=fixture(); const doc=await f.open('/admin?area=me&view=keys','member');
    const form=doc.querySelector('[data-member-key-create]')!;
    expect(form.querySelector<HTMLInputElement>('input[name="key_return"]')?.value).toBe('/admin?area=me&view=keys');
    expect(doc.querySelectorAll('[data-key-id]')).toHaveLength(2);
    const header=doc.querySelector('thead .member-key-actions-head')!;
    expect(header.querySelector('[data-member-create-toggle]')?.getAttribute('aria-label')).toBe('创建密钥');
    expect(header.querySelector('[data-member-create-toggle]')?.textContent?.trim()==='').toBe(true);
    expect(header.querySelector('button[popovertarget="key-bulk-actions"]')?.getAttribute('aria-label')).toBe('撤销我的全部密钥');
    expect(doc.querySelector('[data-member-create-row]')?.hasAttribute('hidden')).toBe(false);
    expect(doc.querySelector('[data-member-key-row]:not([hidden])')).toBeNull();
    const selected=await f.open('/admin?area=me&view=keys&key=second','member');
    expect([...selected.querySelectorAll('[data-key-id]')].map(node=>node.getAttribute('data-key-id'))).toEqual(['first','second']);
    expect(selected.querySelector('[data-key-id=second]')?.getAttribute('data-state')).toBe('selected');
    const visible=selected.querySelector('[data-member-key-row]:not([hidden])')!;
    expect(visible.getAttribute('data-member-key-row')).toBe('second');
    expect(visible.previousElementSibling?.getAttribute('data-key-id')).toBe('second');
    expect(visible.querySelector('[data-key-detail] form')?.getAttribute('action')).toBe('/me/ui/keys/second/rename');
    expect(visible.querySelector('[data-member-key-close]')?.getAttribute('href')).toBe('/admin?area=me&view=keys');
    expect(selected.querySelectorAll('[data-member-key-row]')).toHaveLength(2);
    for(const row of selected.querySelectorAll('[data-member-key-row]')) {
      const id=row.getAttribute('data-member-key-row')!;
      expect(row.querySelector<HTMLInputElement>('input[name="key_return"]')?.value).toBe(`/admin?area=me&view=keys&key=${id}`);
    }
    const absent=await f.open('/admin?area=me&view=keys&key=foreign','member');
    expect(absent.querySelector('[data-key-state="missing"]')).not.toBeNull();expect(absent.querySelector('[data-member-key-row]:not([hidden])')).toBeNull();
  });
  it('keeps personal setup local and places task evidence in the exact key detail',async()=>{
    const f=fixture();const doc=await f.open('/admin?area=me&view=setup&key=second','member');
    expect(doc.querySelector('[data-setup-key]')).toBeNull();
    expect(doc.querySelector('.member-setup-config [data-local-config-sync]')).not.toBeNull();
    expect(doc.querySelectorAll('.member-setup-config [popover]')).toHaveLength(1);
    const keys=await f.open('/admin?area=me&view=keys&key=second','member');
    const detail=keys.querySelector('[data-key-detail="second"]')!;
    expect(detail.querySelector('.key-task-evidence')?.textContent).toContain('未记录成功任务');
    expect(detail.textContent).not.toContain('Workstation first');
    expect(detail.querySelector('[data-member-key-close]')?.getAttribute('href')).toBe('/admin?area=me&view=keys');
  });
  it('keeps zero, unlimited and disabled allowance facts without fabricated progress',async()=>{
    const f=fixture();
    f.db.sqlite.prepare(`INSERT INTO user_surface_credit_policies (user_id,surface_grant,monthly_allowance,created_at,updated_at)
      VALUES ('member','surface:codex:production',0,?,?)`).run(at,at);
    for(const [surface,mode] of [['grok','unlimited'],['xai','disabled']]) f.db.sqlite.prepare(`INSERT INTO user_surface_credit_modes
      (user_id,surface_grant,mode,created_at,updated_at) VALUES ('member',?,?,?,?)`).run(`surface:${surface}:production`,mode,at,at);
    f.db.sqlite.prepare(`INSERT INTO user_surface_credit_usage
      (user_id,surface_grant,period_start,consumed_credits,admitted_attempts,last_seen_at)
      VALUES ('member','surface:codex:production','2026-06-01',7,1,?)`).run(at);
    for(const view of ['quota','home']) {
      const doc=await f.open(`/admin?area=me&view=${view}`,'member');
      const table=doc.querySelector(view==='quota'?'[data-member-quota]':'[data-member-home]')!;
      expect(table.querySelectorAll('[role="progressbar"]')).toHaveLength(0);
      const value=(surface:string)=>table.querySelector(`[data-surface="${surface}"] .member-credit-value`)?.textContent;
      expect(value('codex')).toBe('已用 / 上限：7 / 0');
      expect(value('grok')).toBe('已用 / 上限：0 / 不限');
      expect(value('xai')).toBe('已用 / 上限：0 / 已停用');
      expect(table.querySelector('[data-surface="codex"] td:first-child')?.textContent).toBe('Codex');
      expect(table.querySelector('[data-surface="xai"] td:first-child')?.textContent).toBe('xAI API');
      if(view==='quota') {
        const help=table.querySelector('thead [popover]')!;
        expect(help.textContent).toContain('Codex：自定义额度');
        expect(help.querySelectorAll('time[datetime]')).toHaveLength(1);
        expect(help.querySelector('time')?.getAttribute('datetime')).toBe('2026-07-01T00:00:00.000Z');
        expect(doc.querySelector('.credit-table-footer')).toBeNull();
      }
    }
  });
  it('finds a setup key by its current name through the real SQL inventory',async()=>{
    const doc=await fixture().open('/admin?view=setup&q=Workstation%20second');
    const choices=[...doc.querySelectorAll('[data-setup-key-id]')];
    expect(choices.map(node=>node.getAttribute('data-setup-key-id'))).toEqual(['second']);
    expect(choices[0]?.textContent).toContain('Workstation second');
    const target=new URL(choices[0]!.querySelector('a')!.getAttribute('href')!,'https://console.invalid');
    expect(target.searchParams.get('person')).toBe('member');
    expect(target.searchParams.get('key')).toBe('second');
  });
  it('visibly distinguishes same-name old and replacement keys by their safe prefixes',async()=>{
    const f=fixture();
    f.db.sqlite.exec("UPDATE api_keys SET name='Workstation', family_id='family-first' WHERE id IN ('first','second')");
    for(const [id,other] of [['first','second'],['second','first']]) {
      const doc=await f.open(`/admin?area=me&view=keys&key=${id}`,'member');
      const selected=doc.querySelector(`[data-key-detail="${id}"]`)!;
      expect(selected.querySelector('h2')?.textContent).toBe('Workstation');
      const row=doc.querySelector(`[data-key-id="${id}"]`)!;
      expect(row.getAttribute('data-state')).toBe('selected');
      expect(row.querySelector('code')?.textContent).toBe(`display_${id}`);
      expect(selected.querySelector(`a[href="/admin?area=me&view=keys&key=${other}"]`)?.textContent).toBe(`display_${other}`);
      expect(selected.querySelector('.key-task-evidence')?.textContent).not.toContain(`display_${other}`);
      expect(selected.querySelector('form[action$="/revoke"]')?.getAttribute('action')).toBe(`/me/ui/keys/${id}/revoke`);
      expect(row.querySelector('.key-manage-link')?.getAttribute('href')).toBe(`/admin?area=me&view=keys&key=${id}`);
      expect(doc.body.textContent).not.toContain('invalid-display-only-hash');
    }
  });
  it('links Home failures to the observed plan, UTC date and failure result',()=>{
    const model:HomeModel={canonicalUrl:'/admin',range:{key:'7d'},userCount:2,keyCount:3,accounts:[],trends:{range:parseUsageTrendRange(new URL('https://console.invalid/?range=7d'),new Date(at)),daily:{responses:[],media:[]},scopeLabel:'组织用量'},attempts:[{route_profile_id:'codex.responses',request_count:4,ok_count:1,error_count:3,last_success_at:'2026-06-23T09:00:00.000Z',last_failure_at:at,avg_latency_ms:null,upstream_status_sample:null}]};
    const doc=new JSDOM(renderToStaticMarkup(createElement(HomePage,{model}))).window.document;
    const link=doc.querySelector('[data-attention="client-failure"] a')!;
    const url=new URL(link.getAttribute('href')!,'https://console.invalid');
    expect(url.pathname).toBe('/admin');expect(url.searchParams.get('audit_plan')).toBe('codex.responses');expect(url.searchParams.get('audit_result')).toBe('error');
    expect(url.searchParams.get('audit_from')).toBe('2026-06-24');expect(url.searchParams.get('audit_to')).toBe('2026-06-24');expect(url.hash).toBe('#request-history');
    expect(new JSDOM(renderToStaticMarkup(createElement(HomePage,{model:{...model,attempts:[]}}))).window.document.querySelector('[data-attention-queue]')).toBeNull();
  });
  it('uses one server request filter and retains exact record details without independent summaries',async()=>{
    const f=fixture(); f.db.sqlite.prepare(`INSERT INTO request_audit (id,request_id,route_profile_id,route,user_id,key_id,status,upstream_status,created_at) VALUES ('request-one','correlation','codex.responses','/v1/responses','member','first','error',NULL,?)`).run(at);
    const doc=await f.open('/admin?view=audit');
    expect(doc.querySelector('#activity-summary')).toBeNull();
    expect(doc.querySelector('[data-traffic-summary]')).toBeNull();
    expect(doc.querySelector('[data-request-record="request-one"] time[datetime]')?.getAttribute('title')).toBe(at);
    expect(doc.querySelectorAll('form[aria-label="筛选请求记录"]')).toHaveLength(1);
    expect(doc.querySelector('input[name="audit_user"]')).not.toBeNull();
    expect(doc.querySelector('select[name="audit_plan"]')).not.toBeNull();
    expect(doc.querySelector('[data-request-record="request-one"] a')?.getAttribute('href')).toContain('record=request-one');
    expect(doc.querySelector('form[aria-label="筛选请求记录"]')?.getAttribute('method')).toBe('get');
  });
});
