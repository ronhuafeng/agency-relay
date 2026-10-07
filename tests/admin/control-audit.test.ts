import { JSDOM } from "jsdom";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { readControlAudit } from "../../src/admin/control-audit";
import { ControlAuditPage } from "../../src/admin/ui/pages/organization";
import { createTestD1 } from "../support/sqlite-d1";
import { commitServiceAccount, commitServiceName, commitLegacyServiceClassification } from "../../src/auth/service-accounts";
import { commitServiceOwner } from "../../src/auth/service-delegation";

const fixtures: ReturnType<typeof createTestD1>[] = [];
afterEach(() => { for (const db of fixtures.splice(0)) db.close(); });
function fixture() {
  const db = createTestD1(); fixtures.push(db);
  const at = '2026-06-24T12:00:00.000Z';
  db.sqlite.prepare(`INSERT INTO users (id,email,account_kind,role,status,created_at,updated_at) VALUES ('person','current@example.test','human','user','active',?,?)`).run(at,at);
  db.sqlite.prepare(`INSERT INTO codex_auths (id,kind,label,environment,status,created_at,updated_at) VALUES ('shared-id','shared','ChatGPT same label','production','active',?,?)`).run(at,at);
  db.sqlite.prepare(`INSERT INTO subscription_accounts (id,capability_source,label,environment,status,created_at,updated_at) VALUES ('shared-id','grok','Grok same label','production','active',?,?)`).run(at,at);
  const insert = db.sqlite.prepare(`INSERT INTO operator_mutation_audit (id,at,actor_kind,actor_email,actor_role,action,target_type,target_id,result,request_id,meta,created_at) VALUES (?,?,'access','historical@example.test','admin',?,?,?,?,'safe-test','{}',?)`);
  return { db, add(id: string, targetType: string, targetId: string, action = 'user.email', result = 'ok') { insert.run(id,at,action,targetType,targetId,result,at); }, env: { DB: db.binding } as Env };
}

describe('bounded human control audit', () => {
  it('names committed service lifecycle and owner changes while retaining the exact target', async () => {
    const f = fixture();
    const actor = {kind: 'admin_secret' as const, userId: null, email: null, role: null, subject: null, requestId: 'safe-service-audit'};
    const now = new Date('2026-06-24T12:01:00.000Z');
    const service = await commitServiceAccount(f.env, actor, 'Nightly service', now);
    await commitServiceName(f.env, actor, service.id, 'Renamed service', now);
    await commitServiceOwner(f.env, actor, service.id, {owner_user_id: null, expected_revision: 0}, now);
    f.db.sqlite.prepare("INSERT INTO users (id,email,canonical_email,account_kind,role,status,login_capable,created_at,updated_at) VALUES ('legacy',NULL,NULL,'legacy_unresolved','user','active',0,?,?)").run(now.toISOString(),now.toISOString());
    await commitLegacyServiceClassification(f.env, actor, 'legacy', {display_name:'Reviewed legacy service',expected_updated_at:now.toISOString()}, now);
    const model = await readControlAudit(f.env, '/admin?view=control-audit');
    const doc = new JSDOM(renderToStaticMarkup(createElement(ControlAuditPage, model))).window.document;
    const expected = new Map([
      ['service.create', '创建服务账号'], ['service.rename', '更改服务账号名称'],
      ['service.classify', '确认为服务账号'], ['service.owner.change', '更改服务管理人']
    ]);
    expect(model.rows).toHaveLength(4);
    expect(new Set(model.rows.map(row => row.action))).toEqual(new Set(expected.keys()));
    for (const [index, row] of model.rows.entries()) {
      expect(row.result).toBe('ok');
      expect(row.target_id).toBe(row.action === 'service.classify' ? 'legacy' : service.id);
      expect(row.target_href).toBe(`/admin?view=access&person=${encodeURIComponent(row.target_id)}`);
      expect(row.target_label).toBe(row.action === 'service.classify' ? 'Reviewed legacy service' : 'Renamed service');
      expect(doc.querySelectorAll('.control-record-object>strong')[index]?.textContent).toBe(expected.get(row.action));
    }
  });
  it('resolves current objects without rewriting actor history or confusing provider IDs', async () => {
    const f = fixture();
    f.add('1','user','person'); f.add('2','codex_auth','shared-id'); f.add('3','subscription_account','shared-id'); f.add('4','user','missing','future.unknown','unconfirmed');
    const model = await readControlAudit(f.env,'/admin?view=control-audit&range=7d');
    expect(model.truncated).toBe(false);
    const person = model.rows.find(row => row.target_type === 'user' && row.target_id === 'person')!;
    expect(person.target_label).toBe('current@example.test');
    expect(person.actor_email).toBe('historical@example.test');
    expect(person.target_href).toBe('/admin?view=access&range=7d&person=person');
    expect(model.rows.find(row => row.target_type === 'codex_auth')?.target_href).toContain('account=codex%3Ashared-id');
    expect(model.rows.find(row => row.target_type === 'subscription_account')?.target_href).toContain('account=grok%3Ashared-id');
    expect(model.rows.find(row => row.target_id === 'missing')?.target_href).toBeNull();
    const doc = new JSDOM(renderToStaticMarkup(createElement(ControlAuditPage, model))).window.document;
    expect(doc.querySelectorAll('.control-record')).toHaveLength(4);
    expect(doc.body.textContent).toContain('结果未知');
    expect(doc.querySelector('#management-history-scope')?.textContent).toContain('对象使用当前名称');
    expect(doc.querySelector('.control-record [popover]')?.textContent).toContain('future.unknown');
    expect(doc.querySelectorAll('.control-record [popover]')).toHaveLength(4);
    for (const popup of doc.querySelectorAll('[popover]')) expect(doc.querySelector(`button[popovertarget="${popup.id}"]`)).not.toBeNull();
  });
  it('caps rendering at 100 with explicit truncation and renders an honest empty state', async () => {
    const f = fixture();
    const empty = await readControlAudit(f.env,'/admin?view=control-audit');
    expect(empty).toEqual({ rows: [], truncated: false });
    for (let i=0;i<105;i++) f.add(String(i).padStart(3,'0'),'user','person');
    const model = await readControlAudit(f.env,'/admin?view=control-audit');
    expect(model.rows).toHaveLength(100); expect(model.truncated).toBe(true);
    const doc = new JSDOM(renderToStaticMarkup(createElement(ControlAuditPage, model))).window.document;
    expect(doc.body.textContent).toContain('未显示全部记录');
    expect(doc.body.textContent).toContain('只搜索当前列表');
  });
});
