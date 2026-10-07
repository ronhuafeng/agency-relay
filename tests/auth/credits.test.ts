import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { Worker } from "node:worker_threads";
import { describe, expect, it, onTestFinished } from "vitest";
import {
  assertIssuanceEntitlement,
  commitPersonalCreditPolicy,
  clearPersonalCreditPolicy,
  consumeSurfaceCredits,
  listSurfaceCreditStates,
  type CreditAuditActor
} from "../../src/auth/credits";
import { createTestD1 } from "../support/sqlite-d1";
import { admin, consoleCookie, createKey, createUser, makeFixture } from "../router/fixture";
import { handleRequest } from "../../src/router";

const NOW = new Date("2026-08-10T12:00:00.000Z");
const LATER = new Date("2026-08-10T12:05:00.000Z");
const GRANT = "surface:grok:production" as const;

describe("inherited surface allowances", () => {
  it("uses an explicit personal cap instead of the organization default", async () => {
    const { env, sqlite } = fixture();
    sqlite.prepare(
      "UPDATE organization_surface_credit_defaults SET monthly_allowance = 5 WHERE surface_grant = ?"
    ).run(GRANT);
    const inherited = await listSurfaceCreditStates(env, NOW, "sop-plus");
    expect(inherited.find((state) => state.surface_grant === GRANT)).toMatchObject({
      monthly_allowance: 5,
      source: "organization",
      consumed_credits: 0,
      remaining_credits: 5
    });
    await assign(env, { mode: "limited", monthly_allowance: 0 });
    const zero = await listSurfaceCreditStates(env, NOW, "sop-plus");
    expect(zero.find((state) => state.surface_grant === GRANT)).toMatchObject({
      monthly_allowance: 0,
      source: "personal",
      remaining_credits: 0
    });
    await expect(consume(env, NOW)).rejects.toMatchObject({ status: 403, code: "surface_disabled" });
    expect(sqlite.prepare("SELECT count(*) AS count FROM user_surface_credit_usage").get()).toEqual({ count: 0 });
    expect(zero.find((state) => state.surface_grant === "surface:codex:production")).toMatchObject({
      monthly_allowance: 0,
      source: "organization"
    });
  });

  it("keeps recorded use when the override is removed or the cap changes", async () => {
    const { env, sqlite } = fixture();
    sqlite.prepare(
      "UPDATE organization_surface_credit_defaults SET monthly_allowance = 4 WHERE surface_grant = ?"
    ).run(GRANT);
    await assign(env, { mode: "limited", monthly_allowance: 2 });
    await consume(env, NOW);
    await consume(env, LATER);
    expect((await clearPersonalCreditPolicy(env, ACTOR, { user_id: "sop-plus", surface_grant: GRANT, previous_monthly_allowance: 2 }, LATER)).deleted).toBe(true);
    const inherited = (await listSurfaceCreditStates(env, LATER, "sop-plus"))
      .find((state) => state.surface_grant === GRANT);
    expect(inherited).toMatchObject({
      source: "organization",
      monthly_allowance: 4,
      consumed_credits: 2,
      remaining_credits: 2,
      last_seen_at: LATER.toISOString()
    });
    await assign(env, { mode: "limited", monthly_allowance: 1 });
    const lowered = (await listSurfaceCreditStates(env, LATER, "sop-plus"))
      .find((state) => state.surface_grant === GRANT);
    expect(lowered).toMatchObject({ consumed_credits: 2, remaining_credits: 0 });
    await expect(consume(env, NOW)).rejects.toMatchObject({ code: "surface_credit_exhausted", status: 429 });
    expect(sqlite.prepare("SELECT consumed_credits FROM user_surface_credit_usage").get()).toEqual({ consumed_credits: 2 });
    const nextMonth = new Date("2026-09-02T00:00:00.000Z");
    await consume(env, nextMonth);
    const periods = sqlite.prepare("SELECT period_start, consumed_credits FROM user_surface_credit_usage ORDER BY period_start").all();
    expect(periods).toEqual([
      { period_start: "2026-08-01", consumed_credits: 2 },
      { period_start: "2026-09-01", consumed_credits: 1 }
    ]);
  });

  it("admits a zero-charge plan after exhaustion and rejects a disabled surface before dispatch", async () => {
    const { env, sqlite } = fixture();
    await assign(env, { mode: "limited", monthly_allowance: 1 });
    await consume(env, NOW);
    await consumeSurfaceCredits(env, {
      user_id: "sop-plus",
      surface_grant: GRANT,
      plan_id: "grok.production.models",
      credit_charge: 0
    }, LATER);
    expect(sqlite.prepare("SELECT consumed_credits FROM user_surface_credit_usage").get()).toEqual({ consumed_credits: 1 });
    await assign(env, { mode: "disabled", monthly_allowance: null });
    await expect(consumeSurfaceCredits(env, {
      user_id: "sop-plus",
      surface_grant: GRANT,
      plan_id: "grok.production.models",
      credit_charge: 0
    }, LATER)).rejects.toMatchObject({ code: "surface_disabled", status: 403 });
    const denied = await consume(env, LATER).catch((error: unknown) => error);
    expect(denied).toMatchObject({ code: "surface_disabled" });
    expect(denied instanceof Error ? denied.message : "").not.toContain("resets at");
  });

  it("does not invent credit use from the usage ledger and fails closed when the read fails", async () => {
    const { env, sqlite } = fixture();
    sqlite.prepare(
      `INSERT INTO usage_daily (user_id, day, route_profile_id, response_model, requests, last_seen_at)
       VALUES ('sop-plus', '2026-08-10', 'grok.production.responses', 'grok', 9, ?)`
    ).run(NOW.toISOString());
    const state = (await listSurfaceCreditStates(env, NOW, "sop-plus"))
      .find((candidate) => candidate.surface_grant === GRANT);
    expect(state?.consumed_credits).toBe(0);
    const broken = {
      DB: {
        prepare() {
          throw new Error("d1 unavailable");
        },
        async batch() {
          throw new Error("d1 unavailable");
        }
      }
    } as unknown as Env;
    await expect(listSurfaceCreditStates(broken, NOW, "sop-plus")).rejects.toThrow("d1 unavailable");
    await expect(consumeSurfaceCredits(broken, {
      user_id: "sop-plus",
      surface_grant: GRANT,
      plan_id: "grok.production.responses",
      credit_charge: 1
    }, NOW)).rejects.toThrow("d1 unavailable");
  });

  it("requires every requested surface to be enabled and does not drop the others", async () => {
    const { env, sqlite } = fixture();
    sqlite.prepare("UPDATE organization_surface_credit_defaults SET monthly_allowance = 3 WHERE surface_grant = 'surface:codex:production'").run();
    await expect(assertIssuanceEntitlement(env, "sop-plus", [
      "surface:codex:production",
      "surface:grok:production"
    ], NOW)).rejects.toMatchObject({ code: "surface_not_entitled" });
    expect(sqlite.prepare("SELECT count(*) AS count FROM api_keys").get()).toEqual({ count: 0 });
    sqlite.prepare("UPDATE organization_surface_credit_defaults SET monthly_allowance = 3").run();
    await assertIssuanceEntitlement(env, "sop-plus", ["surface:codex:production", "surface:xai:production"], NOW);
  });

  it("admits at most one of two competing inherited requests", async () => {
    const root = mkdtempSync(join(tmpdir(), "mini-credit-"));
    try {
      const file = join(root, "credit.sqlite");
      const db = createTestD1({ file });
      db.sqlite.prepare(
        "INSERT INTO users (id, email, status, created_at, updated_at) VALUES ('sop-plus', 'sop@example.test', 'active', 't', 't')"
      ).run();
      db.sqlite.prepare(
        "UPDATE organization_surface_credit_defaults SET monthly_allowance = 1 WHERE surface_grant = ?"
      ).run(GRANT);
      db.close();
      const hold = join(root, "hold");
      const slow = race({ file, delayMs: 4_000, holdFile: hold });
      await waitFor(hold);
      const fast = race({ file, delayMs: 0, holdFile: join(root, "unused") });
      const results = await Promise.all([slow, fast]);
      expect(results.filter((result) => result.ok)).toHaveLength(1);
      expect(results.some((result) => result.code === "surface_credit_exhausted")).toBe(true);
      expect(Math.min(...results.map((result) => result.elapsed))).toBeGreaterThan(200);
      const read = createTestD1({ file, migrations: "none" });
      expect(read.sqlite.prepare("SELECT consumed_credits, admitted_attempts FROM user_surface_credit_usage").all())
        .toEqual([{ consumed_credits: 1, admitted_attempts: 1 }]);
      read.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 20_000);

  it("keeps an explicit unlimited policy out of the finite table and above an organization zero", async () => {
    const { env, sqlite } = fixture();
    await assign(env, { mode: "unlimited", monthly_allowance: null });
    expect(sqlite.prepare(
      "SELECT monthly_allowance FROM user_surface_credit_policies WHERE user_id = ? AND surface_grant = ?"
    ).get("sop-plus", GRANT)).toBeUndefined();
    expect(sqlite.prepare("SELECT mode FROM user_surface_credit_modes WHERE user_id = ?").get("sop-plus")).toEqual({ mode: "unlimited" });
    const state = (await listSurfaceCreditStates(env, NOW, "sop-plus")).find((row) => row.surface_grant === GRANT);
    expect(state).toMatchObject({ mode: "unlimited", monthly_allowance: null, remaining_credits: null, source: "personal" });
    await consume(env, NOW);
    await consume(env, LATER);
    expect(sqlite.prepare("SELECT consumed_credits FROM user_surface_credit_usage").get()).toEqual({ consumed_credits: 2 });
    await assertIssuanceEntitlement(env, "sop-plus", [GRANT], NOW);
  });

  it("admits a zero charge under a finite zero cap and rejects one when the surface is disabled", async () => {
    const { env, sqlite } = fixture();
    await assign(env, { mode: "limited", monthly_allowance: 0 });
    await consumeSurfaceCredits(env, { user_id: "sop-plus", surface_grant: GRANT, plan_id: "grok.production.responses", credit_charge: 0 }, NOW);
    await expect(consume(env, NOW)).rejects.toMatchObject({ status: 403, code: "surface_disabled" });
    await assign(env, { mode: "disabled", monthly_allowance: null });
    await expect(consumeSurfaceCredits(env, {
      user_id: "sop-plus", surface_grant: GRANT, plan_id: "grok.production.responses", credit_charge: 0
    }, NOW)).rejects.toMatchObject({ status: 403, code: "surface_disabled" });
    expect(sqlite.prepare("SELECT count(*) AS count FROM user_surface_credit_policies WHERE user_id = 'sop-plus'").get()).toEqual({ count: 0 });
    sqlite.prepare("DELETE FROM organization_surface_credit_defaults").run();
    sqlite.prepare("DELETE FROM user_surface_credit_modes").run();
    await expect(consumeSurfaceCredits(env, {
      user_id: "sop-plus", surface_grant: GRANT, plan_id: "grok.production.responses", credit_charge: 0
    }, NOW)).rejects.toMatchObject({ status: 403, code: "surface_disabled" });
  });

  it("keeps recorded consumption when a finite cap becomes unlimited and then limited again", async () => {
    const { env, sqlite } = fixture();
    await assign(env, { mode: "limited", monthly_allowance: 2 });
    await consume(env, NOW);
    await assign(env, { mode: "unlimited", monthly_allowance: null });
    await consume(env, LATER);
    expect(sqlite.prepare("SELECT consumed_credits FROM user_surface_credit_usage").get()).toEqual({ consumed_credits: 2 });
    await assign(env, { mode: "limited", monthly_allowance: 2 });
    await expect(consume(env, LATER)).rejects.toMatchObject({ status: 429, code: "surface_credit_exhausted" });
    expect(sqlite.prepare("SELECT consumed_credits FROM user_surface_credit_usage").get()).toEqual({ consumed_credits: 2 });
  });
});

describe("member and operator allowance routes", () => {
  it("shows only the caller's credits and lets an admin change defaults without rewriting keys", async () => {
    const fixture = makeFixture();
    fixture.db.setOrganizationAllowance(0);
    const owner = await createUser(fixture, "allowance-owner@example.com");
    const other = await createUser(fixture, "allowance-other@example.com");
    fixture.db.seedConsoleUser({ id: "allowance_admin", email: "allowance-admin@example.com", role: "admin" });
    {
      const member = await handleRequest(new Request("https://admin.example.test/me/credits?user_id=" + other.user.id, {
        headers: { Cookie: `__Host-mini-console=${await consoleCookie(fixture, "allowance-owner@example.com")}` }
      }), fixture.env, fixture.ctx, fixture.deps);
      expect(member.status).toBe(200);
      expect(member.headers.get("Cache-Control")).toBe("no-store");
      const body = await member.json() as { credits: Array<{ surface: string; source: string; monthly_allowance: number }> };
      expect(body.credits.map((credit) => credit.surface).sort()).toEqual(["codex", "grok", "xai"]);
      expect(body.credits.every((credit) => credit.monthly_allowance === 0 && credit.source === "organization")).toBe(true);
      expect(JSON.stringify(body)).not.toContain(other.user.id);
      const denied = await handleRequest(new Request("https://admin.example.test/admin/ui/credit-defaults/codex", {
        method: "POST",
        headers: {
          Cookie: `__Host-mini-console=${await consoleCookie(fixture, "allowance-owner@example.com")}`,
          "Content-Type": "application/json",
          Origin: "https://admin.example.test"
        },
        body: JSON.stringify({ monthly_allowance: 9, confirm: true })
      }), fixture.env, fixture.ctx, fixture.deps);
      expect(denied.status).toBe(403);
    }

    const issued = await admin(fixture, "https://api.trustedtunnel.app/admin/users/" + owner.user.id + "/keys", {
      method: "POST",
      body: { name: "Denied", scopes: ["surface:codex:production"], credential_bindings: [] }
    });
    expect(issued.status).toBe(403);
    expect(fixture.db.apiKeys.size).toBe(0);
    const updated = await admin(fixture, "https://api.trustedtunnel.app/admin/credit-defaults/codex", {
      method: "PUT",
      body: { monthly_allowance: 6 }
    });
    expect(updated.status).toBe(200);
    await expect(updated.json()).resolves.toMatchObject({ surface_grant: "surface:codex:production", monthly_allowance: 6 });
    const xai = await admin(fixture, "https://api.trustedtunnel.app/admin/credit-defaults/xai", {
      method: "PUT",
      body: { monthly_allowance: 2 }
    });
    const xaiBody = await xai.json() as { shared_provider_authority?: string };
    expect(xaiBody.shared_provider_authority).toContain("provider team");
    fixture.db.ensureCredentialAccountsForScopes(["surface:codex:production"]);
    const key = await createKey(fixture, owner.user.id, ["surface:codex:production"]);
    const scopesBefore = fixture.db.apiKeys.get(key.key.id)?.scopes;
    await admin(fixture, `https://api.trustedtunnel.app/admin/users/${owner.user.id}/credits/codex`, {
      method: "PUT",
      body: { monthly_allowance: 1 }
    });
    expect(fixture.db.apiKeys.get(key.key.id)?.scopes).toBe(scopesBefore);
    expect(fixture.db.operatorMutationAudit.some((row) => row.action === "credit_default.set" && row.result === "ok")).toBe(true);
    const failed = await admin(fixture, `https://api.trustedtunnel.app/admin/users/${owner.user.id}/credits/missing`, {
      method: "PUT",
      body: { monthly_allowance: 1 }
    });
    expect(failed.status).toBeGreaterThanOrEqual(400);
  });
});

const ACTOR: CreditAuditActor = {
  kind: "admin_secret",
  email: null,
  subject: null,
  userId: null,
  role: null,
  requestId: "req_credit_mode"
};

async function assign(
  env: Env,
  input: { mode: "limited"; monthly_allowance: number } | { mode: "unlimited" | "disabled"; monthly_allowance: null }
): Promise<void> {
  await commitPersonalCreditPolicy(env, ACTOR, {
    user_id: "sop-plus",
    surface_grant: GRANT,
    mode: input.mode,
    monthly_allowance: input.monthly_allowance,
    previous_monthly_allowance: null
  }, NOW);
}

async function consume(env: Env, now: Date): Promise<void> {
  await consumeSurfaceCredits(env, {
    user_id: "sop-plus",
    surface_grant: GRANT,
    plan_id: "grok.production.responses",
    credit_charge: 1
  }, now);
}

function fixture(options: { onBatch?: () => void } = {}): { env: Env; sqlite: DatabaseSync } {
  const testDb = createTestD1(options);
  onTestFinished(() => testDb.close());
  testDb.sqlite.prepare(
    `INSERT INTO users (id, email, status, created_at, updated_at)
     VALUES (?, ?, 'active', ?, ?)`
  ).run("sop-plus", "sop-plus@example.test", NOW.toISOString(), NOW.toISOString());
  return { sqlite: testDb.sqlite, env: { DB: testDb.binding } as Env };
}

function race(workerData: { file: string; delayMs: number; holdFile: string }): Promise<{ ok: boolean; elapsed: number; code?: string }> {
  const worker = new Worker(new URL("./credit-race-worker.ts", import.meta.url), {
    execArgv: ["--import", "tsx"],
    workerData
  });
  return new Promise((resolve, reject) => {
    let settled = false;
    worker.once("message", (message) => {
      settled = true;
      worker.once("exit", () => resolve(message));
    });
    worker.once("error", (error) => {
      if (!settled) reject(error);
    });
    worker.once("exit", (code) => {
      if (!settled) reject(new Error(`credit worker exited ${code}`));
    });
  });
}

async function waitFor(path: string): Promise<void> {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    try {
      statSync(path);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  throw new Error(`Timed out waiting for ${path}`);
}
