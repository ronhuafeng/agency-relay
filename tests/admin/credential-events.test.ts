import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { CredentialEvents } from "../../src/admin/credential-events";
import { createConsoleSession } from "../../src/auth/console-session";
import { hmacSha256Hex } from "../../src/crypto";
import { createTestD1 } from "../support/sqlite-d1";

const now = new Date("2026-10-06T12:00:00.000Z");

// This seam models handler effects. It does not emulate WebSocket upgrade,
// hibernation, RPC transport or the runtime's asynchronous close handshake.
class Socket {
  readonly messages: unknown[] = [];
  readonly closes: number[] = [];
  failSend = false;
  constructor(private readonly attachment: unknown) {}
  deserializeAttachment() { return this.attachment; }
  send(message: string) {
    if (this.failSend) throw new Error("Synthetic closed transport");
    this.messages.push(JSON.parse(message));
  }
  close(code: number) { this.closes.push(code); }
  get webSocket() { return this as unknown as WebSocket; }
}

function fixture() {
  let authorityFailure = false;
  const db = createTestD1({ onPrepare: sql => {
    if (authorityFailure && sql.includes("FROM console_sessions AS s JOIN users AS u")) throw new Error("Synthetic authority read failure");
  } });
  onTestFinished(() => db.close());
  const providerFetch = vi.fn(async () => { throw new Error("Invalidation must not probe a provider"); });
  vi.stubGlobal("fetch", providerFetch);
  onTestFinished(() => { vi.unstubAllGlobals(); });
  const authority = {
    idFromName: vi.fn(() => { throw new Error("Invalidation must not read provider secrets"); }),
    get: vi.fn(() => { throw new Error("Invalidation must not read provider secrets"); })
  };
  const env = { DB: db.binding, CONSOLE_EMAIL_DOMAIN: "example.test", API_KEY_HASH_PEPPER: "synthetic-events-pepper", TOKEN_AUTHORITY: authority } as unknown as Env;
  const sockets: Socket[] = [];
  const storage = {
    alarmAt: null as number | null,
    async getAlarm() { return this.alarmAt; },
    async setAlarm(at: number | Date) { this.alarmAt = Number(at); },
    async deleteAlarm() { this.alarmAt = null; }
  };
  const ctx = { storage, getWebSockets: () => sockets.filter(socket => socket.closes.length === 0).map(socket => socket.webSocket) };
  const events = new CredentialEvents(ctx as unknown as DurableObjectState, env);
  const subscribe = async (id: string, role: "admin" | "user" = "admin", actorId = id) => {
    db.sqlite.prepare(`INSERT INTO users
      (id,email,canonical_email,role,status,account_kind,login_capable,created_at,updated_at)
      VALUES (?,?,?,?,'active','human',1,?,?)`).run(id, `${id}@example.test`, `${id}@example.test`, role, now.toISOString(), now.toISOString());
    const token = await createConsoleSession(env, { id, email: `${id}@example.test`, sessionEpoch: 0 }, now);
    const sessionHash = await hmacSha256Hex(env.API_KEY_HASH_PEPPER, token);
    const socket = new Socket({ sessionHash, actorId });
    sockets.push(socket);
    return { socket, sessionHash };
  };
  return { db, events, sockets, storage, subscribe, providerFetch, authority,
    failAuthority: () => { authorityFailure = true; } };
}

beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(now); });
afterEach(() => vi.useRealTimers());

describe("credential invalidation handler SQL authority", () => {
  it("sends only generic invalidation to current administrators, never account or session metadata", async () => {
    const f = fixture();
    const admin = await f.subscribe("current-admin");
    const member = await f.subscribe("current-member", "user");
    await f.events.publish();
    expect(admin.socket.messages).toEqual([{ type: "credentials-changed" }]);
    expect(admin.socket.closes).toEqual([]);
    expect(member.socket.messages).toEqual([]);
    expect(member.socket.closes).toEqual([4403]);
    expect(f.providerFetch.mock.calls.length).toBe(0);
    expect(f.authority.idFromName.mock.calls.length + f.authority.get.mock.calls.length).toBe(0);
  });

  it.each(["demoted", "expired", "mailbox-migrated", "disabled", "session-deleted", "actor-mismatch"] as const)("closes a %s subscriber while another admin still receives invalidation", async transition => {
    const f = fixture();
    const stale = await f.subscribe("former-admin", "admin", transition === "actor-mismatch" ? "another-actor" : "former-admin");
    const current = await f.subscribe("current-admin");
    if (transition === "demoted") f.db.sqlite.prepare("UPDATE users SET role='user' WHERE id='former-admin'").run();
    if (transition === "expired") f.db.sqlite.prepare("UPDATE console_sessions SET expires_at=? WHERE user_id='former-admin'").run(now.toISOString());
    if (transition === "mailbox-migrated") f.db.sqlite.prepare("UPDATE users SET email='renamed@example.test',canonical_email='renamed@example.test',console_session_epoch=console_session_epoch+1 WHERE id='former-admin'").run();
    if (transition === "disabled") f.db.sqlite.prepare("UPDATE users SET status='disabled',console_session_epoch=console_session_epoch+1 WHERE id='former-admin'").run();
    if (transition === "session-deleted") f.db.sqlite.prepare("DELETE FROM console_sessions WHERE user_id='former-admin'").run();
    await f.events.publish();
    expect(stale.socket.messages).toEqual([]);
    expect(stale.socket.closes).toEqual([4403]);
    expect(current.socket.messages).toEqual([{ type: "credentials-changed" }]);
    expect(current.socket.closes).toEqual([]);
  });

  it("fails closed for every socket when current session authority cannot be read", async () => {
    const f = fixture();
    const one = await f.subscribe("admin-one");
    const two = await f.subscribe("admin-two");
    f.failAuthority();
    await f.events.publish();
    for (const subscriber of [one, two]) {
      expect(subscriber.socket.messages).toEqual([]);
      expect(subscriber.socket.closes).toEqual([1011]);
    }
  });

  it("rechecks authority on alarms without publishing and schedules only for remaining connections", async () => {
    const f = fixture();
    const former = await f.subscribe("former-admin");
    const current = await f.subscribe("current-admin");
    f.db.sqlite.prepare("UPDATE users SET role='user' WHERE id='former-admin'").run();
    await f.events.alarm();
    expect(former.socket.closes).toEqual([4403]);
    expect(current.socket.closes).toEqual([]);
    expect(f.sockets.flatMap(socket => socket.messages)).toEqual([]);
    expect(f.storage.alarmAt).toBe(now.getTime() + 60_000);
    f.storage.alarmAt = null; // The seam delivers the scheduled alarm.
    vi.setSystemTime(new Date(now.getTime() + 8 * 60 * 60 * 1000));
    await f.events.alarm();
    expect(current.socket.closes).toEqual([4403]);
    expect(f.storage.alarmAt).toBeNull();
  });

  it("does not postpone an already earlier authority check", async () => {
    const f = fixture();
    await f.subscribe("current-admin");
    f.storage.alarmAt = now.getTime() + 30_000;
    await f.events.alarm();
    expect(f.storage.alarmAt).toBe(now.getTime() + 30_000);
  });

  it.each(["refresh", "credentials-changed"])("a browser %s message cannot perform or trigger a credential mutation", async type => {
    const f = fixture();
    const sender = await f.subscribe("current-admin");
    const observer = await f.subscribe("other-admin");
    f.db.sqlite.prepare(`INSERT INTO codex_auths(id,kind,status,created_at,updated_at)
      VALUES ('protected-account','shared','reauth_required',?,?)`).run(now.toISOString(), now.toISOString());
    await Reflect.apply(f.events.webSocketMessage, f.events, [sender.socket.webSocket, JSON.stringify({ type, account: "protected-account" })]);
    expect(sender.socket.closes).toEqual([1008]);
    expect(sender.socket.messages).toEqual([]);
    expect(observer.socket.messages).toEqual([]);
    expect(f.db.sqlite.prepare("SELECT id,status FROM codex_auths").all()).toEqual([{ id: "protected-account", status: "reauth_required" }]);
    expect(f.db.sqlite.prepare("SELECT COUNT(*) AS count FROM operator_mutation_audit").get()).toEqual({ count: 0 });
    expect(f.providerFetch.mock.calls.length).toBe(0);
    expect(f.authority.idFromName.mock.calls.length + f.authority.get.mock.calls.length).toBe(0);
  });

  it("isolates a send failure without preventing another authorized subscriber from receiving the event", async () => {
    const f = fixture();
    const closed = await f.subscribe("closed-transport");
    const current = await f.subscribe("current-admin");
    closed.socket.failSend = true;
    await f.events.publish();
    expect(closed.socket.closes).toEqual([1011]);
    expect(current.socket.messages).toEqual([{ type: "credentials-changed" }]);
  });

  it("rejects invalid handshake methods, unauthenticated subscribers and members before upgrade", async () => {
    const f = fixture();
    const member = await f.subscribe("current-member", "user");
    const requests = [
      [new Request("https://credential-events.internal/"), 426],
      [new Request("https://credential-events.internal/", { method: "POST", headers: { Upgrade: "websocket" } }), 426],
      [new Request("https://credential-events.internal/", { headers: { Upgrade: "websocket", "X-Mini-Session-Hash": "invalid" } }), 403],
      [new Request("https://credential-events.internal/", { headers: { Upgrade: "websocket", "X-Mini-Session-Hash": member.sessionHash } }), 403]
    ] as const;
    for (const [request, status] of requests) expect((await f.events.fetch(request)).status).toBe(status);
  });
});
