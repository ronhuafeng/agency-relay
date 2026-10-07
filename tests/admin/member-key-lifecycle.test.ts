import { JSDOM } from "jsdom";
import { expect, it } from "vitest";
import { createConsoleSession } from "../../src/auth/console-session";
import { resolveConsolePrincipal } from "../../src/auth/principal";
import { handleRequest } from "../../src/router";
import { makeFixture } from "../router/fixture";
import { createTestD1 } from "../support/sqlite-d1";
const host="https://admin.example.test";
async function fixture() {
  const db=createTestD1();const fixture=makeFixture({env:{DB:db.binding}});const now=fixture.deps.now();
  const principal=await resolveConsolePrincipal(fixture.env,"member@example.com",now);
  const token=await createConsoleSession(fixture.env,principal,now);
  db.sqlite.exec(`UPDATE organization_surface_credit_defaults SET monthly_allowance=100;
    INSERT INTO codex_auths (id,kind,label,environment,status,created_at,updated_at) VALUES ('account','shared','Synthetic','production','active','t','t');
    INSERT INTO organization_surface_credential_defaults (surface_grant,codex_auth_id,created_at,updated_at) VALUES ('surface:codex:production','account','t','t');`);
  await fixture.tokenAuthority.saveToken({auth_id:"account",access_token:"synthetic-provider-placeholder",expires_at:new Date(now.getTime()+86400000).toISOString(),status:"active"});
  const post=(path:string,body:Record<string,string>,cookie=token)=>handleRequest(new Request(host+path,{method:"POST",headers:{Cookie:`__Host-mini-console=${cookie}`,Origin:host,Accept:"text/html","Content-Type":"application/x-www-form-urlencoded"},body:new URLSearchParams(body)}),fixture.env,fixture.ctx,fixture.deps);
  const get=(path:string)=>handleRequest(new Request(host+path,{headers:{Cookie:`__Host-mini-console=${token}`,Accept:"text/html"}}),fixture.env,fixture.ctx,fixture.deps);
  return {db,post,get,principal,now};
}
const submission=()=>`submit_${crypto.randomUUID()}`;
it("does not issue a second secret on native create refresh and rejects changed parameters",async()=>{
  const f=await fixture();try{
    const body={submission_id:submission(),name:"Work",surfaces:"codex"};
    const first=await f.post("/me/ui/keys",body);expect(first.status).toBe(200);expect((await first.text()).includes('data-one-time-key="true"')).toBe(true);
    const again=await f.post("/me/ui/keys",body);expect(again.status).toBe(200);const text=await again.text();expect(text.includes("此前已经完成")).toBe(true);expect(text.includes("data-one-time-key")).toBe(false);
    const changed=await f.post("/me/ui/keys",{...body,name:"Different"});expect(changed.status).toBe(409);expect(await changed.text()).toContain("其他内容");
    expect(f.db.sqlite.prepare("SELECT COUNT(*) AS count FROM api_keys").get()).toEqual({count:1});
    expect(f.db.sqlite.prepare("SELECT COUNT(*) AS count FROM operator_mutation_audit WHERE action='key.create'").get()).toEqual({count:1});
    f.db.sqlite.prepare("UPDATE users SET console_session_epoch=console_session_epoch+1 WHERE id=?").run(f.principal.id);
    const expired=await f.post("/me/ui/keys",body);expect(expired.status).toBe(403);expect(await expired.text()).toContain("密钥操作没有执行");
  }finally{f.db.close();}
});
it("renames and revokes natively with exact GET return, retaining known already-revoked outcome",async()=>{
  const f=await fixture();try{
    await f.post("/me/ui/keys",{submission_id:submission(),name:"Work",surfaces:"codex"});
    const row=f.db.sqlite.prepare("SELECT id,key_hash,scopes,expires_at FROM api_keys").get() as {id:string;key_hash:string;scopes:string;expires_at:string};
    const renamed=await f.post(`/me/ui/keys/${row.id}/rename`,{name:"Laptop"});expect(renamed.status).toBe(200);const doc=new JSDOM(await renamed.text()).window.document;
    expect(doc.querySelector('[data-member-result]')?.getAttribute('data-member-return')).toBe(`/admin?area=me&view=keys&key=${row.id}`);
    expect(f.db.sqlite.prepare("SELECT id,key_hash,scopes,expires_at FROM api_keys").get()).toEqual(row);
    expect((await f.post(`/me/ui/keys/${row.id}/revoke`,{})).status).toBe(200);
    const again=await f.post(`/me/ui/keys/${row.id}/revoke`,{});expect(await again.text()).toContain("原本已撤销");
    expect(f.db.sqlite.prepare("SELECT COUNT(*) AS count FROM operator_mutation_audit WHERE action='key.revoke'").get()).toEqual({count:1});
  }finally{f.db.close();}
});
it("renews an expired raw-active key without reviving it, then deduplicates replacement replay",async()=>{
  const f=await fixture();try{
    await f.post("/me/ui/keys",{submission_id:submission(),name:"Work",surfaces:"codex"});
    const row=f.db.sqlite.prepare("SELECT id,family_id FROM api_keys").get() as {id:string;family_id:string};
    f.db.sqlite.prepare("UPDATE api_keys SET expires_at=? WHERE id=?").run(new Date(f.now.getTime()-1).toISOString(),row.id);
    const body={submission_id:submission(),expires_at:new Date(f.now.getTime()+30*86400000).toISOString()};
    const result=await f.post(`/me/ui/keys/${row.id}/replace`,body);expect(result.status).toBe(200);const text=await result.text();expect(text.includes("不会因为这次续发恢复有效")).toBe(true);expect(text.includes("仍可认证")).toBe(false);
    f.db.sqlite.prepare("UPDATE api_keys SET status='revoked' WHERE id=?").run(row.id);
    const replay=await f.post(`/me/ui/keys/${row.id}/replace`,body);expect(replay.status).toBe(200);expect((await replay.text()).includes("data-one-time-key")).toBe(false);
    expect(f.db.sqlite.prepare("SELECT COUNT(*) AS count FROM api_keys WHERE family_id=?").get(row.family_id)).toEqual({count:2});
    const wrongOperation=await f.post("/me/ui/keys",{...body,name:"Another",surfaces:"codex"});expect(wrongOperation.status).toBe(409);
  }finally{f.db.close();}
});
