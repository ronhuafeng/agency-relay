import { expect, it } from "vitest";
import type { SurfaceCreditState } from "../../src/auth/credits";
import { HOST, call, codexLanguageModel, expectJson, grokGatewayModel } from "./support";
import { admin, assertJsonShape, isRecord, languageModel, requireEnv, sleep } from "./runtime";
import { assertCompletedSse } from "./oracles";

// No paid retries. Operator D1 identity readback is also required for acceptance.
it("reconciles charged admissions separately from terminal and usage measurements", async () => {
  const user = requireEnv("MINI_LIVE_RECONCILIATION_USER_ID");
  const keys = { codex: requireEnv("MINI_ONLY_CODEX_SURFACE_API_KEY"),
    grok: requireEnv("MINI_ONLY_GROK_SURFACE_API_KEY"), xai: requireEnv("MINI_ONLY_XAI_SURFACE_API_KEY") };
  const run = `${requireEnv("GITHUB_RUN_ID")}-${requireEnv("GITHUB_RUN_ATTEMPT")}`;
  const models = { codex: await codexLanguageModel(keys.codex),
    grok: grokGatewayModel(expectJson(await call(`${HOST.grok}/v1/models`, keys.grok))),
    xai: await languageModel(HOST.xai, keys.xai) };
  const before = await credits(user);
  const period = before[0]!.period_start;
  expect(before.every(state => state.period_start === period && state.reconciliation.balance_difference === 0)).toBe(true);
  expect(before.every(state => state.mode === "unlimited" || (state.mode === "limited"
    && (state.remaining_credits ?? 0) >= (state.surface_grant === "surface:grok:production" ? 2 : 1)))).toBe(true);
  const startedAt = new Date().toISOString();
  for (const surface of ["codex", "grok", "xai"] as const) {
    const path = surface === "codex" ? "/backend-api/codex/responses" : "/v1/responses";
    const response = await call(`${HOST[surface]}${path}`, keys[surface], {
      method: "POST", headers: { "Content-Type": "application/json", Accept: "text/event-stream",
        "X-Client-Request-Id": `credit-proof-${run}-${surface}` },
      body: JSON.stringify({ model: models[surface], instructions: "Reply concisely.",
        input: [{ role: "user", content: [{ type: "input_text", text: "Reply exactly OK." }] }], stream: true, store: false })
    }, 180_000);
    expect(response.status).toBe(200);
    assertCompletedSse(response.text);
  }
  const rejected = await call(`${HOST.grok}/v1/responses`, keys.grok, {
    method: "POST", headers: { "Content-Type": "application/json", "X-Client-Request-Id": `credit-proof-${run}-rejected` },
    body: JSON.stringify({ model: "mini-credit-proof-nonexistent-model", input: "OK", stream: false }) });
  expect(rejected.status >= 400 && rejected.status < 500).toBe(true);
  const denied = await call(`${HOST.xai}/v1/responses`, keys.grok, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: models.xai, input: "OK", stream: false }) });
  expect(denied.status).toBe(403);
  assertJsonShape(expectJson(denied, 403), { error: { code: "scope_denied" } });
  let reconciled = false;
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const after = await credits(user);
    if (after.some(state => state.period_start !== period)) throw new Error("Credit proof crossed a UTC month");
    reconciled = after.every((state, index) => {
      const prior = before[index]!;
      const delta = state.surface_grant === "surface:grok:production" ? 2 : 1;
      const next = state.reconciliation, previous = prior.reconciliation;
      return state.surface_grant === prior.surface_grant && state.consumed_credits - prior.consumed_credits === delta
        && next.opening_credits === previous.opening_credits && next.opening_balance_captured
        && next.recorded_admission_credits - previous.recorded_admission_credits === delta
        && next.charged_admissions - previous.charged_admissions === delta
        && next.terminal_confirmed_credits - previous.terminal_confirmed_credits === delta
        && next.terminal_confirmed_admissions - previous.terminal_confirmed_admissions === delta
        && next.terminal_unconfirmed_credits === previous.terminal_unconfirmed_credits && next.balance_difference === 0;
    });
    if (reconciled) break;
    await sleep(1_000);
  }
  expect(reconciled).toBe(true);
  console.log(JSON.stringify({ event: "credit_reconciliation_proof", started_at: startedAt,
    finished_at: new Date().toISOString(), charged_invocations: 4,
    codex_credit_delta: 1, grok_credit_delta: 2, xai_credit_delta: 1,
    terminal_confirmed_delta: 4, denied_credit_delta: 0, balance_difference: 0,
    receipt_identity_readback: "operator_required" }));
}, 660_000);

async function credits(user: string): Promise<SurfaceCreditState[]> {
  const response = await admin("GET", `/admin/users/${encodeURIComponent(user)}/credits`);
  expect(response.status).toBe(200);
  const body = response.json;
  if (!isRecord(body) || !Array.isArray(body.states) || body.states.length !== 3) throw new Error("Credit projection unavailable");
  const states: unknown[] = body.states;
  const grants = ["surface:codex:production", "surface:grok:production", "surface:xai:production"];
  expect(grants.every(grant => states.filter(state => isRecord(state)
    && state.surface_grant === grant && state.user_id === user).length === 1)).toBe(true);
  for (const state of states) {
    assertJsonShape(state, { period_start: expect.any(String), consumed_credits: expect.any(Number),
      surface_grant: expect.any(String), reconciliation: {
        opening_credits: expect.any(Number), opening_balance_captured: expect.any(Boolean),
        recorded_admission_credits: expect.any(Number), terminal_confirmed_credits: expect.any(Number),
        terminal_unconfirmed_credits: expect.any(Number), balance_difference: expect.any(Number),
        charged_admissions: expect.any(Number), terminal_confirmed_admissions: expect.any(Number) } });
  }
  return (states as SurfaceCreditState[]).sort((left, right) => left.surface_grant.localeCompare(right.surface_grant));
}
