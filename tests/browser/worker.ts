import { createServer as createHttpServer, type OutgoingHttpHeaders } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { connect, type Socket } from "node:net";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { build } from "esbuild";
import { pathToFileURL } from "node:url";
import { commitServiceAccount } from "../../src/auth/service-accounts";
import { commitServiceOwner } from "../../src/auth/service-delegation";
import { createConsoleSession } from "../../src/auth/console-session";
import { commitUserEmail, resolveConsolePrincipal } from "../../src/auth/principal";
import { createTestD1 } from "../support/sqlite-d1";

export const ORIGIN = "https://console.mini.test";
export const ATTACKER_ORIGIN = "https://attacker.mini.test";
export const NOW = "2026-06-24T12:00:00.000Z";
export type Identity = "member" | "admin" | "other" | "backup";
interface RequestMatch { method?: string; path?: string; view?: string }
interface Deferred { promise: Promise<void>; resolve(): void }
function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

type ConsoleHandler = (typeof import("../../src/router"))["handleRequest"];
let consoleHandler: Promise<ConsoleHandler> | null = null;

/** Reuse immutable code in this process. Unique bundle URLs retain a complete
 * ESM module and Playwright transform in memory even after their files are removed. */
function loadConsoleHandler(): Promise<ConsoleHandler> {
  return consoleHandler ??= (async () => {
    mkdirSync("tmp", { recursive: true });
    const directory = mkdtempSync(join(process.cwd(), "tmp/mini-browser-module-"));
    const entry = join(directory, "worker.mjs");
    try {
      await build({ entryPoints: ["src/router.ts"], outfile: entry, bundle: true, platform: "node", format: "esm", packages: "external", define: { "process.env.NODE_ENV": '"production"' }, logLevel: "silent" });
      const module = await import(pathToFileURL(entry).href) as typeof import("../../src/router");
      return module.handleRequest;
    } finally { rmSync(directory, { recursive: true, force: true }); }
  })();
}

/** Real Mini routes, SSR, generated assets and SQL. Only external authority is replaced.
 * This is a Node request adapter, not evidence of deployed D1/Feishu/Workers behavior. */
export async function startConsoleWorker(options: { measure?: boolean } = {}) {
  const timings: Array<{ kind: "html" | "script" | "other"; handlerMs: number }> = [];
  mkdirSync("tmp", { recursive: true });
  const handleRequest = await loadConsoleHandler();
  const directory = mkdtempSync(join(process.cwd(), "tmp/mini-browser-"));
  let memberReadFailure: "quota" | "defaults" | "inventory" | "usage" | null = null;
  let quotaLayoutReadsUntilFailure: number | null = null;
  let credentialCleanupFails = false;
  const credentialCleanupCalls: string[] = [];
  const db = createTestD1({onPrepare: sql => {
    if (quotaLayoutReadsUntilFailure !== null && sql.includes("SELECT surface_grant, monthly_allowance") && sql.includes("ORDER BY surface_grant") && quotaLayoutReadsUntilFailure-- <= 0) throw new Error("synthetic quota layout read failure");
    if (memberReadFailure === "usage" && /usage_daily/.test(sql)
      || memberReadFailure === "quota" && sql.startsWith("WITH surfaces")
      || memberReadFailure === "defaults" && sql === "SELECT surface_grant, codex_auth_id, subscription_account_id FROM organization_surface_credential_defaults"
      || memberReadFailure === "inventory" && sql.includes("u.status AS owner_status")) throw new Error("synthetic member read failure");
  }});
  db.sqlite.exec("PRAGMA foreign_keys = ON");
  const unexpected: string[] = [];
  const requests: Array<{ method: string; path: string; view: string | null; cookiePresent: boolean; authorizationPresent: boolean; origin: string | null; fetchSite: string | null }> = [];
  const gates: Array<{ match: RequestMatch; entered: Deferred; release: Deferred; status?: number; used: boolean; disconnect?: boolean }> = [];
  const sockets = new Set<Socket>();
  let clock = new Date(NOW);
  let codexRefreshFailure: "reauth_required" | "codex_token_refresh_failed" | "missing_access_token" | null = null;
  let loginIdentity: Identity | null = null;
  const env: Env = {
    DB: db.binding,
    ADMIN_DASHBOARD_HOST: new URL(ORIGIN).hostname,
    CONSOLE_EMAIL_DOMAIN: "example.test",
    API_KEY_HASH_PEPPER: "browser-fixture-pepper-not-for-production",
    TOKEN_ENCRYPTION_KEY_V1: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
    ADMIN_SECRET: "browser-fixture-operator-not-for-production",
    CODEX_EGRESS_SECRET: "browser-fixture-egress-not-for-production",
    CODEX_EGRESS_BASE_URL: "https://provider.invalid",
    CODEX_OAUTH_TOKEN_URL: "https://provider.invalid/token",
    CODEX_CLIENT_ID: "synthetic-browser-client",
    FEISHU_APP_ID: "synthetic-browser-app",
    FEISHU_APP_SECRET: "synthetic-browser-secret",
    REQUEST_AUDIT_RETENTION_DAYS: "7",
    CREDENTIAL_EVENTS: undefined as unknown as Env["CREDENTIAL_EVENTS"],
    TOKEN_AUTHORITY: {
      idFromName: (name: string) => name,
      get: (id: string) => ({
        getFreshAccessToken: async () => ({ ok: true as const, value: { access_token: "synthetic-provider-token-never-sent" } }),
        revokeSubscription: async () => {
          credentialCleanupCalls.push(String(id));
          if (credentialCleanupFails) throw new Error("Synthetic credential cleanup unavailable");
        },
        refreshNow: async () => {
          if (codexRefreshFailure === "reauth_required") db.sqlite.exec("UPDATE codex_auths SET status = 'reauth_required' WHERE id = 'fixture-codex'");
          return codexRefreshFailure
            ? { ok: false, error: { source: "provider", status: codexRefreshFailure === "reauth_required" ? 401 : 502, code: codexRefreshFailure } }
            : { ok: true, value: { auth_id: "fixture-codex", refresh_available: true } };
        }
      })
    } as unknown as Env["TOKEN_AUTHORITY"]
  };
  for (const identity of ["member", "admin", "other", "backup"] as const) {
    db.sqlite.prepare(`INSERT INTO users (id, email, canonical_email, login_capable, account_kind, role, status, created_at, updated_at)
      VALUES (?, ?, ?, 1, 'human', ?, 'active', ?, ?)`).run(identity, `${identity}@example.test`, `${identity}@example.test`, ["admin", "backup"].includes(identity) ? "admin" : "user", NOW, NOW);
  }
  for (let index = 0; index < 18; index++) {
    const id = `person-${String(index).padStart(2, "0")}`;
    db.sqlite.prepare(`INSERT INTO users (id, email, canonical_email, login_capable, account_kind, role, status, created_at, updated_at)
      VALUES (?, ?, ?, 1, 'human', 'user', 'active', ?, ?)`).run(id, `${id}@example.test`, `${id}@example.test`, NOW, NOW);
  }
  db.sqlite.prepare(`INSERT INTO codex_auths (id, kind, label, environment, status, created_at, updated_at)
    VALUES ('fixture-codex', 'shared', 'Synthetic Codex', 'production', 'active', ?, ?)`).run(NOW, NOW);
  db.sqlite.prepare(`INSERT INTO organization_surface_credential_defaults
    (surface_grant, codex_auth_id, subscription_account_id, created_at, updated_at)
    VALUES ('surface:codex:production', 'fixture-codex', NULL, ?, ?)`).run(NOW, NOW);
  db.sqlite.exec("UPDATE organization_surface_credit_defaults SET monthly_allowance = 100 WHERE surface_grant = 'surface:codex:production'");
  // Invalid display-only key material: these rows cannot authenticate a client.
  for (const owner of ["member", "other"]) {
    db.sqlite.prepare(`INSERT INTO api_keys (id, user_id, key_prefix, key_hash, status, scopes, name, family_id, expires_at, created_at)
      VALUES (?, ?, ?, 'not-a-key-hash', 'active', '["surface:codex:production"]', ?, ?, '2026-09-01T00:00:00.000Z', ?)`)
      .run(`${owner}-key`, owner, `display_${owner}`, `${owner} workstation`, `${owner}-family`, NOW);
    db.sqlite.prepare(`INSERT INTO api_key_surface_credentials (api_key_id, surface_grant, codex_auth_id, created_at, updated_at)
      VALUES (?, 'surface:codex:production', 'fixture-codex', ?, ?)`).run(`${owner}-key`, NOW, NOW);
  }
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
    "-subj", "/CN=console.mini.test", "-addext", "subjectAltName=DNS:console.mini.test,DNS:attacker.mini.test",
    "-keyout", join(directory, "localhost.key"), "-out", join(directory, "localhost.crt")], { stdio: "ignore" });
  const server = createHttpsServer({ key: readFileSync(join(directory, "localhost.key")), cert: readFileSync(join(directory, "localhost.crt")) }, async (incoming, outgoing) => {
    try {
      if (incoming.headers.host === new URL(ATTACKER_ORIGIN).host && incoming.method === "GET" && incoming.url === "/") {
        // A controlled same-site but cross-origin attacker uses a real browser form.
        // It receives no console cookie; only the actual target receives its host-only cookie.
        outgoing.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store",
          "Content-Security-Policy": `default-src 'none'; form-action ${ORIGIN}; base-uri 'none'` });
        outgoing.end(`<form method="post" action="${ORIGIN}/me/ui/keys/member-key/revoke"><button type="submit">Attempt foreign-origin revoke</button></form>`);
        return;
      }
      if (incoming.headers.host !== new URL(ORIGIN).host) { outgoing.writeHead(421).end(); return; }
      const url = new URL(incoming.url ?? "/", ORIGIN);
      const method = incoming.method ?? "GET";
      requests.push({ method, path: url.pathname, view: url.searchParams.get("view"), cookiePresent: Boolean(incoming.headers.cookie), authorizationPresent: Boolean(incoming.headers.authorization), origin: typeof incoming.headers.origin === "string" ? incoming.headers.origin : null, fetchSite: typeof incoming.headers["sec-fetch-site"] === "string" ? incoming.headers["sec-fetch-site"] : null });
      const chunks: Buffer[] = [];
      for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
      const headers = new Headers();
      for (const [name, value] of Object.entries(incoming.headers)) {
        if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(", ") : value);
      }
      const body = Buffer.concat(chunks);
      const request = new Request(url, { method, headers, ...(body.length ? { body } : {}) });
      const handlerStart = performance.now();
      const response = await handleRequest(request, env, { waitUntil: (promise) => { void promise.catch(() => unexpected.push("background failure")); } }, {
        now: () => new Date(clock),
        fetch: async (input) => {
          // Explicit synthetic IdP responses for the Mini callback boundary only.
          // No actual Feishu or provider network is contacted.
          if (loginIdentity && String(input) === "https://accounts.feishu.cn/oauth/v3/token") return Response.json({access_token: "fixture-login-token"});
          if (loginIdentity && String(input) === "https://open.feishu.cn/open-apis/authen/v1/user_info") {
            const email = `${loginIdentity}@example.test`; loginIdentity = null;
            return Response.json({code: 0, data: {email, tenant_key: "fixture-tenant"}});
          }
          unexpected.push("external provider request"); throw new Error("External provider network disabled in browser fixture");
        }
      });
      if (options.measure) {
        const contentType = response.headers.get("Content-Type") ?? "";
        timings.push({ kind: contentType.includes("text/html") ? "html" : contentType.includes("javascript") ? "script" : "other", handlerMs: performance.now() - handlerStart });
      }
      const gate = gates.find((candidate) => !candidate.used
        && (!candidate.match.method || candidate.match.method === method)
        && (!candidate.match.path || candidate.match.path === url.pathname)
        && (!candidate.match.view || candidate.match.view === url.searchParams.get("view")));
      if (gate) { gate.used = true; gate.entered.resolve(); await gate.release.promise; }
      if (gate?.disconnect) { outgoing.destroy(); return; }
      const responseHeaders = new Headers(response.headers);
      const authorization = responseHeaders.get("Location");
      if (loginIdentity && authorization?.startsWith("https://accounts.feishu.cn/open-apis/authen/v1/authorize?")) {
        // Browser routing does not intercept every redirect hop. Keep this
        // synthetic IdP hop inside loopback, using the real opaque Mini state.
        const state = new URL(authorization).searchParams.get("state")!;
        responseHeaders.set("Location", `${ORIGIN}/login/callback?${new URLSearchParams({state, code: "synthetic-login-code"})}`);
      }
      const responseBody = Buffer.from(await response.arrayBuffer());
      const forwarded: OutgoingHttpHeaders = Object.fromEntries(responseHeaders);
      delete forwarded["set-cookie"];
      const cookies = responseHeaders.getSetCookie();
      if (cookies.length) forwarded["set-cookie"] = cookies;
      outgoing.writeHead(gate?.status ?? response.status, forwarded);
      outgoing.end(responseBody);
    } catch {
      unexpected.push("local Worker adapter failure");
      outgoing.writeHead(500, { "Cache-Control": "no-store" }).end("Local browser fixture failed");
    }
  });
  server.on("connection", (socket) => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fixture listen failed");
  // The transparent tunnel keeps the real canonical HTTPS origin (including cookies,
  // form Origin and redirects), while avoiding privileged port 443 and all DNS/egress.
  const proxy = createHttpServer((_req, res) => { unexpected.push("non-TLS browser request"); res.writeHead(403).end(); });
  proxy.on("connection", (socket) => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
  proxy.on("connect", (req, client, head) => {
    if (![ORIGIN, ATTACKER_ORIGIN].some(origin => req.url === `${new URL(origin).host}:443`)) {
      // Diagnose full-browser background requests with fixed labels only. Every
      // destination remains blocked and still fails the owning fixture check.
      const known: Record<string, string> = {
        'accounts.google.com:443': 'google-account',
        'www.google.com:443': 'google-search',
        'optimizationguide-pa.googleapis.com:443': 'chromium-optimization',
        'content-autofill.googleapis.com:443': 'chromium-autofill',
        'clients2.google.com:443': 'chromium-clients',
        'update.googleapis.com:443': 'chromium-update',
        'safebrowsing.googleapis.com:443': 'chromium-safe-browsing'
      };
      const target = req.url ?? '';
      unexpected.push(`external browser request (${Object.hasOwn(known, target) ? known[target] : 'unclassified'})`);
      client.end("HTTP/1.1 403 Forbidden\r\n\r\n"); return;
    }
    const upstream = connect(address.port, "127.0.0.1", () => { client.write("HTTP/1.1 200 Connection Established\r\n\r\n"); if (head.length) upstream.write(head); client.pipe(upstream); upstream.pipe(client); });
    sockets.add(upstream);
    upstream.on("close", () => sockets.delete(upstream));
    upstream.on("error", () => client.destroy());
    client.on("error", () => upstream.destroy());
  });
  await new Promise<void>((resolve, reject) => { proxy.once("error", reject); proxy.listen(0, "127.0.0.1", resolve); });
  const proxyAddress = proxy.address();
  if (!proxyAddress || typeof proxyAddress === "string") throw new Error("Fixture proxy listen failed");
  return {
    origin: ORIGIN,
    proxy: `http://127.0.0.1:${proxyAddress.port}`,
    unexpected,
    requests,
    timings,
    async session(identity: Identity) {
      const principal = await resolveConsolePrincipal(env, `${identity}@example.test`, clock);
      return createConsoleSession(env, principal, clock);
    },
    async moveMemberMailbox() {
      await commitUserEmail(env, {kind:'admin_secret',userId:null,email:null,role:null,subject:null,requestId:'fixture-mailbox'}, 'member', 'moved@example.test', clock);
    },
    loginAs(identity: Identity) { loginIdentity = identity; },
    setRole(identity: Identity, role: "admin" | "user") { db.sqlite.prepare("UPDATE users SET role = ? WHERE id = ?").run(role, identity); },
    failMemberRead(kind: "quota" | "defaults" | "inventory" | "usage" | null) { memberReadFailure = kind; },
    failCredentialCleanup(value: boolean) { credentialCleanupFails = value; },
    credentialCleanupCalls,
    credentialStatus(id: string) { return db.sqlite.prepare("SELECT status FROM subscription_accounts WHERE id=?").get(id)?.status; },
    credentialBindings() { return db.sqlite.prepare("SELECT api_key_id,surface_grant,subscription_account_id FROM api_key_surface_credentials WHERE api_key_id IN ('task-move','task-keep') ORDER BY api_key_id,surface_grant").all(); },
    credentialDefaults() { return db.sqlite.prepare("SELECT surface_grant,subscription_account_id FROM organization_surface_credential_defaults WHERE surface_grant IN ('surface:grok:production','surface:xai:production') ORDER BY surface_grant").all(); },
    seedCredentialTasks() {
      // Metadata-only accounts and non-authenticating keys. No provider OAuth, token or session import.
      for (const id of ['task-old','task-new']) db.sqlite.prepare(`INSERT INTO subscription_accounts
        (id,capability_source,label,environment,status,refresh_available,created_at,updated_at)
        VALUES (?,'grok',?,'production','active',1,?,?)`).run(id,`Synthetic ${id}`,NOW,NOW);
      for (const surface of ['grok','xai']) db.sqlite.prepare(`INSERT INTO organization_surface_credential_defaults
        (surface_grant,subscription_account_id,created_at,updated_at) VALUES (?,'task-old',?,?)`).run(`surface:${surface}:production`,NOW,NOW);
      for (const id of ['task-move','task-keep']) {
        db.sqlite.prepare(`INSERT INTO api_keys (id,user_id,key_prefix,key_hash,status,scopes,name,family_id,created_at)
          VALUES (?,'member',?,'not-a-key-hash','active','["surface:grok:production","surface:xai:production"]',?,?,?)`).run(id,`display_${id}`,id,`family-${id}`,NOW);
        for (const surface of ['grok','xai']) db.sqlite.prepare(`INSERT INTO api_key_surface_credentials
          (api_key_id,surface_grant,subscription_account_id,created_at,updated_at) VALUES (?,?,'task-old',?,?)`).run(id,`surface:${surface}:production`,NOW,NOW);
      }
    },
    setBoundCredentialStatus(status: "active" | "reauth_required") { db.sqlite.prepare("UPDATE codex_auths SET status = ? WHERE id = 'fixture-codex'").run(status); },
    setBoundCredentialTimes(expiresAt: string | null, lastRefreshAt: string | null) { db.sqlite.prepare("UPDATE codex_auths SET expires_at = ?, last_refresh_at = ? WHERE id = 'fixture-codex'").run(expiresAt, lastRefreshAt); },
    failCodexRefresh(code: "reauth_required" | "codex_token_refresh_failed" | "missing_access_token") { codexRefreshFailure = code; },
    expireKey(id: string) { db.sqlite.prepare("UPDATE api_keys SET expires_at = ? WHERE id = ?").run(new Date(clock.getTime()-1).toISOString(),id); },
    expireSessions() { clock = new Date(new Date(NOW).getTime() + 9 * 60 * 60 * 1000); },
    advanceClock(milliseconds: number) { clock = new Date(clock.getTime() + milliseconds); },
    recordObservedRequest(owner: string = "member") {
      db.sqlite.prepare("UPDATE usage_daily SET requests = requests + 1, ok_requests = ok_requests + 1 WHERE user_id = ? AND route_profile_id = 'grok.production.responses' AND response_model = 'grok-observed-zero'").run(owner);
    },
    countKeys(owner: string = "member") { return Number(db.sqlite.prepare("SELECT count(*) AS count FROM api_keys WHERE user_id = ?").get(owner)?.count); },
    person(email: string) { return db.sqlite.prepare("SELECT id, role, canonical_email, status FROM users WHERE canonical_email = ?").get(email); },
    totalKeys() { return Number(db.sqlite.prepare("SELECT count(*) AS count FROM api_keys").get()?.count); },
    serviceIdentity(id: string) { return db.sqlite.prepare("SELECT id, account_kind, display_name, login_capable, role, status FROM users WHERE id = ?").get(id); },
    serviceCount() { return Number(db.sqlite.prepare("SELECT count(*) AS count FROM users WHERE account_kind = 'service'").get()?.count); },
    async seedDelegatedService() {
      const actor = {kind: "admin_secret" as const, userId: null, email: null, role: null, subject: null, requestId: "fixture-setup"};
      const service = await commitServiceAccount(env, actor, "Nightly build", clock);
      await commitServiceOwner(env, actor, service.id, {owner_user_id: "member", expected_revision: 0}, clock);
      db.sqlite.prepare("DELETE FROM user_surface_credit_modes WHERE user_id = ? AND surface_grant = 'surface:codex:production'").run(service.id);
      db.sqlite.prepare("INSERT INTO user_surface_credit_policies VALUES (?, 'surface:codex:production', 12, ?, ?)").run(service.id, NOW, NOW);
      return service.id;
    },
    setServiceStatus(id: string, status: "active" | "disabled") { db.sqlite.prepare("UPDATE users SET status = ? WHERE id = ? AND account_kind = 'service'").run(status, id); },
    serviceOwner(id: string) { return db.sqlite.prepare("SELECT owner_user_id, revision FROM service_account_owners WHERE service_user_id = ?").get(id); },
    withdrawServiceOwner(id: string) { db.sqlite.prepare("UPDATE service_account_owners SET owner_user_id = NULL, revision = revision + 1 WHERE service_user_id = ?").run(id); },
    seedLegacyService(id: string) {
      db.sqlite.prepare("INSERT INTO users (id,email,status,created_at,updated_at) VALUES (?,NULL,'active',?,?)").run(id, NOW, NOW);
      db.sqlite.prepare("INSERT INTO user_surface_credit_policies (user_id,surface_grant,monthly_allowance,created_at,updated_at) VALUES (?,'surface:codex:production',17,?,?)").run(id,NOW,NOW);
    },
    driftLegacyService(id: string) { db.sqlite.prepare("UPDATE users SET updated_at = '2026-06-25T00:00:00.000Z' WHERE id = ?").run(id); },
    servicePolicy(id: string) { return db.sqlite.prepare("SELECT surface_grant, monthly_allowance FROM user_surface_credit_policies WHERE user_id = ?").all(id); },
    status(id: string) { return db.sqlite.prepare("SELECT status FROM users WHERE id = ?").get(id)?.status; },
    keyMetadata(owner: string = "member") { return db.sqlite.prepare("SELECT id, name, family_id, status, expires_at FROM api_keys WHERE user_id = ? ORDER BY created_at, id").all(owner); },
    keyGrants(id: string): string[] { return JSON.parse(String(db.sqlite.prepare("SELECT scopes FROM api_keys WHERE id = ?").get(id)?.scopes ?? "[]")) as string[]; },
    seedUsageTrends(owner: string = "member") {
      const response = db.sqlite.prepare(`INSERT INTO usage_daily
        (user_id, day, route_profile_id, response_model, requests, ok_requests, error_requests,
         total_tokens, token_measurements, provider_cost_usd_ticks, cost_measurements, first_seen_at, last_seen_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      response.run(owner, "2026-06-24", "grok.production.responses", "grok-observed-zero", 4, 3, 1, 0, 1, 0, 1, NOW, NOW);
      response.run(owner, "2026-06-23", "codex.responses", "codex-unmeasured", 2, 2, 0, 0, 0, 0, 0, NOW, NOW);
      db.sqlite.prepare(`INSERT INTO usage_daily (user_id,day,route_profile_id,response_model,requests,ok_requests,total_tokens,token_measurements,api_equivalent_usd_ticks,api_equivalent_measurements,first_seen_at,last_seen_at)
        VALUES (?,'2026-06-24','codex.responses','gpt-5.5',2,2,110,1,7100000,1,?,?)`).run(owner,NOW,NOW);
      response.run(owner, "2026-05-30", "grok.production.responses", "older-observation", 8, 8, 0, 80, 8, 100, 8, NOW, NOW);
      response.run("other", "2026-06-24", "codex.responses", "other-private-model", 900, 900, 0, 0, 0, 0, 0, NOW, NOW);
      db.sqlite.prepare(`INSERT INTO media_usage_daily
        (user_id, day, route_profile_id, capability, started_jobs, completed_jobs, outputs,
         output_measurements, provider_cost_usd_ticks, cost_measurements, first_seen_at, last_seen_at)
        VALUES (?, '2026-06-24', 'xai.production.images_generations', 'image_generation', 2, 1, 0, 1, 0, 1, ?, ?)`)
        .run(owner, NOW, NOW);
    },
    failQuotaLayoutRead(afterReads: number | null) { quotaLayoutReadsUntilFailure = afterReads; },
    quotaDefault(surface: string) { return db.sqlite.prepare("SELECT monthly_allowance FROM organization_surface_credit_defaults WHERE surface_grant = ?").get(`surface:${surface}:production`)?.monthly_allowance; },
    setQuotaDefault(surface: string, allowance: number) { db.sqlite.prepare("UPDATE organization_surface_credit_defaults SET monthly_allowance = ? WHERE surface_grant = ?").run(allowance, `surface:${surface}:production`); },
    seedRemainingLayouts() {
      // Invalid display-only metadata: no credential is generated or usable.
      db.sqlite.prepare(`INSERT INTO users (id,email,canonical_email,login_capable,account_kind,role,status,created_at,updated_at)
        VALUES ('layout-long',?,?,1,'human','user','active',?,?)`).run('long.person.for.console.layout.and.precise.return@example.test','long.person.for.console.layout.and.precise.return@example.test',NOW,NOW);
      db.sqlite.prepare("UPDATE api_keys SET name=? WHERE id='member-key'").run('长名称工作密钥 Workstation for scoped configuration and review');
    },
    seedSetupOverlap(owner: string, name = "Workstation") {
      // Same-name overlapping family, with invalid display-only key material.
      for (const suffix of ['old','new']) {
        const id = `${owner}-setup-${suffix}`;
        db.sqlite.prepare(`INSERT INTO api_keys (id,user_id,key_prefix,key_hash,status,scopes,name,family_id,expires_at,created_at)
          VALUES (?,?,?,?,'active','["surface:codex:production"]',?,?,'2026-09-01T00:00:00.000Z',?)`)
          .run(id,owner,`display_${owner === "member" ? "member" : "service"}_${suffix}`,`invalid-setup-${id}`,name,`${owner}-setup-family`,NOW);
        db.sqlite.prepare(`INSERT INTO api_key_surface_credentials (api_key_id,surface_grant,codex_auth_id,created_at,updated_at)
          VALUES (?,'surface:codex:production','fixture-codex',?,?)`).run(id,NOW,NOW);
      }
    },
    seedAdminLayouts() {
      // Invalid display-only fixtures. No provider token, OAuth callback or key is generated.
      for (let index = 0; index < 16; index++) db.sqlite.prepare(`INSERT INTO subscription_accounts
        (id,capability_source,label,environment,status,created_at,updated_at) VALUES (?,'grok',?,'production',?,?,?)`)
        .run(index === 0 ? 'fixture-codex' : `layout-${index}`, index === 0 ? 'Synthetic Grok shared identifier' : `Synthetic operations account ${index} 长名称用于验证窄屏重排与对象可读性`, index === 0 ? 'reauth_required' : 'active', NOW, NOW);
      for (let index = 0; index < 105; index++) db.sqlite.prepare(`INSERT INTO operator_mutation_audit
        (id,at,actor_kind,actor_email,actor_role,action,target_type,target_id,result,request_id,meta,created_at)
        VALUES (?,?,'access','display-only-long-operator-address@example.test','admin','credential.grok_refresh','subscription_account','fixture-codex',?,'display-only','{}',?)`)
        .run(`layout-${String(index).padStart(3,'0')}`, NOW, index === 104 ? 'denied' : 'ok', NOW);
    },
    seedRequestHistory() {
      const statement = db.sqlite.prepare(`INSERT INTO request_audit
        (id, request_id, route_profile_id, route, user_id, key_id, codex_auth_id, status,
         upstream_status, error_code, latency_ms, total_tokens, provider_cost_usd_ticks, created_at)
        VALUES (?, 'request-shared', 'codex.responses', '/v1/responses', 'member',
          'member-key', 'fixture-codex', ?, ?, ?, ?, ?, ?, ?)`);
      for (let index = 0; index < 28; index++) statement.run(`history-${String(index).padStart(2, "0")}`,
        index === 27 ? "error" : "ok", index === 27 ? null : 200,
        index === 27 ? "provider_upstream_transport_error" : null,
        index === 27 ? null : 125, index === 27 ? null : 10, null, NOW);
    },
    failRequestHistoryRead() { db.sqlite.exec("ALTER TABLE request_audit RENAME TO unavailable_request_audit"); },
    restoreRequestHistoryRead() { db.sqlite.exec("ALTER TABLE unavailable_request_audit RENAME TO request_audit"); },
    hold(match: RequestMatch) {
      const gate = { match, entered: deferred(), release: deferred(), used: false, status: undefined as number | undefined, disconnect: false };
      gates.push(gate);
      return { entered: gate.entered.promise, release: (status?: number) => { gate.status = status; gate.release.resolve(); }, disconnect: () => { gate.disconnect = true; gate.release.resolve(); } };
    },
    async close() {
      gates.forEach((gate) => gate.release.resolve());
      for (const socket of sockets) socket.destroy();
      await Promise.all([new Promise<void>((resolve) => server.close(() => resolve())), new Promise<void>((resolve) => proxy.close(() => resolve()))]);
      db.close(); rmSync(directory, { recursive: true, force: true });
    }
  };
}
export type ConsoleWorker = Awaited<ReturnType<typeof startConsoleWorker>>;
