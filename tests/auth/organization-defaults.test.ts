import { describe, expect, it, onTestFinished } from "vitest";
import { commitOrganizationCreditDefaults, type CreditAuditActor, type OrganizationCreditDefaultChange } from "../../src/auth/credits";
import { createTestD1 } from "../support/sqlite-d1";

const NOW = new Date("2026-10-05T00:00:00Z");
const ACTOR: CreditAuditActor = { kind:"admin_secret",email:null,subject:null,userId:null,role:null,requestId:"quota-save" };
const CHANGES: readonly OrganizationCreditDefaultChange[] = ["codex", "grok", "xai"].map((surface, index) => ({
  surface_grant:`surface:${surface}:production` as OrganizationCreditDefaultChange["surface_grant"],
  expected_monthly_allowance:0,monthly_allowance:10 + index
}));

function fixture(options: Parameters<typeof createTestD1>[0] = {}) {
  const db = createTestD1(options);
  onTestFinished(() => db.close());
  const env = { DB:db.binding, CONSOLE_EMAIL_DOMAIN:"example.test" } as Env;
  const defaults = () => db.sqlite.prepare("SELECT surface_grant, monthly_allowance FROM organization_surface_credit_defaults ORDER BY surface_grant").all();
  const audits = () => db.sqlite.prepare("SELECT target_id, meta FROM operator_mutation_audit WHERE action = 'credit_default.set' ORDER BY target_id").all();
  return { ...db, env, defaults, audits };
}

describe("one organization-default commit", () => {
  it("changes all defaults and records each prior value without changing personal policy or use", async () => {
    const db = fixture();
    db.sqlite.exec(`INSERT INTO users (id, email, status, created_at, updated_at) VALUES ('member', 'member@example.test', 'active', 't', 't');
      INSERT INTO user_surface_credit_policies (user_id, surface_grant, monthly_allowance, created_at, updated_at) VALUES ('member', 'surface:codex:production', 7, 't', 't');
      INSERT INTO user_surface_credit_usage (user_id, surface_grant, period_start, consumed_credits, admitted_attempts, last_seen_at) VALUES ('member', 'surface:codex:production', '2026-10-01', 3, 3, 't');`);
    const policies = db.sqlite.prepare("SELECT * FROM user_surface_credit_policies").all();
    const usage = db.sqlite.prepare("SELECT * FROM user_surface_credit_usage").all();
    const result = await commitOrganizationCreditDefaults(db.env, ACTOR, CHANGES, NOW);
    expect(db.defaults()).toEqual(CHANGES.map(({surface_grant,monthly_allowance}) => ({surface_grant,monthly_allowance})));
    expect(result[2]?.shared_provider_authority).toContain("does not isolate");
    expect(db.audits()).toEqual(CHANGES.map(row => ({target_id:row.surface_grant,meta:JSON.stringify({surface_grant:row.surface_grant,previous_monthly_allowance:0,monthly_allowance:row.monthly_allowance})})));
    expect(db.sqlite.prepare("SELECT * FROM user_surface_credit_policies").all()).toEqual(policies);
    expect(db.sqlite.prepare("SELECT * FROM user_surface_credit_usage").all()).toEqual(usage);
  });

  it("rejects one stale value without updating the other services or recording success", async () => {
    const db = fixture();
    db.sqlite.exec("UPDATE organization_surface_credit_defaults SET monthly_allowance = 99 WHERE surface_grant = 'surface:grok:production'");
    const before = db.defaults();
    await expect(commitOrganizationCreditDefaults(db.env, ACTOR, CHANGES, NOW)).rejects.toMatchObject({status:409,code:"credit_defaults_changed"});
    expect(db.defaults()).toEqual(before);
    expect(db.audits()).toEqual([]);
  });

  it("rejects a missing service without leaving a partial save", async () => {
    const db = fixture();
    db.sqlite.exec("DELETE FROM organization_surface_credit_defaults WHERE surface_grant = 'surface:xai:production'");
    const before = db.defaults();
    await expect(commitOrganizationCreditDefaults(db.env, ACTOR, CHANGES, NOW)).rejects.toMatchObject({status:409});
    expect(db.defaults()).toEqual(before);
    expect(db.audits()).toEqual([]);
  });

  it("rolls back every default if the audit insert fails", async () => {
    const db = fixture();
    db.sqlite.exec("CREATE TRIGGER reject_quota_audit BEFORE INSERT ON operator_mutation_audit BEGIN SELECT RAISE(ABORT, 'synthetic audit failure'); END");
    const before = db.defaults();
    await expect(commitOrganizationCreditDefaults(db.env, ACTOR, CHANGES, NOW)).rejects.toThrow("synthetic audit failure");
    expect(db.defaults()).toEqual(before);
    expect(db.audits()).toEqual([]);
  });

  it.each(["role", "status", "epoch"])("rejects %s revocation at the SQL commit boundary", async boundary => {
    let revoke = () => {};
    const db = fixture({onBatch:() => revoke()});
    db.sqlite.exec("INSERT INTO users (id, email, canonical_email, role, status, account_kind, login_capable, created_at, updated_at) VALUES ('admin', 'admin@example.test', 'admin@example.test', 'admin', 'active', 'human', 1, 't', 't')");
    const actor: CreditAuditActor = {...ACTOR,kind:"access",userId:"admin",email:"admin@example.test",role:"admin",sessionEpoch:0};
    revoke = () => db.sqlite.exec(`UPDATE users SET ${boundary === "role" ? "role = 'user'" : boundary === "status" ? "status = 'disabled'" : "console_session_epoch = 1"} WHERE id = 'admin'`);
    const before = db.defaults();
    await expect(commitOrganizationCreditDefaults(db.env, actor, CHANGES, NOW)).rejects.toMatchObject({status:403,code:"admin_required"});
    expect(db.defaults()).toEqual(before);
    expect(db.audits()).toEqual([]);
  });

  it.each([-1, 1.5, Number.MAX_SAFE_INTEGER + 1])("rejects invalid allowance %s before a write", async monthly_allowance => {
    const db = fixture();
    const before = db.defaults();
    await expect(commitOrganizationCreditDefaults(db.env, ACTOR, [{...CHANGES[0]!,monthly_allowance}], NOW)).rejects.toMatchObject({status:400});
    expect(db.defaults()).toEqual(before);
    expect(db.audits()).toEqual([]);
  });
});
