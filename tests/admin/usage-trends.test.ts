import { describe, expect, it } from "vitest";
import { JSDOM } from "jsdom";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { parseUsageQuery, parseUsageTrendRange, MAX_USAGE_RANGE_DAYS } from "../../src/admin/usage-query";
import { queryUsageDaily, queryUsageSummary } from "../../src/db";
import { readUsageReport } from "../../src/admin/ui/models";
import { UsageTrends } from "../../src/admin/ui/usage-trends";
import { handleRequest } from "../../src/router";
import { admin, consoleCookie, createUser, makeFixture } from "../router/fixture";
import type { MediaUsageSummaryRow } from "../../src/types";

const now = new Date("2026-06-24T12:00:00.000Z");
const url = (query: string) => new URL(`https://console.test/?${query}`);
function doc(html: string) { return new JSDOM(html).window.document; }
function textFor(node: Element, label: string): string | undefined {
  return [...node.querySelectorAll("dt")].find(node => node.textContent === label)?.nextElementSibling?.textContent ?? undefined;
}

describe("exact bounded usage dates", () => {
  it("hydrates exact-range personal exports without admitting foreign destinations", () => {
    const value = {records: [], emptyLabel: "empty", exportUrl: "/me/usage?from=2026-06-18&to=2026-06-24", truncated: false, filterPlaceholder: "model", limitNote: "100"};
    expect(readUsageReport(value)?.exportUrl).toBe(value.exportUrl);
    expect(readUsageReport({...value, exportUrl: "//foreign.test/me/usage"})).toBeNull();
  });
  it.each([
    "day=2026-02-29", "day=2026-04-31", "day=2026-13-01", "day=2026-2-01", "day=", "day=2026-06-24&scope=all",
    "day=2026-06-24&from=2026-06-01&to=2026-06-30", "scope=all&from=2026-06-01&to=2026-06-30",
    "from=2026-06-01", "to=2026-06-01", "from=2026-06-02&to=2026-06-01", "scope=team",
    "day=2026-06-24&day=2026-06-23", "from=2000-01-01&to=2026-06-24"
  ])("rejects %s even with a personal all-time default", (query) => {
    expect(() => parseUsageQuery(url(query), {defaultAll: true, defaultLimit: 100})).toThrow();
  });
  it("retains explicit all/day/range API contracts and the personal no-query default", () => {
    expect(parseUsageQuery(url("scope=all&limit=1000")).mode).toBe("all");
    expect(parseUsageQuery(url("day=2024-02-29&limit=1")).filters.day).toBe("2024-02-29");
    const to = new Date(Date.parse("2000-01-01") + (MAX_USAGE_RANGE_DAYS - 1) * 86_400_000).toISOString().slice(0,10);
    expect(parseUsageQuery(url(`from=2000-01-01&to=${to}&limit=100`)).mode).toBe("range");
    expect(parseUsageQuery(url(""), {defaultAll: true, defaultLimit: 100})).toMatchObject({mode: "all", filters: {limit: 100}});
    expect(() => parseUsageQuery(url("scope=all"))).toThrow();
  });
  it("uses inclusive UTC days across month, leap day and year boundaries", () => {
    expect(parseUsageTrendRange(url("range=7d"), new Date("2024-03-01T00:00:00Z"))).toMatchObject({from: "2024-02-24", to: "2024-03-01", days: ["2024-02-24", "2024-02-25", "2024-02-26", "2024-02-27", "2024-02-28", "2024-02-29", "2024-03-01"]});
    expect(parseUsageTrendRange(url("range=30d"), new Date("2026-01-01T23:59:59Z"))).toMatchObject({from: "2025-12-03", to: "2026-01-01"});
    for (const query of ["range=all", "range=today", "range=90d", "range=7d&range=30d", "range=7d&day=2026-06-24", "scope=all"]) expect(() => parseUsageTrendRange(url(query), now)).toThrow();
  });
});

describe("daily SQL and honest projections", () => {
  it("searches the complete authorized ledger and exports the same person/model subset", async () => {
    const fixture = makeFixture();
    const member = await createUser(fixture, "member@example.com");
    fixture.db.seedConsoleUser({id: "admin-own", email: "boss@example.com", role: "admin"});
    for (let index = 0; index < 251; index++) fixture.db.seedUsage({user_id: member.user.id, day: "2026-06-24", route_profile_id: "codex.responses", response_model: `match-${index}`, requests: 2, total_tokens: 0, token_measurements: 1});
    fixture.db.seedUsage({user_id: "other", day: "2026-06-24", route_profile_id: "codex.responses", response_model: "foreign-match", requests: 99});
    const query = {mode: "range", from: "2026-06-18", to: "2026-06-24", q: "MATCH-", user_id: member.user.id, limit: 1} as const;
    expect((await queryUsageSummary(fixture.env, query)).rows).toHaveLength(1);
    expect((await queryUsageDaily(fixture.env, query)).responses[0].requests).toBe(502);
    expect((await queryUsageDaily(fixture.env, {...query, q: "match-%"})).responses).toHaveLength(0);
    const request = async (email: string, path: string) => handleRequest(new Request(`https://admin.example.test${path}`, {headers: {Cookie: `__Host-mini-console=${await consoleCookie(fixture, email)}`}}), fixture.env, fixture.ctx, fixture.deps);
    const page = await request("boss@example.com", "/admin?view=usage&range=7d&q=MEMBER%40EXAMPLE.COM");
    expect(page.status).toBe(200);
    const document = doc(await page.text());
    expect(textFor(document.querySelector('[data-trend-plan]')!, "Requests")).toBe("502");
    expect(document.querySelectorAll('.usage-record')).toHaveLength(250);
    expect(document.querySelector('input[name="q"]')?.getAttribute('value')).toBe("MEMBER@EXAMPLE.COM");
    const exportUrl = document.querySelector('a[download]')!.getAttribute('href')!;
    const exported = await (await request("boss@example.com", exportUrl)).json() as {totals: {requests: number}; rows: unknown[]};
    expect(exported.totals.requests).toBe(502);
    expect(exported.rows).toHaveLength(251);
    const own = await request("member@example.com", "/admin?area=me&view=usage&range=7d&q=foreign-match&user_id=other");
    expect(own.status).toBe(200);
    expect(doc(await own.text()).querySelectorAll('[data-trend-plan]')).toHaveLength(0);
  });
  it("distinguishes coexisting exact plans and uses integral low-count axis ticks", async () => {
    const fixture = makeFixture();
    for (const plan of ["codex.responses", "codex.responses_compact", "codex.historical.responses"]) fixture.db.seedUsage({user_id: "mine", day: "2026-06-24", route_profile_id: plan, requests: 1});
    const daily = await queryUsageDaily(fixture.env, {mode: "range", from: "2026-06-18", to: "2026-06-24", user_id: "mine", limit: 1});
    const document = doc(renderToStaticMarkup(createElement(UsageTrends, {model: {range: parseUsageTrendRange(url(""), now), daily, scopeLabel: "我的用量"}})));
    const series = [...document.querySelectorAll('[data-trend-plan]')];
    expect(new Set(series.map(node => node.querySelector('button')?.textContent)).size).toBe(3);
    expect(new Set(series.map(node => node.querySelector('[data-series-color]')?.getAttribute('data-series-color'))).size).toBe(3);
    for (const node of series) expect(node.querySelector('code')?.textContent).toBe(node.getAttribute('data-trend-plan'));
    expect([...document.querySelectorAll('.usage-chart-y span')].map(node => node.textContent)).toEqual(["2", "1", "0"]);
    for (const bar of document.querySelectorAll('[data-chart-day="2026-06-24"] .usage-chart-bar')) {
      expect(bar.getAttribute('y')).toBe("120");
      expect(bar.getAttribute('height')).toBe("100");
    }
  });
  it("sums every matching ledger row beyond the display/export limit and keeps exact plans apart", async () => {
    const fixture = makeFixture();
    for (let i = 0; i < 251; i++) fixture.db.seedUsage({user_id: "mine", day: "2026-06-24", route_profile_id: "grok.production.responses", response_model: `model-${i}`, requests: 2, ok_requests: 1, error_requests: 1, total_tokens: 0, token_measurements: 1, cost_measurements: 1});
    fixture.db.seedUsage({user_id: "mine", day: "2026-06-23", route_profile_id: "grok.production.responses", response_model: "previous", requests: 1, ok_requests: 1, total_tokens: 100, token_measurements: 1, provider_cost_usd_ticks: 12, cost_measurements: 1});
    fixture.db.seedUsage({user_id: "mine", day: "2026-06-24", route_profile_id: "xai.production.responses", requests: 3, total_tokens: 50, token_measurements: 1});
    fixture.db.seedUsage({user_id: "foreign", day: "2026-06-24", route_profile_id: "grok.production.responses", requests: 999});
    fixture.db.seedUsage({user_id: "mine", day: "2026-05-24", route_profile_id: "grok.production.responses", requests: 999});
    const query = {mode: "range", from: "2026-06-18", to: "2026-06-24", user_id: "mine", limit: 100} as const;
    const summary = await queryUsageSummary(fixture.env, query);
    const daily = await queryUsageDaily(fixture.env, query);
    expect(summary.rows).toHaveLength(100);
    expect(summary.totals.requests).toBe(506);
    expect(daily.responses.reduce((sum, row) => sum + row.requests, 0)).toBe(summary.totals.requests);
    expect(daily.responses).toHaveLength(3);
    const document = doc(renderToStaticMarkup(createElement(UsageTrends, {model: {range: parseUsageTrendRange(url(""), now), daily, scopeLabel: "我的用量"}})));
    const grok = document.querySelector('[data-trend-plan="grok.production.responses"]')!;
    expect(textFor(grok, "Requests")).toBe("503");
    expect(textFor(grok, "Token")).toBe("100 · 已记录 252/503 次请求");
    expect(textFor(grok, "上游计量金额")).toBe("$0.0000000012 · 已记录 252/503 次请求");
    const rows = [...document.querySelectorAll('[data-text-plan="grok.production.responses"] dl>div')];
    expect(rows).toHaveLength(7);
    expect(rows[0].textContent).toContain("未记录 · 覆盖 0/0");
    expect(rows.at(-1)!.textContent).toContain("0 · 已记录 251/502 次请求");
    expect(document.querySelectorAll('[data-trend-plan]')).toHaveLength(2);
    const filtered = await queryUsageDaily(fixture.env, {...query, route_profile_id: "grok.production.responses", response_model: "previous"});
    expect(filtered.responses).toHaveLength(1);
    expect(filtered.responses[0].requests).toBe(1);
    await expect(queryUsageDaily(fixture.env, {...query, from: "2026-01-01"})).rejects.toThrow();
  });
  it("applies inclusive UTC leap-day boundaries in real SQL", async () => {
    const fixture = makeFixture();
    for (const day of ["2024-02-28", "2024-02-29", "2024-03-01", "2024-03-02"]) fixture.db.seedUsage({user_id: "mine", day, route_profile_id: "codex.responses", requests: 1});
    const range = await queryUsageDaily(fixture.env, {mode: "range", from: "2024-02-29", to: "2024-03-01", user_id: "mine", limit: 1});
    expect(range.responses.map(row => row.day)).toEqual(["2024-02-29", "2024-03-01"]);
    const day = await queryUsageDaily(fixture.env, {mode: "day", day: "2024-02-29", user_id: "mine", limit: 1});
    expect(day.responses.map(row => row.day)).toEqual(["2024-02-29"]);
  });
  it("preserves media event days and per-capability measurement denominators", async () => {
    const fixture = makeFixture();
    const base: MediaUsageSummaryRow = {user_id: "mine", email: null, first_day: "2026-06-23", last_day: "2026-06-23", route_profile_id: "xai.production.videos_generations", capability: "video_generation", started_jobs: 0, completed_jobs: 0, failed_jobs: 0, expired_jobs: 0, outputs: 0, video_seconds: 0, output_measurements: 0, duration_measurements: 0, provider_cost_usd_ticks: 0, cost_measurements: 0, last_seen_at: "2026-06-23T12:00:00Z"};
    fixture.db.seedMediaUsageSummary(base, [
      {...base, started_jobs: 3},
      {...base, first_day: "2026-06-24", last_day: "2026-06-24", completed_jobs: 1, failed_jobs: 1, expired_jobs: 1, outputs: 0, output_measurements: 1, video_seconds: 1.5, duration_measurements: 1, cost_measurements: 1},
      {...base, route_profile_id: "xai.production.images_generations", capability: "image_generation", started_jobs: 2, completed_jobs: 1, outputs: 1, output_measurements: 1},
      {...base, user_id: "foreign", started_jobs: 99}
    ]);
    const daily = await queryUsageDaily(fixture.env, {mode: "range", from: "2026-06-18", to: "2026-06-24", user_id: "mine", response_model: "no-model", limit: 1});
    expect(daily.media).toHaveLength(3);
    const document = doc(renderToStaticMarkup(createElement(UsageTrends, {model: {range: parseUsageTrendRange(url(""), now), daily, scopeLabel: "我的用量"}})));
    const video = document.querySelector('[data-trend-capability="video_generation"]')!;
    expect(textFor(video, "开始")).toBe("3");
    expect(textFor(video, "输出")).toBe("0 · 已记录 1/3 次终态");
    expect(textFor(video, "时长")).toBe("1.5 秒 · 已记录 1/3 次终态");
    expect(textFor(video, "上游计量金额")).toBe("$0 · 已记录 1/3 次终态");
    const image = document.querySelector('[data-trend-capability="image_generation"]')!;
    expect(textFor(image, "输出")).toBe("1 · 已记录 1/2 次请求");
    const videoRows = document.querySelectorAll('[data-text-plan="xai.production.videos_generations"] dl>div');
    const start = videoRows[5];
    expect(start.textContent).toContain("未提供 · 覆盖 0/0");
    expect(videoRows[6].textContent).toContain("完成 / 失败 / 过期：1 / 1 / 1");
  });
});

describe("usage router scope and failure boundaries", () => {
  it("keeps member and admin personal trends own-only; validates before unavailable DB reads", async () => {
    const fixture = makeFixture();
    const member = await createUser(fixture, "member@example.com");
    fixture.db.seedConsoleUser({id: "admin-own", email: "boss@example.com", role: "admin"});
    fixture.db.seedUsage({user_id: member.user.id, day: "2026-06-24", route_profile_id: "codex.responses", requests: 2});
    fixture.db.seedUsage({user_id: "admin-own", day: "2026-06-24", route_profile_id: "codex.responses", requests: 4});
    fixture.db.seedUsage({user_id: "hidden", day: "2026-06-24", route_profile_id: "codex.responses", requests: 900, response_model: "foreign-only-model"});
    const request = async (email: string, path: string) => handleRequest(new Request(`https://admin.example.test${path}`, {headers: {Cookie: `__Host-mini-console=${await consoleCookie(fixture, email)}`}}), fixture.env, fixture.ctx, fixture.deps);
    for (const [email, requests] of [["member@example.com", "2"], ["boss@example.com", "4"]]) {
      const response = await request(email, "/admin?area=me&view=usage&range=7d&user_id=hidden");
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).not.toContain("foreign-only-model");
      expect(textFor(doc(html).querySelector('[data-trend-plan]')!, "Requests")).toBe(requests);
      for (const bad of ["day=2026-02-30", "day=2026-06-24&scope=all", "from=2026-06-01", "from=2026-06-25&to=2026-06-01", "from=2000-01-01&to=2026-06-24"]) expect((await request(email, `/me/usage?${bad}`)).status).toBe(400);
    }
    const organization = await request("boss@example.com", "/admin?view=usage&range=7d");
    expect(textFor(doc(await organization.text()).querySelector('[data-trend-plan]')!, "Requests")).toBe("906");
    const filtered = await request("boss@example.com", `/admin?view=usage&range=7d&person=${member.user.id}&plan=codex.responses`);
    const filteredDoc = doc(await filtered.text());
    expect(textFor(filteredDoc.querySelector('[data-trend-plan]')!, "Requests")).toBe("2");
    const exportUrl = filteredDoc.querySelector('a[download]')!.getAttribute('href')!;
    const exported = await (await request("boss@example.com", exportUrl)).json() as {totals: {requests: number}};
    expect(exported.totals.requests).toBe(2);
    expect((await request("member@example.com", "/admin/usage?scope=all&limit=100")).status).toBe(403);
    expect(fixture.fetchCalls).toHaveLength(0);
  });
  it("returns zero counts only after successful reads and repairs bad date modes with 400, not 503", async () => {
    const fixture = makeFixture({usageSchema: "missing"});
    await createUser(fixture, "member@example.com");
    const cookie = await consoleCookie(fixture, "member@example.com");
    const request = (path: string) => handleRequest(new Request(`https://admin.example.test${path}`, {headers: {Cookie: `__Host-mini-console=${cookie}`}}), fixture.env, fixture.ctx, fixture.deps);
    expect((await request('/me/usage?day=2026-02-30')).status).toBe(400);
    expect((await request('/admin?view=usage&range=all')).status).toBe(400);
    expect((await request('/me/usage?day=2026-06-24')).status).toBe(503);
    const failedPage = await request('/admin?view=usage&range=7d');
    expect(failedPage.status).toBe(503);
    expect(doc(await failedPage.text()).querySelector('[data-trend-empty]')).toBeNull();
    for (const invalid of ["day=2026-02-30", "scope=all&day=2026-06-24", "from=2026-06-01", "from=2026-06-25&to=2026-06-24", "from=2000-01-01&to=2026-06-24"]) {
      expect((await admin(fixture, `https://api.trustedtunnel.app/admin/usage?${invalid}&limit=100`, {method: "GET"})).status).toBe(400);
    }
    const empty = makeFixture();
    const daily = await queryUsageDaily(empty.env, {mode: "range", from: "2026-06-18", to: "2026-06-24", limit: 1});
    const html = renderToStaticMarkup(createElement(UsageTrends, {model: {range: parseUsageTrendRange(url(""), now), daily, scopeLabel: "我的用量"}}));
    expect(doc(html).querySelector('[data-trend-empty="all"]')?.textContent).toBe('此范围暂无用量记录');
    expect(doc(html).querySelector('svg')).toBeNull();
    expect(doc(html).querySelectorAll('[data-trend-plan]')).toHaveLength(0);
  });
});
