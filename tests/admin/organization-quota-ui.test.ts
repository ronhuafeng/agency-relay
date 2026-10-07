import { describe, expect, it } from "vitest";
import { JSDOM } from "jsdom";
import { handleRequest } from "../../src/router";
import { consoleCookie, makeFixture, seedDashboardAdmin } from "../router/fixture";

async function write(accept: string, mode = "cors", amount = "42", bulk = true) {
  const fixture = makeFixture(); seedDashboardAdmin(fixture);
  const body = new URLSearchParams({confirm:'1'});
  if (bulk) for (const surface of ['codex','grok','xai']) { body.set(surface,surface === 'codex' ? amount : '1000000'); body.set(`expected_${surface}`,'1000000'); }
  else body.set('monthly_allowance',amount);
  const response = await handleRequest(new Request(`https://admin.example.test/admin/ui/credit-defaults${bulk ? '' : '/codex'}`, {
    method:'POST',headers:{Accept:accept,'Sec-Fetch-Mode':mode,Origin:'https://admin.example.test',Cookie:`__Host-mini-console=${await consoleCookie(fixture,'operator@example.com')}`,'Content-Type':'application/x-www-form-urlencoded'},
    body
  }),fixture.env,fixture.ctx,fixture.deps);
  return {fixture,response};
}

describe('organization quota response negotiation',()=>{
  it('keeps JSON clients on the existing response contract',async()=>{
    const {response}=await write('application/json','navigate','42',false);
    expect(response.status).toBe(200); expect(response.headers.get('content-type')).toContain('application/json');
    expect(await response.json()).toMatchObject({surface_grant:'surface:codex:production',monthly_allowance:42});
  });
  it.each(['cors','navigate'])('rejects an obsolete HTML form without writing (%s)',async mode=>{
    const {fixture,response}=await write('text/html',mode,'42',false);
    expect(response.status).toBe(409);
    const row=await fixture.env.DB.prepare("SELECT monthly_allowance FROM organization_surface_credit_defaults WHERE surface_grant = 'surface:codex:production'").first<{monthly_allowance:number}>();
    expect(row?.monthly_allowance).toBe(1000000);
    const doc=new JSDOM(await response.text()).window.document;
    expect(doc.querySelector('[data-mutation-input-error]')?.textContent).toContain('这次没有保存');
    expect(doc.querySelector('[data-rejected-read]')?.getAttribute('href')).toBe('/admin?view=quotas');
    expect(doc.querySelector('[data-mutation-flash="credit_default"]')).toBeNull();
  });
  it('acknowledges the exact saved value in an enhanced HTML result',async()=>{
    const {response}=await write('text/html');
    expect(response.status).toBe(200);
    const doc=new JSDOM(await response.text()).window.document;
    expect(doc.querySelector('main')?.getAttribute('data-dashboard-mutation')).toBe('credit_default');
    expect(doc.querySelector('[data-mutation-flash]')?.textContent).toContain('每月 42 credits');
    expect(doc.querySelector('main')?.getAttribute('data-dashboard-url')).toBe('/admin?view=quotas&range=7d');
    expect(doc.querySelectorAll('form[action="/admin/ui/credit-defaults"] button[type=submit]')).toHaveLength(1);
    expect(doc.querySelectorAll('form[action^="/admin/ui/credit-defaults/"]')).toHaveLength(0);
  });
  it('acknowledges native navigation with an explicit canonical GET link',async()=>{
    const {response}=await write('text/html','navigate');
    expect(response.status).toBe(200); expect(response.headers.get('location')).toBeNull();
    expect(response.headers.get('cache-control')).toBe('no-store');
    const doc=new JSDOM(await response.text()).window.document;
    expect(doc.querySelector('[data-mutation-flash="credit_default"]')?.textContent).toContain('每月 42 credits');
    expect(doc.querySelector('[data-quota-confirmed-read]')?.getAttribute('href')).toBe('/admin?view=quotas');
    expect(doc.querySelector('[data-quota-read-guidance]')?.textContent).toContain('若刷新时提示再次提交，请取消');
  });
  it('does not acknowledge rejected input',async()=>{
    const {response}=await write('text/html','navigate','-1');
    expect(response.status).toBe(400); expect(response.headers.get('location')).toBeNull();
  });
});
