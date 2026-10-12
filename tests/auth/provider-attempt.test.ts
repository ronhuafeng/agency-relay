import type { DatabaseSync } from "node:sqlite";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { listExecutionPlans } from "../../src/plans/execution-plans";
import { admitProviderAttempt } from "../../src/auth/provider-attempt";
import { consumeSurfaceCredits, listSurfaceCreditStates } from "../../src/auth/credits";
import { createTestD1 } from "../support/sqlite-d1";

const STARTED_AT = new Date("2026-08-10T08:00:00.000Z");
const COMPLETED_AT = new Date("2026-08-10T08:00:02.000Z");

describe("Provider Attempt gate", () => {
  it("attributes Credit at admission and terminal usage at request start across a UTC month", async () => {
    const { env, sqlite } = fixture();
    const attempt = await admitProviderAttempt({ env, ctx: { waitUntil() {} }, now: () => COMPLETED_AT,
      requestContext: { requestId: "month_boundary", startedAt: Date.parse("2026-07-31T23:59:59.000Z") },
      auth: { user: { id: "user_provider_attempt" }, apiKey: { id: "key_provider_attempt" } } as never,
      plan: listExecutionPlans().find(({ id }) => id === "grok.production.responses")! });
    await attempt.complete(OK);
    expect(sqlite.prepare("SELECT period_start, admitted_at FROM credit_admissions").get())
      .toEqual({ period_start: "2026-08-01", admitted_at: COMPLETED_AT.toISOString() });
    expect(sqlite.prepare("SELECT day, requests FROM usage_daily").get()).toEqual({ day: "2026-07-31", requests: 1 });
  });

  it("rolls back the debit and opening capture if its admission fact cannot commit", async () => {
    const { env, sqlite } = fixture();
    sqlite.exec(`
      INSERT INTO user_surface_credit_usage VALUES
        ('user_provider_attempt', 'surface:grok:production', '2026-08-01', 1, 1, '2026-08-01', NULL);
      CREATE TRIGGER reject_admission BEFORE INSERT ON credit_admissions
      BEGIN SELECT RAISE(ABORT, 'synthetic_fact_failure'); END;
    `);
    await expect(admit(env)).rejects.toThrow("synthetic_fact_failure");
    expect(sqlite.prepare("SELECT consumed_credits, opening_credits FROM user_surface_credit_usage").get())
      .toEqual({ consumed_credits: 1, opening_credits: null });
    expect(sqlite.prepare("SELECT count(*) AS count FROM credit_admissions").get()).toEqual({ count: 0 });
  });

  it("retains an unconfirmed charge if terminal accounting rolls back, without hiding the gap", async () => {
    const { env, sqlite } = fixture();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    onTestFinished(() => errorSpy.mockRestore());
    const attempt = await admit(env);
    sqlite.exec(`CREATE TRIGGER reject_usage BEFORE INSERT ON usage_daily
      BEGIN SELECT RAISE(ABORT, 'synthetic_usage_failure'); END;`);
    expect(await attempt.complete(OK)).toMatchObject({ accountingCommitted: false });
    expect(sqlite.prepare("SELECT count(*) AS count FROM request_audit").get()).toEqual({ count: 0 });
    expect((await listSurfaceCreditStates(env, COMPLETED_AT, "user_provider_attempt"))[1]?.reconciliation)
      .toMatchObject({ recorded_admission_credits: 1, terminal_confirmed_credits: 0, terminal_unconfirmed_credits: 1, balance_difference: 0 });
    expect(errorSpy).toHaveBeenCalledWith('{"event":"request_accounting_failed","plan_id":"grok.production.responses"}');
  });

  it("keeps confirmation after audit retention and rejects a mismatched terminal identity", async () => {
    const { env, sqlite } = fixture();
    const attempt = await admit(env);
    expect(() => sqlite.exec("UPDATE credit_admissions SET terminal_confirmed = 1"))
      .toThrow("credit_terminal_witness_missing");
    expect(await attempt.complete(OK)).toMatchObject({ accountingCommitted: true });
    sqlite.exec("DELETE FROM request_audit");
    expect(sqlite.prepare("SELECT terminal_confirmed FROM credit_admissions").get()).toEqual({ terminal_confirmed: 1 });
    expect(() => sqlite.exec("UPDATE credit_admissions SET terminal_confirmed = 0"))
      .toThrow("credit_admission_immutable");
    expect(() => sqlite.exec(`INSERT INTO request_audit (id, route_profile_id, user_id, status, created_at)
      SELECT attempt_id, 'wrong_plan', user_id, 'ok', admitted_at FROM credit_admissions`))
      .toThrow("credit_terminal_identity_mismatch");
  });

  it("gives repeated caller Request IDs independent admission identities", async () => {
    const { env, sqlite } = fixture();
    const first = await admit(env);
    const second = await admit(env);
    await first.complete(OK);
    await second.complete(OK);
    expect(sqlite.prepare("SELECT count(DISTINCT attempt_id) AS count FROM credit_admissions").get())
      .toEqual({ count: 2 });
    expect(sqlite.prepare("SELECT count(DISTINCT request_id) AS count FROM request_audit").get())
      .toEqual({ count: 1 });
    await expect(admit(env)).rejects.toMatchObject({ code: "surface_credit_exhausted" });
    expect(sqlite.prepare("SELECT count(*) AS count FROM credit_admissions").get()).toEqual({ count: 2 });
  });

  it("rejects a duplicate admission identity without committing a second debit", async () => {
    const { env, sqlite } = fixture();
    const input = { user_id: "user_provider_attempt", key_id: "key_provider_attempt",
      surface_grant: "surface:grok:production" as const, plan_id: "grok.production.responses",
      credit_charge: 1, attempt_id: "same_attempt" };
    await consumeSurfaceCredits(env, input, STARTED_AT);
    await expect(consumeSurfaceCredits(env, input, STARTED_AT)).rejects.toThrow();
    expect(sqlite.prepare("SELECT consumed_credits FROM user_surface_credit_usage").get()).toEqual({ consumed_credits: 1 });
    expect(sqlite.prepare("SELECT count(*) AS count FROM credit_admissions").get()).toEqual({ count: 1 });
  });

  it("reports request-local admission phase timings without durable fields", async () => {
    const { env } = fixture();
    const plan = listExecutionPlans().find(({ id }) => id === "grok.production.responses")!;
    const ticks = [100, 350, 500].map((offset) => new Date(STARTED_AT.getTime() + offset));

    const attempt = await admitProviderAttempt({
      env,
      ctx: { waitUntil() {} },
      now: () => ticks.shift()!,
      requestContext: {
        requestId: "request_timing",
        startedAt: STARTED_AT.getTime(),
        authCompletedAt: STARTED_AT.getTime() + 75
      },
      auth: {
        user: { id: "user_provider_attempt" },
        apiKey: { id: "key_provider_attempt" }
      } as never,
      plan
    });

    expect(attempt.timing).toEqual({
      auth_ms: 75,
      credential_slot_ms: 250,
      credit_admission_ms: 150,
      request_to_admission_ms: 500
    });
  });

  it("admits one charge and commits one terminal audit and Responses aggregate", async () => {
    const { env, sqlite } = fixture();
    const waits: Promise<unknown>[] = [];
    const plan = listExecutionPlans().find(({ id }) => id === "grok.production.responses");
    expect(plan).toBeDefined();
    const attempt = await admitProviderAttempt({
      env,
      ctx: { waitUntil: (promise) => waits.push(promise) },
      now: () => COMPLETED_AT,
      requestContext: {
        requestId: "request_provider_attempt",
        startedAt: STARTED_AT.getTime(),
        sessionId: "session_provider_attempt",
        threadId: "thread_provider_attempt"
      },
      auth: {
        user: { id: "user_provider_attempt" },
        apiKey: { id: "key_provider_attempt" }
      } as never,
      plan: plan!
    });
    expect(attempt.credential).toEqual({
      accessToken: "grok-access-token",
      physicalAccountId: "grok_production"
    });
    expect(sqlite.prepare(`
      SELECT consumed_credits, admitted_attempts
      FROM user_surface_credit_usage
    `).get()).toEqual({ consumed_credits: 1, admitted_attempts: 1 });
    const readCredit = async () => (await listSurfaceCreditStates(env, COMPLETED_AT, "user_provider_attempt"))
      .find(({ surface_grant }) => surface_grant === plan!.surfaceGrant)!.reconciliation;
    expect(await readCredit()).toEqual({
      opening_credits: 0,
      opening_balance_captured: true,
      recorded_admission_credits: 1,
      terminal_confirmed_credits: 0,
      terminal_unconfirmed_credits: 1,
      balance_difference: 0,
      charged_admissions: 1,
      terminal_confirmed_admissions: 0
    });
    const outcome = {
      requestStatus: "error" as const,
      providerResult: "accepted" as const,
      upstreamStatus: 200,
      errorCode: "mini_postprocess_failed",
      usage: {
        response_id: "response_provider_attempt",
        model: "grok-4.5",
        usage: {
          input_tokens: 10,
          cached_input_tokens: 4,
          output_tokens: 6,
          reasoning_tokens: 2,
          total_tokens: 16,
          provider_cost_usd_ticks: 42
        }
      }
    };

    const first = attempt.complete(outcome);
    const duplicate = attempt.complete(outcome);
    expect(duplicate).toBe(first);
    expect(waits).toHaveLength(1);
    await Promise.all(waits);

    expect(await readCredit()).toMatchObject({
      terminal_confirmed_credits: 1,
      terminal_unconfirmed_credits: 0,
      terminal_confirmed_admissions: 1,
      balance_difference: 0
    });
    expect(sqlite.prepare(`
      SELECT count(*) AS count FROM credit_admissions AS admission
      JOIN request_audit AS audit ON audit.id = admission.attempt_id
      WHERE admission.user_id = audit.user_id AND admission.key_id = audit.key_id
        AND admission.plan_id = audit.route_profile_id
    `).get()).toEqual({ count: 1 });

    expect(sqlite.prepare(`
      SELECT route_profile_id, status, upstream_status, error_code, response_model,
             response_id, input_tokens, cached_input_tokens, output_tokens,
             reasoning_tokens, total_tokens, provider_cost_usd_ticks
      FROM request_audit
    `).get()).toEqual({
      route_profile_id: "grok.production.responses",
      status: "error",
      upstream_status: 200,
      error_code: "mini_postprocess_failed",
      response_model: "grok-4.5",
      response_id: "response_provider_attempt",
      input_tokens: 10,
      cached_input_tokens: 4,
      output_tokens: 6,
      reasoning_tokens: 2,
      total_tokens: 16,
      provider_cost_usd_ticks: 42
    });
    expect(sqlite.prepare(`
      SELECT requests, ok_requests, error_requests, total_tokens,
             token_measurements, provider_cost_usd_ticks, cost_measurements
      FROM usage_daily
    `).get()).toEqual({
      requests: 1,
      ok_requests: 0,
      error_requests: 1,
      total_tokens: 16,
      token_measurements: 1,
      provider_cost_usd_ticks: 42,
      cost_measurements: 1
    });
    expect(sqlite.prepare(`
      SELECT last_success_at, last_failure_at
      FROM subscription_accounts WHERE id = 'grok_production'
    `).get()).toEqual({
      last_success_at: COMPLETED_AT.toISOString(),
      last_failure_at: null
    });
  });

  it("keeps a conflicting second terminal outcome from double counting", async () => {
    const { env, sqlite } = fixture();
    const waits: Promise<unknown>[] = [];
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const plan = listExecutionPlans().find(({ id }) => id === "grok.production.models")!;
    const attempt = await admitProviderAttempt({
      env,
      ctx: { waitUntil: (promise) => waits.push(promise) },
      now: () => COMPLETED_AT,
      requestContext: { requestId: "request_conflict", startedAt: STARTED_AT.getTime() },
      auth: {
        user: { id: "user_provider_attempt" },
        apiKey: { id: "key_provider_attempt" }
      } as never,
      plan
    });

    try {
      attempt.complete({
        requestStatus: "error",
        providerResult: "rejected",
        upstreamStatus: 503,
        errorCode: null
      });
      attempt.complete({
        requestStatus: "ok",
        providerResult: "accepted",
        upstreamStatus: 200,
        errorCode: null
      });
      await Promise.all(waits);

      expect(sqlite.prepare("SELECT count(*) AS count FROM request_audit").get())
        .toEqual({ count: 1 });
      expect(sqlite.prepare("SELECT count(*) AS count FROM usage_daily").get())
        .toEqual({ count: 0 });
      expect(sqlite.prepare(`
        SELECT last_success_at, last_failure_at
        FROM subscription_accounts WHERE id = 'grok_production'
      `).get()).toEqual({
        last_success_at: null,
        last_failure_at: COMPLETED_AT.toISOString()
      });
      expect(errorSpy).toHaveBeenCalledWith(
        '{"event":"provider_attempt_conflict","plan_id":"grok.production.models"}'
      );
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("does not consume Credit when Credential Slot resolution fails", async () => {
    const { env, sqlite } = fixture({ credentialFailure: true });
    const plan = listExecutionPlans().find(({ id }) => id === "grok.production.responses")!;

    await expect(admitProviderAttempt({
      env,
      ctx: { waitUntil() {} },
      now: () => COMPLETED_AT,
      requestContext: { requestId: "request_credential_failure", startedAt: STARTED_AT.getTime() },
      auth: {
        user: { id: "user_provider_attempt" },
        apiKey: { id: "key_provider_attempt" }
      } as never,
      plan
    })).rejects.toThrow("credential unavailable");

    expect(sqlite.prepare("SELECT count(*) AS count FROM user_surface_credit_usage").get())
      .toEqual({ count: 0 });
    expect(sqlite.prepare("SELECT count(*) AS count FROM request_audit").get())
      .toEqual({ count: 0 });
  });

  it("fails closed before Credit when the key has no binding for the Surface", async () => {
    const { env, sqlite } = fixture({ omitBinding: true });
    const plan = listExecutionPlans().find(({ id }) => id === "grok.production.responses")!;

    await expect(admitProviderAttempt({
      env,
      ctx: { waitUntil() {} },
      now: () => COMPLETED_AT,
      requestContext: { requestId: "request_missing_binding", startedAt: STARTED_AT.getTime() },
      auth: {
        user: { id: "user_provider_attempt" },
        apiKey: { id: "key_provider_attempt" }
      } as never,
      plan
    })).rejects.toMatchObject({ code: "missing_credential_binding", status: 503 });

    expect(sqlite.prepare("SELECT count(*) AS count FROM user_surface_credit_usage").get())
      .toEqual({ count: 0 });
  });

  it("rejects exhausted Credit before creating a Provider Attempt", async () => {
    const { env, sqlite } = fixture({ allowance: 0 });
    const plan = listExecutionPlans().find(({ id }) => id === "grok.production.responses")!;

    await expect(admitProviderAttempt({
      env,
      ctx: { waitUntil() {} },
      now: () => COMPLETED_AT,
      requestContext: { requestId: "request_credit_exhausted", startedAt: STARTED_AT.getTime() },
      auth: {
        user: { id: "user_provider_attempt" },
        apiKey: { id: "key_provider_attempt" }
      } as never,
      plan
    })).rejects.toMatchObject({ code: "surface_disabled", status: 403 });

    expect(sqlite.prepare("SELECT count(*) AS count FROM user_surface_credit_usage").get())
      .toEqual({ count: 0 });
    expect(sqlite.prepare("SELECT count(*) AS count FROM request_audit").get())
      .toEqual({ count: 0 });
  });
});

const OK = { requestStatus: "ok" as const, providerResult: "accepted" as const, upstreamStatus: 200, errorCode: null };
function admit(env: Env) {
  return admitProviderAttempt({ env, ctx: { waitUntil() {} }, now: () => COMPLETED_AT,
    requestContext: { requestId: "repeatable_caller_id", startedAt: STARTED_AT.getTime() },
    auth: { user: { id: "user_provider_attempt" }, apiKey: { id: "key_provider_attempt" } } as never,
    plan: listExecutionPlans().find(({ id }) => id === "grok.production.responses")! });
}

function fixture(options: {
  allowance?: number;
  credentialFailure?: boolean;
  omitBinding?: boolean;
} = {}): { env: Env; sqlite: DatabaseSync } {
  const testDb = createTestD1();
  onTestFinished(() => testDb.close());
  const { sqlite } = testDb;
  sqlite.prepare(
    `INSERT INTO users (id, email, status, created_at, updated_at)
     VALUES (?, ?, 'active', ?, ?)`
  ).run(
    "user_provider_attempt",
    "provider-attempt@example.test",
    STARTED_AT.toISOString(),
    STARTED_AT.toISOString()
  );
  sqlite.prepare(
    `INSERT INTO subscription_accounts
     (id, capability_source, environment, label, status, refresh_available, created_at, updated_at)
     VALUES (?, 'grok', 'production', 'Grok', 'active', 1, ?, ?)`
  ).run("grok_production", STARTED_AT.toISOString(), STARTED_AT.toISOString());
  sqlite.prepare(
    `INSERT INTO api_keys
       (id, user_id, key_prefix, key_hash, status, scopes, expires_at,
        last_used_at, created_at, revoked_at)
     VALUES (?, ?, ?, ?, 'active', ?, NULL, NULL, ?, NULL)`
  ).run(
    "key_provider_attempt",
    "user_provider_attempt",
    "cfwd_test_provider",
    "hash",
    '["surface:grok:production"]',
    STARTED_AT.toISOString()
  );
  if (!options.omitBinding) {
    sqlite.prepare(
    `INSERT INTO api_key_surface_credentials
       (api_key_id, surface_grant, codex_auth_id, subscription_account_id,
        created_at, updated_at)
     VALUES (?, 'surface:grok:production', NULL, ?, ?, ?)`
    ).run(
      "key_provider_attempt",
      "grok_production",
      STARTED_AT.toISOString(),
      STARTED_AT.toISOString()
    );
  }
  sqlite.prepare(
    `INSERT INTO user_surface_credit_policies
       (user_id, surface_grant, monthly_allowance, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)`
  ).run(
    "user_provider_attempt",
    "surface:grok:production",
    options.allowance ?? 2,
    STARTED_AT.toISOString(),
    STARTED_AT.toISOString()
  );
  return {
    sqlite,
    env: {
      DB: testDb.binding,
      TOKEN_AUTHORITY: {
        idFromName: (name: string) => ({ toString: () => name }),
        get: () => ({
          getFreshSubscriptionCredential: async () => {
            if (options.credentialFailure) {
              throw new Error("credential unavailable");
            }
            return { ok: true as const, value: { access_token: "grok-access-token" } };
          }
        })
      }
    } as unknown as Env
  };
}
