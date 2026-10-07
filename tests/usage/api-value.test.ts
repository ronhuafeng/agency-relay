import { describe, expect, it } from "vitest";
import { apiEquivalentValue, OPENAI_PRICE_VERSION } from "../../src/usage/api-value";
import { commitProviderAttemptAccounting, queryUsageDaily, queryUsageSummary } from "../../src/db";
import { makeFixture } from "../router/fixture";
import type { CapturedProviderUsage } from "../../src/types";
import { formatUsdTicks } from "../../src/admin/format";

const usage: CapturedProviderUsage = {
  input_tokens: 100, cached_input_tokens: 20, output_tokens: 10,
  reasoning_tokens: 8, total_tokens: 110, provider_cost_usd_ticks: null
};
const value = (model: string, overrides: Partial<CapturedProviderUsage> = {}) =>
  apiEquivalentValue({ model, response_id: null, usage: { ...usage, ...overrides } });

describe("OpenAI Standard API-equivalent USD", () => {
  it("formats integer ticks without cent rounding and rejects unsafe amounts", () => {
    expect(formatUsdTicks(1)).toBe("$0.0000000001");
    expect(formatUsdTicks(Number.MAX_SAFE_INTEGER)).toBe("$900719.9254740991");
    expect(formatUsdTicks(Number.MAX_SAFE_INTEGER + 1)).toBe("超出精确范围");
  });
  it("charges disjoint input and full output, without adding reasoning again", () => {
    expect(value("gpt-5.5")).toEqual({ticks: 7100000, version: OPENAI_PRICE_VERSION});
    expect(value("gpt-5.3-codex")?.ticks).toBe(2835000);
  });
  it("requires explicit cache writes for charged models and replaces ordinary input", () => {
    expect(value("gpt-6.1-sol")).toBeNull();
    expect(value("gpt-6.1-sol", {cache_write_input_tokens: 30})?.ticks).toBe(2770000);
    expect(value("gpt-6.1-sol", {cache_write_input_tokens: 0})?.ticks).toBe(2620000);
  });
  it("uses the full-request long rate only above 272K input tokens", () => {
    expect(value("gpt-5.5", {input_tokens: 272000, cached_input_tokens: 0, output_tokens: 0})?.ticks).toBe(13600000000);
    expect(value("gpt-5.5", {input_tokens: 272001, cached_input_tokens: 0, output_tokens: 10})?.ticks).toBe(27204600000);
  });
  it("keeps zero measured and missing, invalid, unknown or unsafe data unpriced", () => {
    expect(value("gpt-5.5", {input_tokens: 0, cached_input_tokens: 0, output_tokens: 0})?.ticks).toBe(0);
    for (const overrides of [{input_tokens: null}, {cached_input_tokens: null}, {output_tokens: null},
      {cached_input_tokens: 101}, {input_tokens: -1}, {output_tokens: 1.5}, {output_tokens: Number.MAX_SAFE_INTEGER}]) {
      expect(value("gpt-5.5", overrides)).toBeNull();
    }
    expect(value("gpt-6.1-sol", {cache_write_input_tokens: 81})).toBeNull();
    expect(value("gpt-5.5-pro", {cached_input_tokens: 1})).toBeNull();
    expect(value("unknown")).toBeNull();
    expect(value("constructor")).toBeNull();
    expect(value("gpt-5.5-guessed-alias")).toBeNull();
    expect(apiEquivalentValue(null)).toBeNull();
  });
  it("commits exact per-attempt values and coverage atomically with audit and daily SQL", async () => {
    const fixture = makeFixture();
    fixture.db.seedUsage({ user_id: "priced-user", day: "2026-10-06", route_profile_id: "codex.responses", requests: 1 });
    const commit = (id: string, plan: string, model: string, overrides: Partial<CapturedProviderUsage> = {}) =>
      commitProviderAttemptAccounting(fixture.env, {
        audit_id: id, route_profile_id: plan, user_id: "priced-user", status: "ok", upstream_status: 200,
        usage_observer: "responses", usage_capture: {model, response_id: null, usage: {...usage, ...overrides}}
      }, new Date("2026-10-07T08:00:00Z"));
    await commit("priced-short", "codex.responses", "gpt-5.5");
    await commit("priced-long", "codex.responses", "gpt-5.5", {input_tokens: 272001, cached_input_tokens: 0, output_tokens: 10});
    await commit("unpriced", "codex.responses", "gpt-6.1-sol");
    await commit("priced-write", "codex.responses", "gpt-6.1-sol", {cache_write_input_tokens: 30});
    await commit("reported", "grok.production.responses", "gpt-5.5", {provider_cost_usd_ticks: 123});
    const query = {mode: "day", day: "2026-10-07", route_profile_id: "codex.responses", limit: 100} as const;
    const summary = await queryUsageSummary(fixture.env, query);
    expect(summary.totals).toMatchObject({requests: 4, token_measurements: 4, provider_cost_usd_ticks: 0,
      cost_measurements: 0, api_equivalent_usd_ticks: 27214470000, api_equivalent_measurements: 3});
    const daily = await queryUsageDaily(fixture.env, query);
    expect(daily.responses[0]).toMatchObject(summary.totals);
    const audit = await fixture.env.DB.prepare("SELECT cache_write_input_tokens, api_equivalent_usd_ticks, api_price_version FROM request_audit WHERE id=?").bind("priced-write").first();
    expect(audit).toEqual({cache_write_input_tokens: 30, api_equivalent_usd_ticks: 2770000, api_price_version: OPENAI_PRICE_VERSION});
    expect(await fixture.env.DB.prepare("SELECT api_equivalent_usd_ticks, api_price_version FROM request_audit WHERE id='unpriced'").first()).toEqual({api_equivalent_usd_ticks: null, api_price_version: null});
    const grok = await queryUsageSummary(fixture.env, {...query, route_profile_id: "grok.production.responses"});
    expect(grok.totals).toMatchObject({provider_cost_usd_ticks: 123, cost_measurements: 1, api_equivalent_usd_ticks: 0, api_equivalent_measurements: 0});
    const history = await queryUsageSummary(fixture.env, {...query, day: "2026-10-06"});
    expect(history.totals).toMatchObject({requests: 1, api_equivalent_usd_ticks: 0, api_equivalent_measurements: 0});
  });
});
