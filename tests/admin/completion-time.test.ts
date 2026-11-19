import { describe, expect, it, onTestFinished, vi } from "vitest";
import { JSDOM } from "jsdom";
import { createConsoleSession } from "../../src/auth/console-session";
import { handleRequest } from "../../src/router";
import { createTestD1 } from "../support/sqlite-d1";
import { makeFixture } from "../router/fixture";

const at = "2026-06-24T12:00:00.000Z";

function setup(onPrepare?: (sql: string) => void) {
  const reads: string[] = [];
  const db = createTestD1({ onPrepare: sql => { reads.push(sql); onPrepare?.(sql); } });
  onTestFinished(() => db.close());
  const fixture = makeFixture({ env: { DB: db.binding } });
  for (const id of ["admin", "member", "other"]) db.sqlite.prepare(`INSERT INTO users (id, email, canonical_email, login_capable, account_kind, role, status, created_at, updated_at) VALUES (?, ?, ?, 1, 'human', ?, 'active', ?, ?)`)
    .run(id, `${id}@example.com`, `${id}@example.com`, id === "admin" ? "admin" : "user", at, at);
  const seed = (id: string, changes: Record<string, string | number | null> = {}) => {
    const row = {
      id, request_id: "request-shared", route_profile_id: "codex.responses", route: "/backend-api/codex/responses",
      user_id: "other", status: "ok", upstream_status: 200, latency_ms: 1000, output_tokens: 10, reasoning_tokens: 0,
      created_at: "2026-06-24T08:00:00.000Z", ...changes
    };
    const fields = Object.keys(row);
    db.sqlite.prepare(`INSERT INTO request_audit (${fields.join(",")}) VALUES (${fields.map(() => "?").join(",")})`).run(...Object.values(row));
  };
  const open = async (path: string) => {
    const session = await createConsoleSession(fixture.env, { id: "admin", email: "admin@example.com", sessionEpoch: 0 }, new Date(at));
    return handleRequest(new Request(`https://admin.example.test${path}`, { headers: { Cookie: `__Host-mini-console=${session}`, Accept: "text/html" } }), fixture.env, fixture.ctx, { ...fixture.deps, now: () => new Date(at) });
  };
  return { db, reads, seed, open };
}

function chart(html: string): Document {
  return new JSDOM(html).window.document;
}

function bucket(document: Document, id: number): Element {
  const node = document.querySelector(`[data-completion-bucket="${id}"]`);
  expect(node).not.toBeNull();
  return node!;
}

describe("request completion-time interval", () => {
  it("plots nearest-rank intervals for a selected Responses plan and leaves short buckets unplotted", async () => {
    const f = setup();
    // Independent nearest-rank oracle for 10 sorted latencies: ranks 3, 5, 8 and 9.
    // The slowest and fastest values are not the plotted ends.
    for (const latency of [1000, 1100, 1200, 1300, 1400, 1500, 1600, 1700, 1800, 9000]) f.seed(`measured-${latency}`, { latency_ms: latency, output_tokens: 10 });
    for (const latency of [100, 200, 300, 400]) f.seed(`short-${latency}`, { latency_ms: latency, output_tokens: 500 });
    f.seed("other-person", { id: "other-person", user_id: "admin", latency_ms: 50, output_tokens: 10 });
    f.seed("other-plan", { id: "other-plan", route_profile_id: "grok.production.responses", latency_ms: 50, output_tokens: 10 });
    f.seed("failed", { id: "failed", status: "error", latency_ms: 50, output_tokens: 10 });
    f.seed("outside", { id: "outside", created_at: "2026-06-23T23:00:00.000Z", latency_ms: 50, output_tokens: 10 });
    f.seed("unmeasured", { id: "unmeasured", output_tokens: null, reasoning_tokens: null, latency_ms: 50 });
    const response = await f.open("/admin?view=audit&audit_plan=codex.responses&audit_user=other@example.com&audit_from=2026-06-24&audit_to=2026-06-24");
    expect(response.status).toBe(200);
    const document = chart(await response.text());
    const section = document.querySelector("[data-completion-chart]");
    expect(section?.getAttribute("data-completion-state")).toBe("ready");
    expect(section?.getAttribute("data-completion-capped")).toBe("false");
    expect(section?.getAttribute("data-completion-window")).toBe("range");
    expect(section?.getAttribute("data-completion-window-start")).toBe("2026-06-24T00:00:00.000Z");
    expect(section?.getAttribute("data-completion-window-end")).toBe("2026-06-25T00:00:00.000Z");
    expect(section?.getAttribute("data-completion-plotted")).toBe("true");
    expect(section?.getAttribute("data-completion-minimum")).toBe("5");
    const ready = bucket(document, 0);
    expect(ready.getAttribute("data-completion-sample")).toBe("ready");
    expect(ready.getAttribute("data-completion-count")).toBe("10");
    expect(ready.getAttribute("data-p25")).toBe("1200");
    expect(ready.getAttribute("data-p50")).toBe("1400");
    expect(ready.getAttribute("data-p75")).toBe("1700");
    expect(ready.getAttribute("data-p90")).toBe("1800");
    expect(ready.textContent).not.toContain("1000");
    expect(ready.textContent).not.toContain("9000");
    expect(document.querySelectorAll(".completion-interval")).toHaveLength(1);
    const insufficient = bucket(document, 1);
    expect(insufficient.getAttribute("data-completion-sample")).toBe("insufficient");
    expect(insufficient.getAttribute("data-completion-count")).toBe("4");
    expect(insufficient.hasAttribute("data-p50")).toBe(false);
    for (const id of [2, 3]) expect(bucket(document, id).getAttribute("data-completion-count")).toBe("0");
    expect(f.reads.some(sql => sql.includes("julianday("))).toBe(false);
    expect(f.reads.some(sql => sql.includes("completion_bucket") && sql.includes("request_audit a"))).toBe(false);
    expect(document.querySelectorAll("[data-request-record]").length).toBeGreaterThan(0);
  });

  it("keeps generated-token boundaries and drops unmeasured or negative rows", async () => {
    const f = setup();
    const rows: Array<[string, Record<string, string | number | null>]> = [
      ["zero", { output_tokens: 0, reasoning_tokens: 0 }],
      ["under", { output_tokens: 199 }],
      ["reasoning-only", { output_tokens: null, reasoning_tokens: 50 }],
      ["boundary-200", { output_tokens: 100, reasoning_tokens: 100 }],
      ["plain-200", { output_tokens: 200 }],
      ["upper-999", { output_tokens: 999 }],
      ["boundary-1000", { output_tokens: 1000 }],
      ["upper-3999", { output_tokens: 3999 }],
      ["boundary-4000", { output_tokens: 4000 }],
      ["negative", { output_tokens: -1 }],
      ["missing-tokens", { output_tokens: null, reasoning_tokens: null }],
      ["missing-latency", { latency_ms: null }],
      ["failed", { status: "error" }]
    ];
    for (const [id, changes] of rows) f.seed(id, changes);
    const response = await f.open("/admin?view=audit&audit_plan=codex.responses&audit_from=2026-06-24&audit_to=2026-06-24");
    const document = chart(await response.text());
    expect(bucket(document, 0).getAttribute("data-completion-count")).toBe("3");
    expect(bucket(document, 1).getAttribute("data-completion-count")).toBe("3");
    expect(bucket(document, 2).getAttribute("data-completion-count")).toBe("2");
    expect(bucket(document, 3).getAttribute("data-completion-count")).toBe("1");
    expect(document.querySelector("[data-completion-plotted]")?.getAttribute("data-completion-plotted")).toBe("false");
    expect(document.querySelector(".completion-interval")).toBeNull();
  });

  it("caps a selected range at the latest 48 UTC hours and anchors a single date", async () => {
    const f = setup();
    for (let index = 0; index < 5; index += 1) f.seed(`recent-${index}`, { latency_ms: 2000 + index * 1000, created_at: "2026-06-23T01:00:00.000Z" });
    for (let index = 0; index < 5; index += 1) f.seed(`old-${index}`, { latency_ms: 100, created_at: "2026-06-22T23:00:00.000Z" });
    const capped = chart(await (await f.open("/admin?view=audit&audit_plan=codex.responses&audit_from=2026-06-01&audit_to=2026-06-24")).text());
    const section = capped.querySelector("[data-completion-chart]");
    expect(section?.getAttribute("data-completion-capped")).toBe("true");
    expect(section?.getAttribute("data-completion-window-start")).toBe("2026-06-23T00:00:00.000Z");
    expect(section?.getAttribute("data-completion-window-end")).toBe("2026-06-25T00:00:00.000Z");
    const cappedBucket = bucket(capped, 0);
    expect(cappedBucket.getAttribute("data-completion-count")).toBe("5");
    expect(cappedBucket.getAttribute("data-p25")).toBe("3000");
    expect(cappedBucket.getAttribute("data-p50")).toBe("4000");
    expect(cappedBucket.getAttribute("data-p75")).toBe("5000");
    expect(cappedBucket.getAttribute("data-p90")).toBe("6000");
    const fromOnly = chart(await (await f.open("/admin?view=audit&audit_plan=codex.responses&audit_from=2026-06-22")).text());
    expect(fromOnly.querySelector("[data-completion-window]")?.getAttribute("data-completion-window")).toBe("from");
    expect(fromOnly.querySelector("[data-completion-capped]")?.getAttribute("data-completion-capped")).toBe("false");
    expect(bucket(fromOnly, 0).getAttribute("data-completion-count")).toBe("10");
    const toOnly = chart(await (await f.open("/admin?view=audit&audit_plan=codex.responses&audit_to=2026-06-22")).text());
    expect(toOnly.querySelector("[data-completion-window-end]")?.getAttribute("data-completion-window-end")).toBe("2026-06-23T00:00:00.000Z");
    expect(bucket(toOnly, 0).getAttribute("data-completion-count")).toBe("5");
    f.seed("within-day", { created_at: "2026-06-24T11:00:00.000Z", latency_ms: 2500 });
    const recent = chart(await (await f.open("/admin?view=audit&audit_plan=codex.responses")).text());
    expect(recent.querySelector("[data-completion-window]")?.getAttribute("data-completion-window")).toBe("recent");
    expect(recent.querySelector("[data-completion-window-start]")?.getAttribute("data-completion-window-start")).toBe("2026-06-23T12:00:00.000Z");
    expect(recent.querySelector("[data-completion-window-end]")?.getAttribute("data-completion-window-end")).toBe("2026-06-24T12:00:00.000Z");
    expect(bucket(recent, 0).getAttribute("data-completion-count")).toBe("1");
  });

  it("does not query for another page, a non-Responses plan, or a filter the interval cannot honor", async () => {
    const f = setup();
    f.seed("one");
    const pages = ["/admin?view=overview", "/admin?view=usage", "/admin?view=surfaces", "/admin?view=audit", "/admin?view=audit&audit_plan=codex.models", "/admin?view=audit&audit_plan=codex.historical.responses", "/admin?view=audit&audit_plan=codex.responses&audit_result=error", "/admin?view=audit&audit_plan=codex.responses&audit_result=unknown", "/admin?view=audit&audit_plan=codex.responses&audit_request=request-shared"];
    const states: Array<string | null> = [];
    for (const path of pages) {
      const response = await f.open(path);
      expect(response.status).toBe(200);
      const document = chart(await response.text());
      states.push(document.querySelector("[data-completion-state]")?.getAttribute("data-completion-state") ?? null);
      if (!path.includes("view=audit")) expect(document.querySelector("[data-request-record], [data-completion-chart]")).toBeNull();
    }
    expect(states).toEqual([null, null, null, "needs-plan", "needs-plan", "needs-plan", "not-applicable", "not-applicable", "not-applicable"]);
    expect(chart(await (await f.open("/admin?view=audit&audit_plan=codex.responses&audit_result=error")).text()).querySelector("[data-completion-reason]")?.getAttribute("data-completion-reason")).toBe("result");
    expect(chart(await (await f.open("/admin?view=audit&audit_plan=codex.responses&audit_request=request-shared")).text()).querySelector("[data-completion-reason]")?.getAttribute("data-completion-reason")).toBe("request");
    expect(f.reads.some(sql => sql.includes("completion_bucket"))).toBe(false);
    const queried = await f.open("/admin?view=audit&audit_plan=grok.production.responses&audit_from=2026-06-24&audit_to=2026-06-24");
    expect(chart(await queried.text()).querySelector("[data-completion-state]")?.getAttribute("data-completion-state")).toBe("ready");
    expect(f.reads.some(sql => sql.includes("completion_bucket") && sql.includes("created_at >=") && sql.includes("created_at <"))).toBe(true);
  });

  it("keeps the request table when only the interval read fails", async () => {
    const f = setup(sql => { if (sql.includes("completion_bucket")) throw new Error("interval unavailable"); });
    f.seed("visible", { request_id: "request-visible" });
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    onTestFinished(() => log.mockRestore());
    const response = await f.open("/admin?view=audit&audit_plan=codex.responses");
    expect(response.status).toBe(200);
    const document = chart(await response.text());
    expect(document.querySelector("[data-completion-state]")?.getAttribute("data-completion-state")).toBe("unavailable");
    expect(document.querySelector("[data-completion-chart] [role=alert]")).not.toBeNull();
    expect(document.querySelector("[data-request-record]")?.getAttribute("data-request-record")).toBe("visible");
    expect(log).toHaveBeenCalled();
  });
});
