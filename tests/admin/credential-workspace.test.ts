import { JSDOM } from "jsdom";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { createConsoleSession } from "../../src/auth/console-session";
import { issueMemberKey, replaceMemberKey } from "../../src/auth/api-keys";
import { handleRequest } from "../../src/router";
import { makeFixture } from "../router/fixture";
import { createTestD1 } from "../support/sqlite-d1";

const NOW = new Date("2026-06-24T12:00:00.000Z");
const ORIGIN = "https://admin.example.test";
const actor = {kind: "admin_secret" as const, userId: null, email: null, role: null, subject: null, requestId: "synthetic-issuance"};

async function fixture() {
  let failedRead = false;
  let failedCleanup = false;
  const cleanup: string[] = [];
  const purged: string[] = [];
  const db = createTestD1({onPrepare: sql => {
    if (failedRead && sql.includes("FROM api_keys AS k")) throw new Error("Synthetic linked-key read unavailable");
  }});
  onTestFinished(() => db.close());
  const runtime = makeFixture({env: {DB: db.binding, TOKEN_AUTHORITY: {
    idFromName: (name: string) => name,
    get: (id: string) => ({
      getFreshSubscriptionCredential: async () => ({ok: true, value: {token: "invalid-synthetic-display-only"}}),
      getFreshAccessToken: async () => ({ok: false, error: {status: 503, message: "Synthetic account evidence unavailable", type: "server_error", code: "account_unavailable"}}),
      revoke: async () => { cleanup.push(id); if (failedCleanup) throw new Error("Synthetic cleanup unavailable"); },
      revokeSubscription: async () => { cleanup.push(id); if (failedCleanup) throw new Error("Synthetic cleanup unavailable"); },
      clearSubscriptionStorage: async () => { purged.push(id); return {cleared:true}; }
    })
  } as unknown as Env["TOKEN_AUTHORITY"]}});
  for (const id of ["admin", "member"]) db.sqlite.prepare(`INSERT INTO users
    (id,email,canonical_email,account_kind,login_capable,role,status,created_at,updated_at)
    VALUES (?,?,?,'human',1,?,'active',?,?)`).run(id, `${id}@example.com`, `${id}@example.com`, id === "admin" ? "admin" : "user", NOW.toISOString(), NOW.toISOString());
  db.sqlite.exec("UPDATE organization_surface_credit_defaults SET monthly_allowance=100");
  for (const id of ["old", "new"]) db.sqlite.prepare(`INSERT INTO subscription_accounts
    (id,capability_source,label,environment,status,refresh_available,created_at,updated_at)
    VALUES (?,'grok',?,'production','active',1,?,?)`).run(id, `Synthetic ${id}`, NOW.toISOString(), NOW.toISOString());
  for (const surface of ["grok", "xai"]) db.sqlite.prepare(`INSERT INTO organization_surface_credential_defaults
    (surface_grant,subscription_account_id,created_at,updated_at) VALUES (?,'old',?,?)`).run(`surface:${surface}:production`, NOW.toISOString(), NOW.toISOString());
  for (const id of ["move", "keep"]) {
    db.sqlite.prepare(`INSERT INTO api_keys (id,user_id,key_prefix,key_hash,status,scopes,name,family_id,created_at)
      VALUES (?,'member',?,'invalid-display-only-hash','active','["surface:grok:production","surface:xai:production"]',?,?,?)`).run(id, `display_${id}`, id, `family-${id}`, NOW.toISOString());
    for (const surface of ["grok", "xai"]) db.sqlite.prepare(`INSERT INTO api_key_surface_credentials
      (api_key_id,surface_grant,subscription_account_id,created_at,updated_at) VALUES (?,?,'old',?,?)`).run(id, `surface:${surface}:production`, NOW.toISOString(), NOW.toISOString());
  }
  const session = await createConsoleSession(runtime.env, {id: "admin", email: "admin@example.com", sessionEpoch: 0}, NOW);
  const request = (path: string, fields?: [string, string][], accept = "text/html") => handleRequest(new Request(`${ORIGIN}${path}`, {
    method: fields ? "POST" : "GET",
    headers: {Cookie: `__Host-mini-console=${session}`, Accept: accept, ...(fields ? {Origin: ORIGIN} : {})},
    body: fields ? new URLSearchParams(fields) : undefined
  }), runtime.env, runtime.ctx, {...runtime.deps, now: () => NOW, fetch: async () => { throw new Error("Unexpected provider call"); }});
  const bindings = () => db.sqlite.prepare("SELECT api_key_id,surface_grant,subscription_account_id FROM api_key_surface_credentials ORDER BY api_key_id,surface_grant").all();
  const defaults = () => db.sqlite.prepare("SELECT surface_grant,subscription_account_id FROM organization_surface_credential_defaults ORDER BY surface_grant").all();
  const status = () => db.sqlite.prepare("SELECT status FROM subscription_accounts WHERE id='old'").get();
  const audits = () => db.sqlite.prepare("SELECT action,result,meta FROM operator_mutation_audit ORDER BY id").all();
  return {db, env: runtime.env, request, bindings, defaults, status, audits, cleanup, purged,
    failRead(value: boolean) { failedRead = value; }, failCleanup(value: boolean) { failedCleanup = value; }};
}

describe("native credential task commit boundary", () => {
  it.each(["text/html","application/json"])("rejects a non-Grok subscription before logout with %s", async accept => {
    const f = await fixture();
    f.db.sqlite.exec("UPDATE subscription_accounts SET capability_source='chatgpt' WHERE id='old'");
    const response = await f.request("/admin/ui/subscriptions/old/logout",[["confirm","1"]],accept);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({error:{code:"invalid_capability_source"}});
    expect(f.status()).toEqual({status:"active"});
    expect(f.cleanup).toEqual([]); expect(f.purged).toEqual([]); expect(f.audits()).toEqual([]);
  });

  it("preserves JSON orphan cleanup while the HTML task refuses an absent account", async () => {
    const f = await fixture();
    f.db.sqlite.exec("UPDATE api_key_surface_credentials SET subscription_account_id='new'; UPDATE organization_surface_credential_defaults SET subscription_account_id='new'; DELETE FROM subscription_accounts WHERE id='old'");
    expect((await f.request("/admin/ui/subscriptions/old/logout",[["confirm","1"]])).status).toBe(404);
    expect(f.cleanup).toEqual([]); expect(f.purged).toEqual([]); expect(f.audits()).toEqual([]);
    const response = await f.request("/admin/ui/subscriptions/old/logout",[["confirm","1"]],"application/json");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({account_id:"old",revoked:true,d1:"absent",storage_cleared:true});
    expect(f.cleanup).toEqual([]); expect(f.purged).toEqual(["subscription:old"]);
    expect(f.audits()).toHaveLength(1); expect(f.audits()[0]).toMatchObject({action:"credential.grok_storage_purge",result:"ok"});
  });

  it("preserves the existing JSON migration and UI disconnect alias", async () => {
    const f = await fixture();
    const blocked = await f.request("/admin/ui/subscriptions/old/disconnect",[],"application/json");
    expect(blocked.status).toBe(409);
    expect(f.status()).toEqual({status:"active"});
    expect(f.cleanup).toEqual([]);
    const migrated = await f.request("/admin/ui/subscriptions/old/migrate",[
      ["replacement_account_id","new"],["key_ids[]","move"],["key_ids[]","keep"],
      ["default_surfaces[]","grok"],["default_surfaces[]","xai"]
    ],"application/json");
    expect(migrated.status).toBe(200);
    expect((await migrated.json()) as Record<string,unknown>).toMatchObject({migrated_bindings:4,migrated_defaults:2});
    expect(f.status()).toEqual({status:"retiring"});
    expect(f.cleanup).toEqual([]);
    const disconnected = await f.request("/admin/ui/subscriptions/old/disconnect",[],"application/json");
    expect(disconnected.status).toBe(200);
    expect(await disconnected.json()).toMatchObject({completion:"complete",d1_status:"revoked",token_cleanup:"cleared",live_bindings:0});
    expect(f.status()).toEqual({status:"revoked"});
    expect(f.cleanup).toEqual(["subscription:old"]);
  });

  it.each([false,true])("retains the JSON logout outcome with partial cleanup=%s", async failed => {
    const f = await fixture();
    f.db.sqlite.exec("UPDATE api_key_surface_credentials SET subscription_account_id='new'; UPDATE organization_surface_credential_defaults SET subscription_account_id='new'");
    f.failCleanup(failed);
    const response = await f.request("/admin/ui/subscriptions/old/logout",[["confirm","1"]],"application/json");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({account_id:"old",revoked:true,d1:"revoked",completion:failed?"partial":"complete",token_cleanup:failed?"failed":"cleared",...(failed?{recovery:"retry_cleanup"}:{})});
    expect(f.status()).toEqual({status:"revoked"});
    expect(f.cleanup).toEqual(["subscription:old"]);
  });

  it("requires confirmation and changes only future issuance defaults", async () => {
    const f = await fixture();
    const before = f.bindings();
    const beforeDefaults = f.defaults();
    for (const confirmation of [[], [["confirm", "0"]]] as [string, string][][]) {
      const response = await f.request("/admin/ui/credential-defaults/grok", [["credential_account_id", "new"], ...confirmation]);
      expect(response.status).toBe(400);
      expect(f.defaults()).toEqual(beforeDefaults);
      expect(f.bindings()).toEqual(before);
      expect(f.audits()).toHaveLength(0);
    }
    const result = await f.request("/admin/ui/credential-defaults/grok", [["credential_account_id", "new"], ["confirm", "1"]]);
    expect(result.status).toBe(200);
    const document = new JSDOM(await result.text()).window.document;
    expect(document.querySelector('[data-mutation-flash="credential_default"]')?.textContent).toContain("Grok 默认连接已更新");
    expect(document.body.textContent).toContain("现有密钥保持原绑定");
    expect(f.bindings()).toEqual(before);
    expect(f.defaults()).toEqual([{surface_grant: "surface:grok:production", subscription_account_id: "new"}, {surface_grant: "surface:xai:production", subscription_account_id: "old"}]);
    // Create through the real issuance boundary. The returned one-time token is never inspected or recorded.
    const issued = await issueMemberKey(f.env, actor, "member", {name: "Synthetic new mapping", surfaces: ["grok"]}, NOW, "fresh");
    expect(f.db.sqlite.prepare("SELECT subscription_account_id FROM api_key_surface_credentials WHERE api_key_id=?").get(issued.id)).toEqual({subscription_account_id: "new"});
    expect(f.bindings().filter(row => row.api_key_id !== "fresh")).toEqual(before);
    const replacement = await replaceMemberKey(f.env, actor, "member", "keep", undefined, NOW, "replacement");
    expect(f.db.sqlite.prepare("SELECT subscription_account_id FROM api_key_surface_credentials WHERE api_key_id=? ORDER BY surface_grant").all(replacement.replacement.id)).toEqual([{subscription_account_id:"old"},{subscription_account_id:"old"}]);
    expect(replacement.old_key_remains_active).toBe(true);
    expect(f.bindings().filter(row => ["move","keep"].includes(String(row.api_key_id)))).toEqual(before);
  });

  it("migrates explicit selections, then reports partial disconnect and explicit cleanup without restoring metadata", async () => {
    const f = await fixture();
    const before = f.bindings();
    const migrate = [["replacement_account_id", "new"], ["key_ids[]", "move"], ["default_surfaces[]", "grok"]] as [string, string][];
    expect((await f.request("/admin/ui/subscriptions/old/migrate", migrate)).status).toBe(400);
    expect(f.bindings()).toEqual(before); expect(f.status()).toEqual({status: "active"}); expect(f.audits()).toHaveLength(0);
    const migrated = await f.request("/admin/ui/subscriptions/old/migrate", [...migrate, ["confirm", "1"]]);
    expect(migrated.status).toBe(200);
    const document = new JSDOM(await migrated.text()).window.document;
    expect(document.querySelector('[data-mutation-flash="credential_migrated"]')?.textContent).toContain("2 项密钥绑定、1 项默认连接已迁移");
    expect(f.status()).toEqual({status: "retiring"}); expect(f.cleanup).toEqual([]);
    expect(f.bindings().filter(row => row.api_key_id === "keep")).toEqual(before.filter(row => row.api_key_id === "keep"));
    expect(f.bindings().filter(row => row.api_key_id === "move").every(row => row.subscription_account_id === "new")).toBe(true);
    expect(f.defaults()).toEqual([{surface_grant: "surface:grok:production", subscription_account_id: "new"}, {surface_grant: "surface:xai:production", subscription_account_id: "old"}]);
    expect((await f.request("/admin/ui/subscriptions/old/logout", [["confirm", "1"]])).status).toBe(409);
    expect(f.status()).toEqual({status: "retiring"}); expect(f.cleanup).toEqual([]);
    expect((await f.request("/admin/ui/subscriptions/old/migrate", [["replacement_account_id", "new"], ["key_ids[]", "keep"], ["default_surfaces[]", "xai"], ["confirm", "1"]])).status).toBe(200);
    const moved = f.bindings(); const defaults = f.defaults();
    f.failCleanup(true);
    expect((await f.request("/admin/ui/subscriptions/old/logout", [])).status).toBe(400);
    expect(f.status()).toEqual({status: "retiring"}); expect(f.cleanup).toEqual([]);
    const disconnected = await f.request("/admin/ui/subscriptions/old/logout", [["confirm", "1"]]);
    expect(disconnected.status).toBe(200);
    const partial = new JSDOM(await disconnected.text()).window.document;
    expect(partial.querySelector('[data-mutation-flash="credential_disconnected"]')?.textContent).toContain("连接已断开，令牌清理未确认");
    expect(partial.querySelector('[data-action="credential-cleanup"]')?.getAttribute("action")).toBe("/admin/ui/subscriptions/old/cleanup");
    expect(f.status()).toEqual({status: "revoked"}); expect(f.cleanup).toEqual(["subscription:old"]);
    const beforeCleanup = f.audits();
    expect((await f.request("/admin/ui/subscriptions/old/cleanup", [])).status).toBe(400);
    expect(f.audits()).toEqual(beforeCleanup); expect(f.cleanup).toHaveLength(1);
    f.failCleanup(false);
    const completed = await f.request("/admin/ui/subscriptions/old/cleanup", [["confirm", "1"]]);
    expect(completed.status).toBe(200);
    expect(new JSDOM(await completed.text()).window.document.querySelector('[data-mutation-flash="credential_cleanup"]')?.textContent).toContain("令牌清理已确认");
    expect(f.status()).toEqual({status: "revoked"}); expect(f.bindings()).toEqual(moved); expect(f.defaults()).toEqual(defaults);
    expect(f.audits().filter(row => row.action === "credential.cleanup_retry")).toHaveLength(1);
  });

  it("preserves the confirmed default result when the later dashboard read fails and recovers with GET", async () => {
    const f = await fixture();
    const log = vi.spyOn(console, "error").mockImplementation(() => {}); onTestFinished(() => log.mockRestore());
    f.failRead(true);
    const result = await f.request("/admin/ui/credential-defaults/grok", [["credential_account_id", "new"], ["confirm", "1"]]);
    expect(result.status).toBe(503);
    const document = new JSDOM(await result.text()).window.document;
    expect(document.querySelector('[data-mutation-flash="credential_default"]')?.textContent).toContain("默认连接已更新");
    expect(document.body.textContent).toContain("控制台暂时打不开");
    const read = document.querySelector<HTMLAnchorElement>('[data-mutation-flash="credential_default"] a')!;
    expect(read.getAttribute("href")).toMatch(/^\/admin\?view=credentials/);
    expect(document.querySelector('form[method="post"]')).toBeNull();
    expect(f.defaults().find(row => row.surface_grant === "surface:grok:production")?.subscription_account_id).toBe("new");
    const committed = f.audits();
    expect(committed.filter(row => row.action === "credential_default.set")).toHaveLength(1);
    f.failRead(false);
    expect((await f.request(read.getAttribute("href")!)).status).toBe(200);
    expect(f.audits()).toEqual(committed);
  });

  it("runs the Codex UI migration, disconnect and cleanup boundary without changing Grok selections", async () => {
    const f = await fixture();
    const log = vi.spyOn(console, "error").mockImplementation(() => {}); onTestFinished(() => log.mockRestore());
    const grokBindings = f.bindings(); const grokDefaults = f.defaults();
    for (const id of ["codex-old", "codex-new"]) f.db.sqlite.prepare(`INSERT INTO codex_auths
      (id,kind,label,environment,status,expires_at,created_at,updated_at) VALUES (?,'shared',?,'production','active','2026-09-01T00:00:00.000Z',?,?)`).run(id,id,NOW.toISOString(),NOW.toISOString());
    f.db.sqlite.prepare(`INSERT INTO api_keys (id,user_id,key_prefix,key_hash,status,scopes,created_at)
      VALUES ('codex-key','member','display_codex','invalid-display-only-hash','active','["surface:codex:production"]',?)`).run(NOW.toISOString());
    f.db.sqlite.prepare(`INSERT INTO api_key_surface_credentials
      (api_key_id,surface_grant,codex_auth_id,created_at,updated_at) VALUES ('codex-key','surface:codex:production','codex-old',?,?)`).run(NOW.toISOString(),NOW.toISOString());
    f.db.sqlite.prepare(`INSERT INTO organization_surface_credential_defaults
      (surface_grant,codex_auth_id,created_at,updated_at) VALUES ('surface:codex:production','codex-old',?,?)`).run(NOW.toISOString(),NOW.toISOString());
    const fields: [string,string][] = [["replacement_account_id","codex-new"],["key_ids[]","codex-key"],["default_surfaces[]","codex"]];
    expect((await f.request("/admin/ui/codex-auths/codex-old/migrate",fields)).status).toBe(400);
    expect(f.audits()).toHaveLength(0);
    const migrated = await f.request("/admin/ui/codex-auths/codex-old/migrate",[...fields,["confirm","1"]]);
    expect(migrated.status).toBe(200);
    expect(new JSDOM(await migrated.text()).window.document.querySelector('[data-mutation-flash="credential_migrated"]')?.textContent).toContain("1 项密钥绑定、1 项默认连接已迁移");
    expect(f.db.sqlite.prepare("SELECT codex_auth_id FROM api_key_surface_credentials WHERE api_key_id='codex-key'").get()).toEqual({codex_auth_id:"codex-new"});
    expect(f.db.sqlite.prepare("SELECT codex_auth_id FROM organization_surface_credential_defaults WHERE surface_grant='surface:codex:production'").get()).toEqual({codex_auth_id:"codex-new"});
    expect(f.db.sqlite.prepare("SELECT status FROM codex_auths WHERE id='codex-old'").get()).toEqual({status:"retiring"});
    expect(f.cleanup).toEqual([]);
    f.failCleanup(true);
    const disconnected = await f.request("/admin/ui/codex-auths/codex-old/logout",[["confirm","1"]]);
    expect(disconnected.status).toBe(200);
    expect(new JSDOM(await disconnected.text()).window.document.querySelector('[data-mutation-flash="credential_disconnected"]')?.textContent).toContain("连接已断开，令牌清理未确认");
    expect(f.db.sqlite.prepare("SELECT status FROM codex_auths WHERE id='codex-old'").get()).toEqual({status:"revoked"});
    expect(f.cleanup).toEqual(["codex-old"]);
    f.failCleanup(false);
    const cleaned = await f.request("/admin/ui/codex-auths/codex-old/cleanup",[["confirm","1"]]);
    expect(cleaned.status).toBe(200);
    expect(new JSDOM(await cleaned.text()).window.document.querySelector('[data-mutation-flash="credential_cleanup"]')?.textContent).toContain("令牌清理已确认");
    expect(f.db.sqlite.prepare("SELECT status FROM codex_auths WHERE id='codex-old'").get()).toEqual({status:"revoked"});
    expect(f.bindings().filter(row=>row.api_key_id!=="codex-key")).toEqual(grokBindings);
    expect(f.defaults().filter(row=>row.surface_grant!=="surface:codex:production")).toEqual(grokDefaults);
  });
});
