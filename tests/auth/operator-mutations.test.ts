import type { DatabaseSync } from "node:sqlite";
import { describe, expect, it, onTestFinished } from "vitest";
import {
  createUser,
  issueApiKey,
  issueReplacementApiKey,
  removeSurfaceCreditPolicy,
  revokeApiKey,
  setSurfaceCreditPolicy,
  type OperatorMutationContext
} from "../../src/admin/operator-mutations";
import { createTestD1 } from "../support/sqlite-d1";

const NOW = new Date("2026-08-10T12:00:00.000Z");

describe("Operator Mutation contracts", () => {
  it("rejects missing resources before writes or audit", async () => {
    const { ctx, sqlite } = fixture();

    await expect(issueApiKey(ctx, {
      user_id: "missing",
      name: "Missing",
      scopes: ["surface:grok:production"]
    })).rejects.toMatchObject({ status: 404, code: "user_not_found" });
    await expect(revokeApiKey(ctx, "missing")).rejects.toMatchObject({
      status: 404,
      code: "key_not_found"
    });
    await expect(setSurfaceCreditPolicy(ctx, {
      user_id: "missing",
      surface: "grok",
      monthly_allowance: 10
    })).rejects.toMatchObject({ status: 404, code: "user_not_found" });
    await expect(removeSurfaceCreditPolicy(ctx, {
      user_id: "missing",
      surface: "grok"
    })).rejects.toMatchObject({ status: 404, code: "user_not_found" });

    expect(sqlite.prepare("SELECT count(*) AS count FROM operator_mutation_audit").get())
      .toEqual({ count: 0 });
  });

  it.each([false, true])("reports operator source liveness accurately without blocking renewal (expired=%s)", async expired => {
    const {ctx, sqlite}=fixture();
    const user=await createUser(ctx,{id:"operator-source",email:"source@example.test"});
    const issued=await issueApiKey(ctx,{user_id:user.id,name:"Work",scopes:["surface:codex:production"],credential_bindings:[{surface_grant:"surface:codex:production",credential_account_id:"auth_test"}]});
    if(expired)sqlite.prepare("UPDATE api_keys SET expires_at=? WHERE id=?").run("2020-01-01T00:00:00Z",issued.id);
    const result=await issueReplacementApiKey(ctx,issued.id,"2026-09-09T12:00:00.000Z");
    expect(result.replacement.expires_at).toBe("2026-09-09T12:00:00.000Z");
    expect(result.old_key_remains_active).toBe(!expired);
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM api_keys").get()).toEqual({count:2});
    expect(sqlite.prepare("SELECT status,expires_at FROM api_keys WHERE id=?").get(issued.id)).toEqual({status:"active",expires_at:expired?"2020-01-01T00:00:00Z":issued.expires_at});
  });

  it("audits each committed key change once and keeps key material out of audit", async () => {
    const { ctx, sqlite } = fixture();
    const user = await createUser(ctx, { id: "operator-user", email: "user@example.test" });
    const issued = await issueApiKey(ctx, {
      user_id: user.id,
      name: "Operator key",
      scopes: ["surface:codex:production", "surface:grok:production"],
      credential_bindings: [
        { surface_grant: "surface:codex:production", credential_account_id: "auth_test" },
        { surface_grant: "surface:grok:production", credential_account_id: "sub_test" }
      ]
    });

    const first = await revokeApiKey(ctx, issued.id);
    const second = await revokeApiKey(ctx, issued.id);
    expect(first.already_revoked).toBe(false);
    expect(second.already_revoked).toBe(true);

    const audits = sqlite.prepare(
      "SELECT action, result, meta FROM operator_mutation_audit ORDER BY created_at, rowid"
    ).all() as Array<{ action: string; result: string; meta: string | null }>;
    expect(audits.map((row) => row.action)).toEqual([
      "user.create",
      "key.create",
      "key.revoke"
    ]);
    expect(audits.every((row) => row.result === "ok")).toBe(true);
    const auditJson = JSON.stringify(audits);
    expect(auditJson).not.toContain(issued.token);
    expect(auditJson).not.toContain("test-pepper");
    expect(auditJson).not.toMatch(/key_hash|access_token|refresh_token|admin_secret/i);
    expect(sqlite.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'control_plane_audit'"
    ).get()).toBeUndefined();
  });
});

function fixture(): { ctx: OperatorMutationContext; sqlite: DatabaseSync } {
  const testDb = createTestD1();
  onTestFinished(() => testDb.close());
  const { sqlite } = testDb;
  sqlite.prepare("UPDATE organization_surface_credit_defaults SET monthly_allowance = 1000000").run();
  sqlite.prepare(
    `INSERT INTO codex_auths
       (id, kind, label, environment, status, created_at, updated_at)
     VALUES ('auth_test', 'shared', 'ChatGPT test', 'production', 'active', ?, ?)`
  ).run(NOW.toISOString(), NOW.toISOString());
  sqlite.prepare(
    `INSERT INTO subscription_accounts
       (id, capability_source, environment, label, status, refresh_available, created_at, updated_at)
     VALUES ('sub_test', 'grok', 'production', 'Grok test', 'active', 1, ?, ?)`
  ).run(NOW.toISOString(), NOW.toISOString());
  const env = {
    DB: testDb.binding,
    API_KEY_HASH_PEPPER: "test-pepper"
  } as Env;
  return {
    sqlite,
    ctx: {
      env,
      deps: {
        fetch: async () => new Response(null, { status: 204 }),
        now: () => NOW
      },
      actor: { kind: "admin_secret", email: null, subject: null },
      requestId: "req_operator_test",
      now: NOW
    }
  };
}
