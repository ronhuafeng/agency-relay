import { describe, expect, it, onTestFinished, vi } from "vitest";
import { JSDOM } from "jsdom";
import { readRequestHistory, parseRequestHistoryQuery } from "../../src/admin/request-history";
import { createConsoleSession } from "../../src/auth/console-session";
import { handleRequest } from "../../src/router";
import { createTestD1 } from "../support/sqlite-d1";
import { makeFixture } from "../router/fixture";

const at = "2026-06-24T12:00:00.000Z";
function setup() {
  const reads: string[] = [];
  const db = createTestD1({ onPrepare: sql => reads.push(sql) });
  onTestFinished(() => db.close());
  const fixture = makeFixture({ env: { DB: db.binding } });
  for (const id of ["admin", "member", "other"]) db.sqlite.prepare(`INSERT INTO users (id, email, canonical_email, login_capable, account_kind, role, status, created_at, updated_at) VALUES (?, ?, ?, 1, 'human', ?, 'active', ?, ?)`)
    .run(id, `${id}@example.com`, `${id}@example.com`, id === "admin" ? "admin" : "user", at, at);
  db.sqlite.prepare(`INSERT INTO api_keys (id, user_id, key_prefix, key_hash, name, status, scopes, created_at) VALUES ('historical-key', 'other', 'display_only', 'must-not-render-key-hash', 'Renamed workstation', 'active', '[]', ?)`).run(at);
  const seed = (id: string, changes: Record<string, string | number | null> = {}) => {
    const row = { id, request_id: "request-duplicate", route_profile_id: "codex.responses", route: "/v1/responses", user_id: "other", key_id: "historical-key", codex_auth_id: "saved-account", status: "ok", upstream_status: 200, created_at: at, ...changes };
    const fields = Object.keys(row);
    db.sqlite.prepare(`INSERT INTO request_audit (${fields.join(",")}) VALUES (${fields.map(() => "?").join(",")})`).run(...Object.values(row));
  };
  const open = async (path: string, identity = "admin", cookie?: string, accept = "text/html") => {
    const session = cookie ?? await createConsoleSession(fixture.env, { id: identity, email: `${identity}@example.com`, sessionEpoch: 0 }, new Date(at));
    return handleRequest(new Request(`https://admin.example.test${path}`, { headers: { Cookie: `__Host-mini-console=${session}`, Accept: accept } }), fixture.env, fixture.ctx, { ...fixture.deps, now: () => new Date(at) });
  };
  return { ...fixture, db, reads, seed, open, url: (query = "") => new URL(`https://admin.example.test/admin?view=audit${query}`) };
}

describe("retained request SQL projection", () => {
  it("paginates stable timestamp ties by internal ID and preserves exact filter context", async () => {
    const f = setup();
    for (let n = 0; n < 53; n++) f.seed(`audit-${String(n).padStart(3, "0")}`);
    f.seed("different-service", { route_profile_id: "xai.responses" });
    const first = await readRequestHistory(f.env, f.url("&audit_plan=codex.responses&audit_user=other@example.com&audit_request=request-duplicate&audit_result=ok&audit_from=2026-06-24&audit_to=2026-06-24"));
    expect(first.rows).toHaveLength(25);
    expect(first.rows[0]?.id).toBe("audit-052");
    expect(first.nextUrl).toContain("audit_request=request-duplicate");
    const second = await readRequestHistory(f.env, new URL(first.nextUrl!, f.url()));
    const third = await readRequestHistory(f.env, new URL(second.nextUrl!, f.url()));
    const selectedUrl = new URL(first.nextUrl!, f.url()); selectedUrl.searchParams.set("record", "audit-052");
    const selected = await readRequestHistory(f.env, selectedUrl);
    expect(selected.detail?.id).toBe("audit-052");
    expect(selected.rows.map(row => row.id)).toEqual(second.rows.map(row => row.id));
    expect(selected.previousUrl).toBe(second.previousUrl);
    expect(selected.nextUrl).toBe(second.nextUrl);
    expect(third.rows).toHaveLength(3);
    expect(third.nextUrl).toBeNull();
    expect(new Set([...first.rows, ...second.rows, ...third.rows].map(row => row.id)).size).toBe(53);
    const back = await readRequestHistory(f.env, new URL(second.previousUrl!, f.url()));
    expect(back.rows.map(row => row.id)).toEqual(first.rows.map(row => row.id));
    expect(back.previousUrl).toBeNull();
    expect(f.reads.filter(sql => sql.includes("FROM request_audit a")).every(sql => /LIMIT \?|WHERE a.id = \? LIMIT 1/.test(sql))).toBe(true);
  });

  it("reads the exact audit record despite duplicate correlations, renamed and deleted objects", async () => {
    const f = setup(); f.seed("audit-a", { latency_ms: 42, total_tokens: 0, provider_cost_usd_ticks: 0 }); f.seed("audit-b", { status: "error", upstream_status: null, error_code: "provider_upstream_transport_error" });
    const detail = await readRequestHistory(f.env, f.url("&record=audit-b&audit_request=request-duplicate"));
    expect(detail.detail).toMatchObject({ id: "audit-b", status: "error", requestId: "request-duplicate", latencyMs: null, credentialId: "saved-account", currentKeyName: "Renamed workstation" });
    expect(detail.rows.map(row => row.id)).toEqual(["audit-b", "audit-a"]);
    f.db.sqlite.exec("DELETE FROM api_keys WHERE id = 'historical-key'; UPDATE users SET email = 'renamed@example.com' WHERE id = 'other'");
    const reread = await readRequestHistory(f.env, f.url("&record=audit-a"));
    expect(reread.detail).toMatchObject({ keyId: "historical-key", currentKeyName: null, currentEmail: "renamed@example.com", tokens: 0, costTicks: 0 });
    f.db.sqlite.exec("PRAGMA foreign_keys=OFF; DELETE FROM users WHERE id = 'other'");
    expect((await readRequestHistory(f.env, f.url("&record=audit-a"))).detail).toMatchObject({ userId: "other", currentEmail: null });
    expect(f.reads.filter(sql => sql.includes("FROM request_audit a")).every(sql => !/SELECT \*|credential_defaults|surface_credentials|credit_|codex_auths|subscription_accounts/.test(sql))).toBe(true);
  });

  it("keeps same-label people distinct and rejects unrelated filters without guessing old authority", async () => {
    const f = setup();
    f.db.sqlite.exec("UPDATE users SET email = 'same@example.com' WHERE id IN ('member', 'other')");
    f.seed("audit-member", { user_id: "member", status: "old-verdict", key_id: null, created_at: "2026-06-23T12:00:00.000Z" });
    f.seed("audit-other", { upstream_status: 101, key_id: "missing-key" });
    expect((await readRequestHistory(f.env, f.url("&audit_user=same@example.com"))).rows.map(row => row.id)).toEqual(["audit-other", "audit-member"]);
    expect((await readRequestHistory(f.env, f.url("&audit_user=member"))).rows.map(row => row.id)).toEqual(["audit-member"]);
    expect((await readRequestHistory(f.env, f.url("&audit_result=unknown"))).rows[0]?.status).toBe("unknown");
    expect((await readRequestHistory(f.env, f.url("&audit_from=2026-06-24&audit_result=unknown"))).rows).toEqual([]);
    expect((await readRequestHistory(f.env, f.url("&audit_to=2026-06-22"))).rows).toEqual([]);
    const result = await f.open("/admin?view=audit&record=audit-other");
    expect(await result.text()).toContain("WebSocket 会话完成");
  });

  it("omits forbidden fields and unsafe historical values without inventing missing measurements", async () => {
    const f = setup(); f.seed("audit-old", { route_profile_id: "retired.plan", route: "/v1/files/raw-provider-resource", key_id: null, codex_auth_id: null, upstream_status: null, error_code: "secret-error-contents", request_id: "https://temporary.invalid/token", session_id: "secret-session", response_id: "secret-provider-resource", thread_id: "secret-thread", latency_ms: null, input_tokens: 9, total_tokens: null });
    const history = await readRequestHistory(f.env, f.url("&record=audit-old"));
    expect(history.detail).toMatchObject({ path: null, catalogMethod: null, credentialId: null, tokens: null, inputTokens: 9, latencyMs: null, requestId: null, errorCode: null, unrecognizedError: true });
    expect(JSON.stringify(history)).not.toMatch(/secret-|temporary.invalid|raw-provider-resource|must-not-render/);
    expect(f.reads.find(sql => sql.includes("FROM request_audit a"))).not.toMatch(/session_id|thread_id|response_id|key_hash|upstream_account_id/);
  });

  it("validates bounds, duplicate parameters, dates, directions and filter scopes before SQL", () => {
    const f = setup();
    for (const query of ["&audit_from=2026-02-30", "&audit_from=2026-07-01&audit_to=2026-06-01", "&audit_result=anything", "&record=a&record=b", "&audit_cursor=garbage", "&audit_direction=newer", "&audit_request=cfwd_secret", `&audit_user=${"x".repeat(255)}`]) expect(() => parseRequestHistoryQuery(f.url(query))).toThrow();
    expect(() => parseRequestHistoryQuery(new URL("https://admin.example.test/admin?view=usage&record=a"))).toThrow();
    expect(parseRequestHistoryQuery(f.url("&audit_from=2024-02-29"))).toMatchObject({ from: "2024-02-29" });
  });
});

describe("request history protected router and HTML", () => {
  it("shows independent results and unknown evidence in SSR, preserving detail return context", async () => {
    const f = setup(); f.seed("audit-safe", { latency_ms: null, status: "error", error_code: "response_observation_parse_failed" });
    const response = await f.open("/admin?view=audit&audit_result=error&audit_request=request-duplicate&record=audit-safe");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const html = await response.text(); const doc = new JSDOM(html).window.document;
    expect(doc.querySelector('[data-request-detail="audit-safe"]')).not.toBeNull();
    expect(doc.querySelector('[data-request-record="audit-safe"]')).not.toBeNull();
    expect(doc.querySelector('select[name="audit_result"]')?.getAttribute("name")).toBe("audit_result");
    expect(doc.querySelector('a[aria-label="收起请求详情"]')?.getAttribute("href")).toContain("audit_result=error");
    expect(html).toContain("不单独证明 SSE 终止成功");
    expect(html).toContain("不单独证明客户任务失败");
    expect(html).toContain("请求方法（记录）</dt><dd>未记录");
    expect(html).toContain("记录耗时</dt><dd>未记录");
    expect(html).not.toContain("must-not-render-key-hash");
    expect(f.fetchCalls).toHaveLength(0);
  });

  it("distinguishes missing records, empty results, invalid input and failed reads", async () => {
    const f = setup();
    expect(await (await f.open("/admin?view=audit&record=absent")).text()).toContain("未找到保留记录");
    expect(await (await f.open("/admin?view=audit&audit_request=absent")).text()).toContain("没有符合筛选的保留记录");
    expect((await f.open("/admin?view=audit&audit_from=bad")).status).toBe(400);
    f.db.sqlite.exec("DROP TABLE request_audit");
    const log = vi.spyOn(console, "error").mockImplementation(() => {}); onTestFinished(() => log.mockRestore());
    const failed = await f.open("/admin?view=audit&record=absent");
    expect(failed.status).toBe(503);
    expect(new JSDOM(await failed.text()).window.document.querySelector("[data-dashboard-unavailable]")?.textContent).toContain("当前数据读取失败");
  });

  it.each(["2026-02-30T12:00:00.000Z", "2026-06-24T24:00:00.000Z"])("rejects a normalized cursor instant as invalid input: %s", async timestamp => {
    const f = setup(); f.seed("audit-retained");
    const cursor = btoa(JSON.stringify([timestamp, "audit-retained"])).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
    const path = `/admin?view=audit&audit_cursor=${cursor}&audit_direction=older`;
    expect(() => parseRequestHistoryQuery(new URL(path, "https://admin.example.test"))).toThrow("invalid request history cursor");
    const response = await f.open(path);
    expect(response.status).toBe(400);
    const document = new JSDOM(await response.text()).window.document;
    expect(document.querySelector("[data-dashboard-unavailable]")).toBeNull();
    expect(document.querySelector("[data-request-record]")).toBeNull();
    expect(document.querySelector("h1")?.textContent).toBe("页面参数不正确");
    const recovery = [...document.querySelectorAll("a")].find(link => link.textContent === "打开默认页面");
    expect(recovery?.getAttribute("href")).toBe("/admin");
    expect((await f.open(recovery!.getAttribute("href")!)).status).toBe(200);
  });

  it("rechecks D1 role/status for HTML and JSON Accept deep links and rejects members", async () => {
    const f = setup(); f.seed("audit-private");
    for (const accept of ["text/html", "application/json"]) {
      const denied = await f.open("/admin?view=audit&record=audit-private", "member", undefined, accept);
      expect(denied.status).toBe(404);
      expect(await denied.text()).not.toMatch(/saved-account|audit-private|other@example.com|historical-key/);
    }
    const cookie = await createConsoleSession(f.env, { id: "admin", email: "admin@example.com", sessionEpoch: 0 }, new Date(at));
    f.db.sqlite.exec("UPDATE users SET role='user' WHERE id='admin'");
    expect((await f.open("/admin?view=audit&record=audit-private", "admin", cookie)).status).toBe(404);
    f.db.sqlite.exec("UPDATE users SET role='admin', status='disabled' WHERE id='admin'");
    expect((await f.open("/admin?view=audit&record=audit-private", "admin", cookie, "application/json")).status).toBe(403);
  });
});
