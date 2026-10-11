import { createRequire } from "node:module";
import { build } from "esbuild";
import { expect, it } from "vitest";
import { createConsoleSession } from "../../src/auth/console-session";

// Reuse Wrangler's pinned runtime rather than installing a second workerd.
const { Miniflare, convertV4MiniflareOptions } = createRequire(import.meta.resolve("wrangler/package.json"))("miniflare");

it("upgrades and publishes through real Workers WebSockets and rejects revoked session authority", async () => {
  const compiled = await build({
    stdin: { contents: `import worker from './src/index';
      export { TokenAuthority, CredentialEvents } from './src/index';
      export default { async fetch(request, env, ctx) {
        if (new URL(request.url).pathname === '/fixture-publish') {
          await env.CREDENTIAL_EVENTS.get(env.CREDENTIAL_EVENTS.idFromName(env.ADMIN_DASHBOARD_HOST)).publish();
          return new Response(null, {status:204});
        }
        return worker.fetch(request,env,ctx);
      }};`, resolveDir: process.cwd(), sourcefile: "credential-runtime-fixture.ts" },
    bundle: true, write: false, format: "esm", platform: "browser", external: ["cloudflare:workers", "node:*"],
    define: { "process.env.NODE_ENV": '"production"' }, logLevel: "silent"
  });
  const bindings = {
    ADMIN_DASHBOARD_HOST: "console.example.test", CONSOLE_EMAIL_DOMAIN: "example.test",
    API_KEY_HASH_PEPPER: "runtime-synthetic-pepper", ADMIN_SECRET: "runtime-synthetic-operator",
    TOKEN_ENCRYPTION_KEY_V1: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
    CODEX_EGRESS_BASE_URL: "https://provider.invalid", CODEX_EGRESS_SECRET: "runtime-synthetic-egress",
    CODEX_OAUTH_TOKEN_URL: "https://provider.invalid/token", CODEX_CLIENT_ID: "runtime-synthetic-client",
    FEISHU_APP_ID: "runtime-synthetic-app", FEISHU_APP_SECRET: "runtime-synthetic-secret", REQUEST_AUDIT_RETENTION_DAYS: "7"
  };
  const runtime = new Miniflare(convertV4MiniflareOptions({ modules: true, script: compiled.outputFiles[0]!.text,
    compatibilityDate: "2026-06-24", compatibilityFlags: ["nodejs_compat"], bindings,
    d1Databases: { DB: "runtime-credential-db" }, durableObjects: {
      TOKEN_AUTHORITY: { className: "TokenAuthority", useSQLite: true },
      CREDENTIAL_EVENTS: { className: "CredentialEvents", useSQLite: true }
    }
  }));
  try {
    const database: D1Database = await runtime.getD1Database("DB");
    await database.exec("CREATE TABLE users(id TEXT PRIMARY KEY,canonical_email TEXT,role TEXT,status TEXT,account_kind TEXT,login_capable INTEGER,console_session_epoch INTEGER); CREATE TABLE console_sessions(token_hash TEXT PRIMARY KEY,user_id TEXT,expires_at TEXT,created_at TEXT,session_epoch INTEGER); CREATE TABLE codex_auths(id TEXT PRIMARY KEY,status TEXT,expires_at TEXT,last_refresh_at TEXT,admission_state TEXT NOT NULL DEFAULT 'enabled'); CREATE TABLE subscription_accounts(id TEXT PRIMARY KEY,status TEXT,expires_at TEXT,last_refresh_at TEXT);");
    await database.prepare("INSERT INTO users VALUES('admin','admin@example.test','admin','active','human',1,0)").run();
    await database.prepare("INSERT INTO codex_auths(id,status,expires_at) VALUES('synthetic-account','active',NULL)").run();
    const env = { ...bindings, DB: database } as Env;
    const token = await createConsoleSession(env, { id: "admin", email: "admin@example.test", sessionEpoch: 0 });
    const headers = { Upgrade: "websocket", Origin: "https://console.example.test", Cookie: `__Host-mini-console=${token}` };
    const denied = await runtime.dispatchFetch("https://console.example.test/admin/events/credentials", { headers: { ...headers, Origin: "https://attacker.invalid" } });
    expect(denied.status).toBe(403);
    const response = await runtime.dispatchFetch("https://console.example.test/admin/events/credentials", { headers });
    expect(response.status).toBe(101);
    const socket = response.webSocket;
    expect(Boolean(socket)).toBe(true);
    const messages: string[] = [];
    socket.addEventListener("message", (event: MessageEvent) => { messages.push(String(event.data)); });
    const closed = new Promise<number>(resolve => socket.addEventListener("close", (event: CloseEvent) => resolve(event.code)));
    socket.accept();
    await expect.poll(() => messages.length).toBe(1);
    expect(messages).toEqual(['{"type":"connected"}']);
    await database.prepare("UPDATE codex_auths SET status='reauth_required'").run();
    await runtime.dispatchFetch("https://console.example.test/fixture-publish");
    await expect.poll(() => messages.length).toBe(2);
    expect(messages[1]).toBe('{"type":"credentials-changed"}');
    const status = await runtime.dispatchFetch("https://console.example.test/admin/credential-status", { headers: { Cookie: headers.Cookie, Accept: "application/json" } });
    expect(status.status).toBe(200);
    expect((await status.json()).accounts[0].state).toBe("reauth_required");
    await database.prepare("UPDATE users SET role='user'").run();
    await runtime.dispatchFetch("https://console.example.test/fixture-publish");
    expect(await closed).toBe(4403);
    expect(messages).toHaveLength(2);
    const reconnect = await runtime.dispatchFetch("https://console.example.test/admin/events/credentials", { headers });
    expect(reconnect.status).toBe(403);
  } finally { await runtime.dispose(); }
}, 20000);
