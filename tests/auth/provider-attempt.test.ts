import type { DatabaseSync } from "node:sqlite";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { listExecutionPlans } from "../../src/plans/execution-plans";
import { admitProviderAttempt } from "../../src/auth/provider-attempt";
import { createTestD1 } from "../support/sqlite-d1";

const STARTED_AT = new Date("2026-08-10T08:00:00.000Z");
const COMPLETED_AT = new Date("2026-08-10T08:00:02.000Z");

describe("Provider Attempt gate", () => {
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
