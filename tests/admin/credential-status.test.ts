import { describe, expect, it, onTestFinished, vi } from "vitest";
import { createConsoleSession } from "../../src/auth/console-session";
import { handleRequest } from "../../src/router";
import { createTestD1 } from "../support/sqlite-d1";

const now = new Date("2026-10-06T12:00:00.000Z");
const origin = "https://admin.example.test";
interface StatusPayload {
  actorId: string;
  accounts: Array<{ key: string; state: string; statusLabel: string; tone: string; hint: string | null; expiresAt: string | null; lastRefreshAt: string | null }>;
  revision: string;
}
interface FailurePayload { error: { code: string } }

async function fixture() {
  let metadataFailure = false;
  let atMetadataRead: (() => void) | undefined;
  const db = createTestD1({ onPrepare: sql => {
    if (!sql.includes("SELECT 'codex:' || id AS key")) return;
    atMetadataRead?.();
    if (metadataFailure) throw new Error("Synthetic metadata read failure");
  } });
  onTestFinished(() => db.close());
  const providerFetch = vi.fn(async () => { throw new Error("Status must not probe a provider"); });
  const authority = {
    idFromName: vi.fn(() => { throw new Error("Status must not read provider secrets"); }),
    get: vi.fn(() => { throw new Error("Status must not read provider secrets"); })
  };
  const env = {
    DB: db.binding, ADMIN_DASHBOARD_HOST: "admin.example.test", CONSOLE_EMAIL_DOMAIN: "example.test",
    API_KEY_HASH_PEPPER: "synthetic-status-pepper", ADMIN_SECRET: "synthetic-operator",
    TOKEN_AUTHORITY: authority
  } as unknown as Env;
  for (const [id, role] of [["status-admin", "admin"], ["status-member", "user"]] as const) {
    db.sqlite.prepare(`INSERT INTO users
      (id,email,canonical_email,role,status,account_kind,login_capable,created_at,updated_at)
      VALUES (?,?,?,?,'active','human',1,?,?)`).run(id, `${id}@example.test`, `${id}@example.test`, role, now.toISOString(), now.toISOString());
  }
  const cookie = async (id: string) => createConsoleSession(env, { id, email: `${id}@example.test`, sessionEpoch: 0 }, now);
  const admin = await cookie("status-admin");
  const member = await cookie("status-member");
  const read = (token: string | null = admin, input: { method?: string; host?: string; headers?: HeadersInit } = {}) => {
    const headers = new Headers(input.headers);
    headers.set("Accept", "application/json");
    if (token) headers.set("Cookie", `__Host-mini-console=${token}`);
    return handleRequest(new Request(`${input.host ?? origin}/admin/credential-status?actorId=spoofed`, { method: input.method ?? "GET", headers }),
      env, { waitUntil: () => {} }, { now: () => now, fetch: providerFetch });
  };
  const seed = (id: string, status: string, expires: string | null = null, provider: "codex" | "grok" = "codex", lastRefresh: string | null = null) => {
    if (provider === "codex") db.sqlite.prepare(`INSERT INTO codex_auths
      (id,kind,label,environment,status,expires_at,last_refresh_at,created_at,updated_at)
      VALUES (?,'shared','Private account label','production',?,?,?,?,?)`).run(id, status, expires, lastRefresh, now.toISOString(), now.toISOString());
    else db.sqlite.prepare(`INSERT INTO subscription_accounts
      (id,capability_source,environment,label,status,expires_at,last_refresh_at,created_at,updated_at)
      VALUES (?,'grok','production','Private account label',?,?,?,?,?)`).run(id, status, expires, lastRefresh, now.toISOString(), now.toISOString());
  };
  return { db, env, admin, member, read, seed, providerFetch, authority,
    failMetadata: () => { metadataFailure = true; },
    recover: () => { metadataFailure = false; atMetadataRead = undefined; },
    duringMetadata: (action: () => void) => { atMetadataRead = action; } };
}

describe("administrator credential status metadata", () => {
  it("projects only stored state and the current actor without provider or secret reads", async () => {
    const f = await fixture();
    f.seed("collision", "active", "2026-10-07T12:00:00.000Z", "codex", "2026-10-06T11:30:00.000Z");
    f.seed("collision", "reauth_required", null, "grok", "2026-10-06T11:25:00.000Z");
    f.seed("pending", "pending_credential");
    f.seed("expired", "active", now.toISOString());
    f.seed("soon", "active", "2026-10-06T12:05:00.000Z");
    f.seed("revoked", "disabled");
    f.seed("legacy", "refresh_error");
    const response = await f.read();
    const body = await response.json() as StatusPayload;
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(Object.keys(body).sort()).toEqual(["accounts", "actorId", "revision"]);
    expect(body.actorId).toBe("status-admin");
    expect(body.accounts).toEqual([
      { key: "codex:collision", state: "active", statusLabel: "已连接", tone: "ok", hint: null, expiresAt: "2026-10-07T12:00:00.000Z", lastRefreshAt: "2026-10-06T11:30:00.000Z" },
      { key: "codex:expired", state: "expired", statusLabel: "访问已过期", tone: "bad", hint: null, expiresAt: now.toISOString(), lastRefreshAt: null },
      { key: "codex:legacy", state: "degraded", statusLabel: "需要处理", tone: "bad", hint: "先刷新账号。刷新失败时，再重新连接。", expiresAt: null, lastRefreshAt: null },
      { key: "codex:pending", state: "absent", statusLabel: "未连接", tone: "neutral", hint: null, expiresAt: null, lastRefreshAt: null },
      { key: "codex:revoked", state: "revoked", statusLabel: "已断开", tone: "neutral", hint: null, expiresAt: null, lastRefreshAt: null },
      { key: "codex:soon", state: "expiring_soon", statusLabel: "即将过期", tone: "warn", hint: null, expiresAt: "2026-10-06T12:05:00.000Z", lastRefreshAt: null },
      { key: "grok:collision", state: "reauth_required", statusLabel: "需要重新连接", tone: "bad", hint: "请重新登录。登录完成前，客户端不能使用这个账号。", expiresAt: null, lastRefreshAt: "2026-10-06T11:25:00.000Z" }
    ]);
    expect(typeof body.revision).toBe("string");
    const again = await (await f.read()).json() as StatusPayload;
    expect(again.revision === body.revision).toBe(true);
    f.db.sqlite.prepare("UPDATE codex_auths SET status='reauth_required' WHERE id='collision'").run();
    const changed = await (await f.read()).json() as StatusPayload;
    expect(changed.revision === body.revision).toBe(false);
    expect(f.providerFetch.mock.calls.length).toBe(0);
    expect(f.authority.idFromName.mock.calls.length + f.authority.get.mock.calls.length).toBe(0);
  });

  it.each(["codex", "grok"] as const)("updates %s expiry and refresh dates, including date-only revision changes", async provider => {
    const f = await fixture();
    f.seed("dates", "active", "2026-10-07T12:00:00.000Z", provider, "2026-10-06T10:00:00.000Z");
    const initial = await (await f.read()).json() as StatusPayload;
    const table = provider === "codex" ? "codex_auths" : "subscription_accounts";
    const expiresAt = "2026-10-08T12:00:00.000Z";
    f.db.sqlite.prepare(`UPDATE ${table} SET expires_at=? WHERE id='dates'`).run(expiresAt);
    const expiryChanged = await (await f.read()).json() as StatusPayload;
    expect(expiryChanged.accounts[0]?.state).toBe("active");
    expect(expiryChanged.accounts[0]?.expiresAt).toBe(expiresAt);
    expect(expiryChanged.revision === initial.revision).toBe(false);
    const lastRefreshAt = "2026-10-06T11:55:00.000Z";
    f.db.sqlite.prepare(`UPDATE ${table} SET last_refresh_at=? WHERE id='dates'`).run(lastRefreshAt);
    const refreshChanged = await (await f.read()).json() as StatusPayload;
    expect(refreshChanged.accounts[0]?.state).toBe("active");
    expect(refreshChanged.accounts[0]?.expiresAt).toBe(expiresAt);
    expect(refreshChanged.accounts[0]?.lastRefreshAt).toBe(lastRefreshAt);
    expect(refreshChanged.revision === expiryChanged.revision).toBe(false);
    expect(Object.keys(refreshChanged.accounts[0]!).sort()).toEqual(["expiresAt", "hint", "key", "lastRefreshAt", "state", "statusLabel", "tone"]);
    expect(f.providerFetch.mock.calls.length).toBe(0);
    expect(f.authority.idFromName.mock.calls.length + f.authority.get.mock.calls.length).toBe(0);
  });

  it("distinguishes a successfully read empty inventory from unavailable metadata", async () => {
    const f = await fixture();
    const empty = await f.read();
    expect(empty.status).toBe(200);
    expect((await empty.json() as StatusPayload).accounts).toEqual([]);
    f.seed("present", "active");
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    onTestFinished(() => log.mockRestore());
    f.failMetadata();
    const failed = await f.read();
    const body = await failed.json() as FailurePayload;
    expect(failed.status).toBe(500);
    expect(Object.keys(body)).toEqual(["error"]);
    expect(body.error.code).toBe("internal_error");
    f.recover();
    const recovered = await f.read();
    expect(recovered.status).toBe(200);
    expect((await recovered.json() as StatusPayload).accounts.map(account => account.key)).toEqual(["codex:present"]);
  });

  it("rejects an oversized inventory instead of publishing a truncated success", async () => {
    const f = await fixture();
    for (let index = 0; index < 1001; index++) f.seed(`account-${index}`, "active");
    const response = await f.read();
    const body = await response.json() as FailurePayload;
    expect(response.status).toBe(503);
    expect(Object.keys(body)).toEqual(["error"]);
    expect(body.error.code).toBe("credential_status_unavailable");
  });

  it("does not treat an unsuccessful D1 result envelope as a successfully empty inventory", async () => {
    const f = await fixture();
    const actual = f.env.DB;
    f.env.DB = new Proxy(actual, { get(target, property) {
      if (property !== "prepare") {
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      }
      return (sql: string) => {
        const statement = target.prepare(sql);
        if (!sql.includes("SELECT 'codex:' || id AS key")) return statement;
        return new Proxy(statement, { get(bound, method) {
          if (method === "all") return async () => ({ ...await bound.all(), success: false });
          const value = Reflect.get(bound, method);
          return typeof value === "function" ? value.bind(bound) : value;
        } });
      };
    } });
    const response = await f.read();
    const body = await response.json() as FailurePayload;
    expect(response.status).toBe(503);
    expect(Object.keys(body)).toEqual(["error"]);
    expect(body.error.code).toBe("credential_status_unavailable");
  });

  it("denies members and sessions missing from the request", async () => {
    const f = await fixture();
    for (const token of [f.member, null]) {
      const response = await f.read(token);
      expect(response.status).toBe(403);
      expect(Object.keys(await response.json() as FailurePayload)).toEqual(["error"]);
    }
    expect(f.providerFetch.mock.calls.length).toBe(0);
  });

  it("does not accept the operator bearer or non-GET reads as browser admin authority", async () => {
    const f = await fixture();
    for (const [response, status] of [
      [await f.read(null, { headers: { Authorization: `Bearer ${f.env.ADMIN_SECRET}` } }), 403],
      [await f.read(null, { host: "https://api.trustedtunnel.app", headers: { Authorization: `Bearer ${f.env.ADMIN_SECRET}` } }), 403],
      [await f.read(f.admin, { method: "POST", headers: { Origin: origin } }), 404]
    ] as const) {
      expect(response.status).toBe(status);
      expect(Object.keys(await response.json() as FailurePayload)).toEqual(["error"]);
    }
  });

  const transitions = ["expired", "demoted", "mailbox-migrated", "disabled"] as const;
  function invalidate(f: Awaited<ReturnType<typeof fixture>>, transition: typeof transitions[number]) {
    if (transition === "expired") f.db.sqlite.prepare("UPDATE console_sessions SET expires_at=? WHERE user_id='status-admin'").run(now.toISOString());
    if (transition === "demoted") f.db.sqlite.prepare("UPDATE users SET role='user' WHERE id='status-admin'").run();
    if (transition === "mailbox-migrated") f.db.sqlite.prepare("UPDATE users SET email='renamed@example.test', canonical_email='renamed@example.test', console_session_epoch=console_session_epoch+1 WHERE id='status-admin'").run();
    if (transition === "disabled") f.db.sqlite.prepare("UPDATE users SET status='disabled', console_session_epoch=console_session_epoch+1 WHERE id='status-admin'").run();
  }

  it.each(transitions)("rejects an already %s session through current SQL authority", async transition => {
    const f = await fixture();
    f.seed("private", "active");
    invalidate(f, transition);
    const response = await f.read();
    expect(response.status).toBe(403);
    expect(Object.keys(await response.json() as FailurePayload)).toEqual(["error"]);
  });

  it.each(transitions)("does not return a captured admin projection after %s during its metadata read", async transition => {
    const f = await fixture();
    f.seed("private", "active");
    f.duringMetadata(() => invalidate(f, transition));
    const response = await f.read();
    const body = await response.json() as FailurePayload;
    expect(response.status).toBe(403);
    expect(Object.keys(body)).toEqual(["error"]);
    expect(body.error.code).toBe("console_identity_changed");
  });
});
