import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import { adminDashboardResponse } from "../../src/admin/dashboard";
import type { MediaUsageSummaryRow } from "../../src/types";
import { makeFixture } from "../router/fixture";

const now = new Date("2026-06-24T12:00:00.000Z");

async function open(fixture: ReturnType<typeof makeFixture>, query: string, at = now) {
  const response = await adminDashboardResponse({
    env: fixture.env,
    url: new URL(`https://admin.example.test/admin?${query}`),
    identity: {kind: "console", email: "op@example.com", subject: "operator"},
    now: at,
    requestId: "home-usage",
    loadCodexAccount: async () => { throw new Error("Home does not request provider observations"); }
  });
  return {response, document: new JSDOM(await response.text()).window.document};
}

function metric(series: Element, label: string): string | undefined {
  return [...series.querySelectorAll("dt")].find(node => node.textContent === label)?.nextElementSibling?.textContent ?? undefined;
}

function projection(document: Document) {
  return [...document.querySelectorAll("[data-trend-plan]")].map(series => ({
    plan: series.getAttribute("data-trend-plan"),
    capability: series.getAttribute("data-trend-capability"),
    metrics: [...series.querySelectorAll("dt")].map(node => [node.textContent, node.nextElementSibling?.textContent]),
    rows: [...document.querySelectorAll("[data-text-plan]")]
      .filter(data => data.getAttribute("data-text-plan") === series.getAttribute("data-trend-plan") && data.getAttribute("data-text-capability") === series.getAttribute("data-trend-capability"))
      .flatMap(data => [...data.querySelectorAll("dl>div")].map(row => row.textContent))
  }));
}

describe("organization Home usage projection", () => {
  it("defaults to the same inclusive UTC seven-day projection as an explicit range", async () => {
    const fixture = makeFixture();
    fixture.db.seedUsage({user_id: "usage-owner", day: "2026-06-24", route_profile_id: "codex.responses", response_model: "current", requests: 1});
    fixture.db.seedUsage({user_id: "usage-owner", day: "2026-06-01", route_profile_id: "codex.responses", response_model: "outside-seven-days", requests: 9});
    const implicit = await open(fixture, "");
    const explicit = await open(fixture, "view=overview&range=7d");
    expect(implicit.response.status).toBe(200);
    expect(projection(implicit.document)).toEqual(projection(explicit.document));
    expect(metric(implicit.document.querySelector('[data-trend-plan="codex.responses"]')!, "Requests")).toBe("1");
    expect(implicit.document.querySelector("#usage-trends")?.getAttribute("data-usage-range-label")).toBe("2026-06-18 至 2026-06-24 UTC");
  });

  it.each(["7d", "30d"])("reuses the report's complete %s ledger projection and measurement coverage", async range => {
    const fixture = makeFixture();
    for (let index = 0; index < 251; index++) {
      fixture.db.seedUsage({user_id: "usage-owner", day: "2026-06-24", route_profile_id: "grok.production.responses", response_model: `model-${index}`, requests: 2, ok_requests: 1, error_requests: 1, token_measurements: 1, cost_measurements: 1});
    }
    fixture.db.seedUsage({user_id: "usage-owner", day: "2026-06-23", route_profile_id: "grok.production.responses", response_model: "previous", requests: 1, ok_requests: 1, total_tokens: 100, token_measurements: 1, provider_cost_usd_ticks: 12, cost_measurements: 1});
    fixture.db.seedUsage({user_id: "usage-owner", day: "2026-06-01", route_profile_id: "grok.production.responses", response_model: "older", requests: 8, ok_requests: 8});
    fixture.db.seedUsage({user_id: "usage-owner", day: "2026-05-01", route_profile_id: "grok.production.responses", response_model: "outside", requests: 999});
    fixture.db.seedUsage({user_id: "usage-owner", day: "2026-06-24", route_profile_id: "xai.production.responses", requests: 3});
    fixture.db.seedUsage({user_id: "usage-owner", day: "2026-06-24", route_profile_id: "codex.responses", requests: 2, ok_requests: 2, total_tokens: 50, token_measurements: 2, provider_cost_usd_ticks: 123, cost_measurements: 2});
    const media: MediaUsageSummaryRow = {user_id: "usage-owner", email: null, first_day: "2026-06-24", last_day: "2026-06-24", route_profile_id: "xai.production.videos_generations", capability: "video_generation", started_jobs: 3, completed_jobs: 1, failed_jobs: 1, expired_jobs: 1, outputs: 0, video_seconds: 1.5, output_measurements: 1, duration_measurements: 1, provider_cost_usd_ticks: 0, cost_measurements: 1, last_seen_at: "2026-06-24T12:00:00.000Z"};
    fixture.db.seedMediaUsageSummary(media, [media, {...media, route_profile_id: "xai.production.images_generations", capability: "image_generation", started_jobs: 2, completed_jobs: 0, failed_jobs: 0, expired_jobs: 0, video_seconds: 0, output_measurements: 0, duration_measurements: 0, cost_measurements: 0}]);

    const home = await open(fixture, `view=overview&range=${range}`);
    const report = await open(fixture, `view=usage&range=${range}`);
    expect(home.response.status).toBe(200);
    expect(report.response.status).toBe(200);
    expect(projection(home.document)).toEqual(projection(report.document));
    const grok = home.document.querySelector('[data-trend-plan="grok.production.responses"]')!;
    const requests = range === "7d" ? "503" : "511";
    expect(metric(grok, "Requests")).toBe(requests);
    expect(metric(grok, "Failure")).toBe("251");
    expect(metric(grok, "Token")).toBe(`100 · 已记录 252/${requests} 次请求`);
    expect(metric(grok, "上游计量金额")).toBe(`$0.0000000012 · 已记录 252/${requests} 次请求`);
    const days = home.document.querySelectorAll('[data-text-plan="grok.production.responses"] dl>div');
    expect(days).toHaveLength(range === "7d" ? 7 : 30);
    expect(days[days.length - 1].textContent).toContain("2026-06-24 UTC · 未结束");
    expect(metric(home.document.querySelector('[data-trend-plan="xai.production.responses"]')!, "Token")).toBe("未记录 · 覆盖 0/3");
    expect(metric(home.document.querySelector('[data-trend-plan="xai.production.responses"]')!, "上游计量金额")).toBe("未提供 · 覆盖 0/3");
    expect(metric(home.document.querySelector('[data-trend-plan="codex.responses"]')!, "API 费率折算")).toContain("未提供 · 覆盖 0/");
    const video = home.document.querySelector('[data-trend-capability="video_generation"]')!;
    expect(metric(video, "输出")).toBe("0 · 已记录 1/3 次终态");
    expect(metric(video, "时长")).toBe("1.5 秒 · 已记录 1/3 次终态");
    expect(metric(video, "上游计量金额")).toBe("$0 · 已记录 1/3 次终态");
    expect(metric(home.document.querySelector('[data-trend-capability="image_generation"]')!, "输出")).toBe("未记录 · 覆盖 0/2");
    const rangeLinks = [...home.document.querySelectorAll('#usage-trends a[data-dashboard-link]')];
    expect(rangeLinks.map(link => new URL(link.getAttribute("href")!, "https://console.invalid").searchParams.get("view"))).toEqual(["overview", "overview"]);
    expect(rangeLinks.find(link => link.getAttribute("aria-current") === "true")?.textContent).toBe(range === "7d" ? "7 天" : "30 天");
    expect(fixture.fetchCalls).toHaveLength(0);
  });

  it("shows no series or numerical usage metrics when the range has no observed ledger rows", async () => {
    const fixture = makeFixture();
    fixture.db.seedUsage({user_id: "usage-owner", day: "2026-05-01", route_profile_id: "grok.production.responses", requests: 999});
    const {response, document} = await open(fixture, "view=overview&range=7d");
    expect(response.status).toBe(200);
    expect(document.querySelector('[data-trend-empty="all"]')?.textContent).toBe("此范围暂无用量记录");
    expect(document.querySelector("#usage-trends svg")).toBeNull();
    expect(document.querySelector("[data-trend-plan]")).toBeNull();
    expect(document.querySelector("[data-home-usage=unavailable]")).toBeNull();
  });

  it("keeps known inventory visible and marks usage unknown when its ledger read fails", async () => {
    const fixture = makeFixture({usageSchema: "missing"});
    fixture.db.seedConsoleUser({id: "known-member", email: "known@example.com", role: "user"});
    fixture.db.seedAudits({id: "observed-failure", user_id: "known-member", route_profile_id: "codex.responses", status: "error", created_at: now.toISOString()});
    const {response, document} = await open(fixture, "view=overview&range=30d");
    expect(response.status).toBe(200);
    expect([...document.querySelectorAll("[data-home-summary] strong")].map(node => node.textContent)).toEqual(["1", "0", "0"]);
    const unavailable = document.querySelector('[data-home-usage="unavailable"]')!;
    expect(unavailable.getAttribute("role")).toBe("alert");
    expect(unavailable.textContent).toContain("统计未知");
    expect(unavailable.querySelector("a")?.getAttribute("href")).toBe("/admin?view=overview&range=30d");
    expect(document.querySelector("[data-trend-empty]")).toBeNull();
    expect(document.querySelector("[data-trend-plan]")).toBeNull();
    const failure = document.querySelector('[data-attention="client-failure"] a')!;
    const failureUrl = new URL(failure.getAttribute("href")!, "https://console.invalid");
    expect(failureUrl.searchParams.get("audit_plan")).toBe("codex.responses");
    expect(failureUrl.searchParams.get("audit_result")).toBe("error");
    expect(failureUrl.searchParams.get("audit_from")).toBe("2026-06-24");
    expect(failureUrl.searchParams.get("audit_to")).toBe("2026-06-24");
  });

  it("changes the quiet-read revision for ledger facts, not a later read clock on the same UTC day", async () => {
    const fixture = makeFixture();
    fixture.db.seedUsage({user_id: "usage-owner", day: "2026-06-24", route_profile_id: "codex.responses", response_model: "first", requests: 1});
    const first = await open(fixture, "view=overview&range=7d");
    const later = await open(fixture, "view=overview&range=7d", new Date("2026-06-24T12:02:00.000Z"));
    const revision = (document: Document) => document.querySelector("main")?.getAttribute("data-console-revision");
    expect(revision(first.document)).toMatch(/^[a-f0-9]{64}$/);
    expect(revision(later.document)).toBe(revision(first.document));
    fixture.db.seedUsage({user_id: "usage-owner", day: "2026-06-24", route_profile_id: "codex.responses", response_model: "second", requests: 1});
    const changed = await open(fixture, "view=overview&range=7d", new Date("2026-06-24T12:04:00.000Z"));
    expect(revision(changed.document)).not.toBe(revision(first.document));
    expect(metric(changed.document.querySelector('[data-trend-plan="codex.responses"]')!, "Requests")).toBe("2");
  });

  it.each(["range=today", "range=all", "range=7d&range=30d", "range=7d&day=2026-06-24"])("rejects %s before trying an unavailable usage read", async query => {
    const fixture = makeFixture({usageSchema: "missing"});
    const {response, document} = await open(fixture, `view=overview&${query}`);
    expect(response.status).toBe(400);
    expect(document.querySelector('[data-home-usage="unavailable"]')).toBeNull();
    expect(document.querySelector('[data-dashboard-unavailable]')).toBeNull();
    expect(document.querySelector('a[href="/admin"]')?.textContent).toBe("打开默认页面");
  });
});
