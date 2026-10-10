import { createRequire } from "node:module";
import { request as httpRequest } from "node:http";
import { createServer } from "node:net";
import { build } from "esbuild";
import { expect, it } from "vitest";

const { Miniflare, convertV4MiniflareOptions } = createRequire(import.meta.resolve("wrangler/package.json"))("miniflare");

const ISSUER = "https://console.example.test";
const MCP = "https://mcp.example.test";
const OTHER = "https://other.example.test";
const REDIRECT = "http://127.0.0.1:9/callback";
const BROWSER = { Origin: ISSUER, "Sec-Fetch-Site": "same-origin" };

async function challengeFor(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return btoa(String.fromCharCode(...new Uint8Array(digest))).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

async function start(): Promise<{ runtime: { dispatchFetch: typeof fetch; dispose: () => Promise<void> } }> {
  const compiled = await build({
    stdin: {
      contents: `export { RuntimeGrantAuthority } from "./tests/runtime/synthetic-oauth-worker";
        import worker from "./tests/runtime/synthetic-oauth-worker";
        export default worker;`,
      resolveDir: process.cwd(),
      sourcefile: "synthetic-oauth-fixture.ts"
    },
    bundle: true, write: false, format: "esm", platform: "browser", external: ["cloudflare:workers", "node:*"],
    define: { "process.env.NODE_ENV": '"production"' }, logLevel: "silent"
  });
  const runtime = new Miniflare(convertV4MiniflareOptions({
    modules: true, script: compiled.outputFiles[0]!.text, compatibilityDate: "2026-06-24", compatibilityFlags: ["nodejs_compat"],
    bindings: {
      ADMIN_DASHBOARD_HOST: "console.example.test",
      OAUTH_ISSUER_ORIGIN: ISSUER,
      OAUTH_RESOURCE_ORIGIN: MCP,
      OAUTH_OTHER_RESOURCE_ORIGIN: OTHER
    },
    durableObjects: { GRANTS: { className: "RuntimeGrantAuthority", useSQLite: true } }
  }));
  return { runtime };
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

it("rejects a registration body that stops arriving", async () => {
  const port = await freePort();
  const issuer = `http://127.0.0.1:${port}`;
  const compiled = await build({
    stdin: {
      contents: `export { RuntimeGrantAuthority } from "./tests/runtime/synthetic-oauth-worker";
        import worker from "./tests/runtime/synthetic-oauth-worker";
        export default worker;`,
      resolveDir: process.cwd(),
      sourcefile: "synthetic-oauth-stall.ts"
    },
    bundle: true, write: false, format: "esm", platform: "browser", external: ["cloudflare:workers", "node:*"],
    define: { "process.env.NODE_ENV": '"production"' }, logLevel: "silent"
  });
  const runtime = new Miniflare(convertV4MiniflareOptions({
    modules: true, script: compiled.outputFiles[0]!.text, compatibilityDate: "2026-06-24", compatibilityFlags: ["nodejs_compat"],
    host: "127.0.0.1", port,
    bindings: {
      ADMIN_DASHBOARD_HOST: "127.0.0.1",
      OAUTH_ISSUER_ORIGIN: issuer,
      OAUTH_RESOURCE_ORIGIN: MCP,
      OAUTH_OTHER_RESOURCE_ORIGIN: OTHER
    },
    durableObjects: { GRANTS: { className: "RuntimeGrantAuthority", useSQLite: true } }
  }));
  try {
    await runtime.ready;
    const status = await new Promise<number>((resolve, reject) => {
      const fail = setTimeout(() => reject(new Error("registration body was not rejected")), 3000);
      const req = httpRequest({ hostname: "127.0.0.1", port, path: "/register", method: "POST", headers: { "content-type": "application/json", host: `127.0.0.1:${port}` } }, (res) => {
        clearTimeout(fail);
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on("error", (error) => { clearTimeout(fail); reject(error); });
      req.write("{");
    });
    expect(status).toBe(400);
  } finally { await runtime.dispose(); }
}, 10000);

it("measures local storage operations for one authorization and one resource read", async () => {
  const { runtime } = await start();
  try {
    await runtime.dispatchFetch(`${ISSUER}/budget-reset`, { method: "POST", body: "{}" });
    expect((await runtime.dispatchFetch(`${ISSUER}/register`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ redirect_uris: [REDIRECT] }) })).status).toBe(200);
    const verifier = "synthetic-verifier-with-enough-entropy-ok!!";
    const challenge = await challengeFor(verifier);
    const consent = await runtime.dispatchFetch(`${ISSUER}/authorize?response_type=code&redirect_uri=${encodeURIComponent(REDIRECT)}&code_challenge=${challenge}&code_challenge_method=S256&resource=${encodeURIComponent(`${MCP}/mcp`)}&scope=relay.read&state=budget`);
    const consentId = ((await consent.json()) as { consent_id: string }).consent_id;
    const allowed = await runtime.dispatchFetch(`${ISSUER}/consent`, { method: "POST", headers: { "Content-Type": "application/json", ...BROWSER }, body: JSON.stringify({ consent_id: consentId, decision: "allow" }) });
    const code = new URL(((await allowed.json()) as { redirect: string }).redirect).searchParams.get("code");
    const issued = await (await runtime.dispatchFetch(`${ISSUER}/token`, { method: "POST", body: new URLSearchParams({ grant_type: "authorization_code", code: code!, code_verifier: verifier, redirect_uri: REDIRECT, resource: `${MCP}/mcp` }) })).json() as { access_token: string };
    const authorized = ((await (await runtime.dispatchFetch(`${ISSUER}/budget`, { method: "POST", body: "{}" })).json()) as { storage_operations: number }).storage_operations;
    await runtime.dispatchFetch(`${ISSUER}/budget-reset`, { method: "POST", body: "{}" });
    expect((await runtime.dispatchFetch(`${MCP}/mcp`, { method: "POST", headers: { Authorization: `Bearer ${issued.access_token}`, "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }) })).status).toBe(200);
    const read = ((await (await runtime.dispatchFetch(`${ISSUER}/budget`, { method: "POST", body: "{}" })).json()) as { storage_operations: number }).storage_operations;
    expect({ authorized, read }).toEqual({ authorized: 17, read: 2 });
  } finally { await runtime.dispose(); }
}, 20000);

it("keeps authorization-code use atomic and rejects another resource's token", async () => {
  const { runtime } = await start();
  try {
    const crossSite = await runtime.dispatchFetch(`${ISSUER}/register`, {
      method: "POST", headers: { "Content-Type": "application/json", Origin: "https://attacker.invalid", "Sec-Fetch-Site": "cross-site" },
      body: JSON.stringify({ redirect_uris: [REDIRECT] })
    });
    expect(crossSite.status).toBe(200);
    expect((await runtime.dispatchFetch(`${ISSUER}/register`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ redirect_uris: ["http://127.0.0.1:9/other"] }) })).status).toBe(400);
    const oversized = JSON.stringify({ redirect_uris: [REDIRECT], pad: "a".repeat(4096) });
    expect(new TextEncoder().encode(oversized).length).toBeGreaterThan(4096);
    expect((await runtime.dispatchFetch(`${ISSUER}/register`, { method: "POST", headers: { "Content-Type": "application/json" }, body: oversized })).status).toBe(400);
    expect((await runtime.dispatchFetch(`${ISSUER}/register`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ redirect_uris: ["https://evil.example/callback"], client_secret: "not-stored" }) })).status).toBe(400);
    expect((await runtime.dispatchFetch(`${ISSUER}/register`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ redirect_uris: ["https://evil.example/callback"], jwks_uri: "https://evil.example/jwks" }) })).status).toBe(400);
    expect((await runtime.dispatchFetch(`${ISSUER}/register`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ redirect_uris: [REDIRECT], jwks: { keys: [] } }) })).status).toBe(400);
    expect((await runtime.dispatchFetch(`${ISSUER}/register`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ redirect_uris: [REDIRECT, "http://127.0.0.1:9/other"] }) })).status).toBe(400);
    const verifier = "synthetic-verifier-with-enough-entropy-ok!!";
    const challenge = await challengeFor(verifier);
    const deniedConsent = await runtime.dispatchFetch(`${ISSUER}/authorize?response_type=code&redirect_uri=${encodeURIComponent(REDIRECT)}&code_challenge=${challenge}&code_challenge_method=S256&resource=${encodeURIComponent(`${MCP}/mcp`)}&scope=relay.read&state=denied`);
    expect(deniedConsent.status).toBe(200);
    const deniedId = ((await deniedConsent.json()) as { consent_id: string }).consent_id;
    const missingBrowser = await runtime.dispatchFetch(`${ISSUER}/consent`, { method: "POST", body: JSON.stringify({ consent_id: deniedId, decision: "deny" }) });
    expect(missingBrowser.status).toBe(403);
    const denied = await runtime.dispatchFetch(`${ISSUER}/consent`, { method: "POST", headers: { "Content-Type": "application/json", ...BROWSER }, body: JSON.stringify({ consent_id: deniedId, decision: "deny" }) });
    expect(await denied.json()).toEqual({ error: "access_denied" });

    const allowedConsent = await runtime.dispatchFetch(`${ISSUER}/authorize?response_type=code&redirect_uri=${encodeURIComponent(REDIRECT)}&code_challenge=${challenge}&code_challenge_method=S256&resource=${encodeURIComponent(`${MCP}/mcp`)}&scope=relay.read&state=allowed`);
    const allowedId = ((await allowedConsent.json()) as { consent_id: string }).consent_id;
    const allowed = await runtime.dispatchFetch(`${ISSUER}/consent`, { method: "POST", headers: { "Content-Type": "application/json", ...BROWSER }, body: JSON.stringify({ consent_id: allowedId, decision: "allow" }) });
    const code = new URL(((await allowed.json()) as { redirect: string }).redirect).searchParams.get("code");
    expect(code).toBeTruthy();
    const wrongVerifier = new URLSearchParams({ grant_type: "authorization_code", code: code!, code_verifier: "wrong-verifier-with-enough-entropy", redirect_uri: REDIRECT, resource: `${MCP}/mcp` });
    expect((await runtime.dispatchFetch(`${ISSUER}/token`, { method: "POST", body: wrongVerifier })).status).toBe(400);
    const exchange = async () => {
      const response = await runtime.dispatchFetch(`${ISSUER}/token`, { method: "POST", body: new URLSearchParams({ grant_type: "authorization_code", code: code!, code_verifier: verifier, redirect_uri: REDIRECT, resource: `${MCP}/mcp` }) });
      return { status: response.status, body: await response.json() as { access_token?: string; refresh_token?: string } };
    };
    const [first, second] = await Promise.all([exchange(), exchange()]);
    expect([first.status, second.status]).toEqual([200, 200]);
    const issued = first.body as { access_token: string; refresh_token: string; account: string };
    expect(issued.account).toBe("account-a");
    expect(second.body).toEqual(issued);
    const replay = (await exchange()).body as { access_token: string; refresh_token: string };
    expect(replay).toEqual(issued);
    expect((await runtime.dispatchFetch(`${ISSUER}/token`, { method: "POST", body: wrongVerifier })).status).toBe(400);

    const initialize = { method: "POST", headers: { Authorization: `Bearer ${issued.access_token}`, "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }) };
    expect((await runtime.dispatchFetch(`${MCP}/mcp`, initialize)).status).toBe(200);
    const oversizedMcp = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", pad: "a".repeat(4096) });
    expect(new TextEncoder().encode(oversizedMcp).length).toBeGreaterThan(4096);
    expect((await runtime.dispatchFetch(`${MCP}/mcp`, { method: "POST", headers: { "Content-Type": "application/json" }, body: oversizedMcp })).status).toBe(401);
    expect((await runtime.dispatchFetch(`${MCP}/mcp`, { method: "POST", headers: { Authorization: `Bearer ${issued.access_token}`, "Content-Type": "application/json" }, body: oversizedMcp })).status).toBe(400);
    const [concurrentA, concurrentB] = await Promise.all([runtime.dispatchFetch(`${MCP}/mcp`, initialize), runtime.dispatchFetch(`${MCP}/mcp`, initialize)]);
    expect([concurrentA.status, concurrentB.status]).toEqual([200, 200]);
    expect((await runtime.dispatchFetch(`${OTHER}/mcp`, initialize)).status).toBe(401);

    const rotated = await runtime.dispatchFetch(`${ISSUER}/token`, { method: "POST", body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: issued.refresh_token, resource: `${MCP}/mcp` }) });
    expect(rotated.status).toBe(200);
    const next = await rotated.json() as { access_token: string; refresh_token: string; account: string };
    expect(next.account).toBe(issued.account);
    const lostRotation = await (await runtime.dispatchFetch(`${ISSUER}/token`, { method: "POST", body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: issued.refresh_token, resource: `${MCP}/mcp` }) })).json() as { access_token: string; refresh_token: string };
    expect(lostRotation).toEqual(next);
    expect(((await (await runtime.dispatchFetch(`${ISSUER}/held`, { method: "POST", body: "{}" })).json()) as { refresh: number }).refresh).toBe(2);
    const rotatedAccess = { method: "POST", headers: { Authorization: `Bearer ${next.access_token}`, "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 4, method: "initialize" }) };
    expect((await runtime.dispatchFetch(`${MCP}/mcp`, rotatedAccess)).status).toBe(200);
    expect((await runtime.dispatchFetch(`${OTHER}/mcp`, rotatedAccess)).status).toBe(401);
    expect((await runtime.dispatchFetch(`${MCP}/mcp`, initialize)).status).toBe(200);
    expect((await runtime.dispatchFetch(`${MCP}/mcp`, { method: "POST", headers: { "Content-Type": "application/json", "Mcp-Session-Id": "legacy-session" }, body: JSON.stringify({ jsonrpc: "2.0", id: 5, method: "initialize" }) })).status).toBe(401);
    expect((await runtime.dispatchFetch(`${MCP}/mcp`, { method: "POST", headers: { Authorization: `Bearer ${issued.access_token}`, "Content-Type": "application/json", "Mcp-Session-Id": "legacy-session" }, body: JSON.stringify({ jsonrpc: "2.0", id: 6, method: "initialize" }) })).status).toBe(200);
    expect((await runtime.dispatchFetch(`${MCP}/mcp`, { headers: { Accept: "text/event-stream" } })).status).toBe(404);
    expect((await runtime.dispatchFetch(`${ISSUER}/token`, { method: "POST", body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: next.refresh_token, resource: `${OTHER}/mcp` }) })).status).toBe(400);
    const [refreshA, refreshB] = await Promise.all([0, 1].map(() => runtime.dispatchFetch(`${ISSUER}/token`, { method: "POST", body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: next.refresh_token, resource: `${MCP}/mcp` }) })));
    expect([refreshA.status, refreshB.status]).toEqual([200, 200]);
    const rotatedAgain = await refreshA.json() as { access_token: string; refresh_token: string };
    expect(await refreshB.json()).toEqual(rotatedAgain);
    expect((await runtime.dispatchFetch(`${ISSUER}/token`, { method: "POST", body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: issued.refresh_token, resource: `${MCP}/mcp` }) })).status).toBe(400);
    expect(((await (await runtime.dispatchFetch(`${ISSUER}/held`, { method: "POST", body: "{}" })).json()) as { refresh: number }).refresh).toBe(2);

    const narrowConsent = await runtime.dispatchFetch(`${ISSUER}/authorize?response_type=code&redirect_uri=${encodeURIComponent(REDIRECT)}&code_challenge=${challenge}&code_challenge_method=S256&resource=${encodeURIComponent(`${MCP}/mcp`)}&scope=other&state=narrow`);
    const narrowId = ((await narrowConsent.json()) as { consent_id: string }).consent_id;
    const narrow = await runtime.dispatchFetch(`${ISSUER}/consent`, { method: "POST", headers: { "Content-Type": "application/json", ...BROWSER }, body: JSON.stringify({ consent_id: narrowId, decision: "allow" }) });
    const narrowCode = new URL(((await narrow.json()) as { redirect: string }).redirect).searchParams.get("code");
    const narrowToken = await (await runtime.dispatchFetch(`${ISSUER}/token`, { method: "POST", body: new URLSearchParams({ grant_type: "authorization_code", code: narrowCode!, code_verifier: verifier, redirect_uri: REDIRECT, resource: `${MCP}/mcp` }) })).json() as { access_token: string };
    const missingScope = await runtime.dispatchFetch(`${MCP}/mcp`, { method: "POST", headers: { Authorization: `Bearer ${narrowToken.access_token}`, "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "initialize" }) });
    expect(missingScope.status).toBe(403);
    expect(await missingScope.json()).toEqual({ error: "insufficient_scope" });
    expect((await runtime.dispatchFetch(`${MCP}/mcp`)).status).toBe(404);
    expect((await runtime.dispatchFetch(`${MCP}/mcp/extra`, initialize)).status).toBe(404);
    expect((await runtime.dispatchFetch(`${ISSUER}/oauth/token`, { method: "POST", body: new URLSearchParams() })).status).toBe(404);
    const metadata = await (await runtime.dispatchFetch(`${ISSUER}/.well-known/oauth-authorization-server`)).json() as { response_types_supported: string[]; grant_types_supported: string[]; code_challenge_methods_supported: string[]; token_endpoint_auth_methods_supported: string[] };
    expect(metadata.response_types_supported).toEqual(["code"]);
    expect(metadata.grant_types_supported).toEqual(["authorization_code", "refresh_token"]);
    expect(metadata.code_challenge_methods_supported).toEqual(["S256"]);
    expect(metadata.token_endpoint_auth_methods_supported).toEqual(["none"]);
    expect((await runtime.dispatchFetch(`${ISSUER}/.well-known/oauth-protected-resource/mcp`)).status).toBe(404);
    expect((await runtime.dispatchFetch(`${MCP}/.well-known/oauth-authorization-server`)).status).toBe(404);
    const resourceMetadata = await (await runtime.dispatchFetch(`${MCP}/.well-known/oauth-protected-resource/mcp`)).json() as { resource: string; authorization_servers: string[] };
    expect(resourceMetadata.resource).toBe(`${MCP}/mcp`);
    expect(resourceMetadata.authorization_servers).toEqual([ISSUER]);
    expect(((await (await runtime.dispatchFetch(`${OTHER}/.well-known/oauth-protected-resource/mcp`)).json()) as { resource: string }).resource).toBe(`${OTHER}/mcp`);
    expect((await runtime.dispatchFetch(`${MCP}/token`, { method: "POST", body: new URLSearchParams({ grant_type: "authorization_code" }) })).status).toBe(404);
    expect((await runtime.dispatchFetch(`${ISSUER}/mcp`, initialize)).status).toBe(404);
    const otherPort = "http://127.0.0.1:43111/callback";
    const portConsent = await runtime.dispatchFetch(`${ISSUER}/authorize?response_type=code&redirect_uri=${encodeURIComponent(otherPort)}&code_challenge=${challenge}&code_challenge_method=S256&resource=${encodeURIComponent(`${MCP}/mcp`)}&scope=relay.read&state=port`);
    expect(portConsent.status).toBe(200);
    expect((await runtime.dispatchFetch(`${ISSUER}/authorize?response_type=code&redirect_uri=${encodeURIComponent("http://127.0.0.1:43111/other")}&code_challenge=${challenge}&code_challenge_method=S256&resource=${encodeURIComponent(`${MCP}/mcp`)}&scope=relay.read&state=path`)).status).toBe(400);
    expect((await runtime.dispatchFetch(`${ISSUER}/authorize?response_type=code&redirect_uri=${encodeURIComponent("https://evil.example/callback")}&code_challenge=${challenge}&code_challenge_method=S256&resource=${encodeURIComponent(`${MCP}/mcp`)}&scope=relay.read&state=host`)).status).toBe(400);
    expect((await runtime.dispatchFetch(`${ISSUER}/authorize?response_type=token&redirect_uri=${encodeURIComponent(REDIRECT)}&code_challenge=${challenge}&code_challenge_method=S256&resource=${encodeURIComponent(`${MCP}/mcp`)}&scope=relay.read&state=implicit`)).status).toBe(400);
    expect((await runtime.dispatchFetch(`${ISSUER}/authorize?response_type=code&redirect_uri=${encodeURIComponent(REDIRECT)}&code_challenge=${challenge}&code_challenge_method=plain&resource=${encodeURIComponent(`${MCP}/mcp`)}&scope=relay.read&state=plain`)).status).toBe(400);
    expect((await runtime.dispatchFetch(`${ISSUER}/authorize?response_type=code&redirect_uri=${encodeURIComponent("https://127.0.0.1:43111/callback")}&code_challenge=${challenge}&code_challenge_method=S256&resource=${encodeURIComponent(`${MCP}/mcp`)}&scope=relay.read&state=scheme`)).status).toBe(400);
    expect((await runtime.dispatchFetch(`${ISSUER}/authorize?response_type=code&redirect_uri=${encodeURIComponent("http://127.0.0.1:43111/callback?extra=1")}&code_challenge=${challenge}&code_challenge_method=S256&resource=${encodeURIComponent(`${MCP}/mcp`)}&scope=relay.read&state=query`)).status).toBe(400);
    expect((await runtime.dispatchFetch(`${ISSUER}/authorize?response_type=code&redirect_uri=${encodeURIComponent("http://127.0.0.1:43111/callback#fragment")}&code_challenge=${challenge}&code_challenge_method=S256&resource=${encodeURIComponent(`${MCP}/mcp`)}&scope=relay.read&state=fragment`)).status).toBe(400);
    expect((await runtime.dispatchFetch(`${ISSUER}/authorize?response_type=code&redirect_uri=${encodeURIComponent("http://user:pw@127.0.0.1:43111/callback")}&code_challenge=${challenge}&code_challenge_method=S256&resource=${encodeURIComponent(`${MCP}/mcp`)}&scope=relay.read&state=userinfo`)).status).toBe(400);
    expect((await runtime.dispatchFetch(`${ISSUER}/token`, { method: "POST", body: new URLSearchParams({ grant_type: "client_credentials", resource: `${MCP}/mcp` }) })).status).toBe(400);

    const admitted = await runtime.dispatchFetch(`${MCP}/mcp`, initialize);
    expect(admitted.status).toBe(200);
    const liveRefresh = await runtime.dispatchFetch(`${ISSUER}/token`, { method: "POST", body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: rotatedAgain.refresh_token, resource: `${MCP}/mcp` }) });
    expect(liveRefresh.status).toBe(200);
    const live = await liveRefresh.json() as { refresh_token: string };
    expect((await runtime.dispatchFetch(`${ISSUER}/revoke`, { method: "POST", body: "{}" })).status).toBe(403);
    expect((await runtime.dispatchFetch(`${ISSUER}/revoke`, { method: "POST", headers: BROWSER, body: "{}" })).status).toBe(200);
    expect(admitted.status).toBe(200);
    expect((await runtime.dispatchFetch(`${MCP}/mcp`, initialize)).status).toBe(401);
    expect((await runtime.dispatchFetch(`${ISSUER}/token`, { method: "POST", body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: live.refresh_token, resource: `${MCP}/mcp` }) })).status).toBe(400);
    const renewedConsent = await runtime.dispatchFetch(`${ISSUER}/authorize?response_type=code&redirect_uri=${encodeURIComponent(REDIRECT)}&code_challenge=${challenge}&code_challenge_method=S256&resource=${encodeURIComponent(`${MCP}/mcp`)}&scope=relay.read&state=renewed`);
    const renewedId = ((await renewedConsent.json()) as { consent_id: string }).consent_id;
    const renewed = await runtime.dispatchFetch(`${ISSUER}/consent`, { method: "POST", headers: { "Content-Type": "application/json", ...BROWSER }, body: JSON.stringify({ consent_id: renewedId, decision: "allow" }) });
    const renewedCode = new URL(((await renewed.json()) as { redirect: string }).redirect).searchParams.get("code");
    const renewedToken = await (await runtime.dispatchFetch(`${ISSUER}/token`, { method: "POST", body: new URLSearchParams({ grant_type: "authorization_code", code: renewedCode!, code_verifier: verifier, redirect_uri: REDIRECT, resource: `${MCP}/mcp` }) })).json() as { access_token: string; account: string };
    expect(renewedToken.account).toBe("account-a");
    expect((await runtime.dispatchFetch(`${MCP}/mcp`, initialize)).status).toBe(401);
    expect((await runtime.dispatchFetch(`${MCP}/mcp`, { method: "POST", headers: { Authorization: `Bearer ${renewedToken.access_token}`, "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "initialize" }) })).status).toBe(200);
    expect((await runtime.dispatchFetch(`${ISSUER}/rebind`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ account: "account-b" }) })).status).toBe(403);
    expect((await runtime.dispatchFetch(`${ISSUER}/rebind`, { method: "POST", headers: { "Content-Type": "application/json", ...BROWSER }, body: JSON.stringify({ account: "account-a" }) })).status).toBe(400);
    expect((await runtime.dispatchFetch(`${ISSUER}/rebind`, { method: "POST", headers: { "Content-Type": "application/json", ...BROWSER }, body: JSON.stringify({ account: "account-b" }) })).status).toBe(200);
    expect((await runtime.dispatchFetch(`${MCP}/mcp`, { method: "POST", headers: { Authorization: `Bearer ${renewedToken.access_token}`, "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 7, method: "initialize" }) })).status).toBe(401);
    const reboundConsent = await runtime.dispatchFetch(`${ISSUER}/authorize?response_type=code&redirect_uri=${encodeURIComponent(REDIRECT)}&code_challenge=${challenge}&code_challenge_method=S256&resource=${encodeURIComponent(`${MCP}/mcp`)}&scope=relay.read&state=rebound`);
    const reboundId = ((await reboundConsent.json()) as { consent_id: string }).consent_id;
    const rebound = await runtime.dispatchFetch(`${ISSUER}/consent`, { method: "POST", headers: { "Content-Type": "application/json", ...BROWSER }, body: JSON.stringify({ consent_id: reboundId, decision: "allow" }) });
    const reboundCode = new URL(((await rebound.json()) as { redirect: string }).redirect).searchParams.get("code");
    const reboundToken = await (await runtime.dispatchFetch(`${ISSUER}/token`, { method: "POST", body: new URLSearchParams({ grant_type: "authorization_code", code: reboundCode!, code_verifier: verifier, redirect_uri: REDIRECT, resource: `${MCP}/mcp` }) })).json() as { access_token: string; account: string };
    expect(reboundToken.account).toBe("account-b");
    expect((await runtime.dispatchFetch(`${MCP}/mcp`, { method: "POST", headers: { Authorization: `Bearer ${reboundToken.access_token}`, "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 8, method: "initialize" }) })).status).toBe(200);
    expect((await runtime.dispatchFetch(`${MCP}/mcp`, { method: "POST", headers: { Authorization: `Bearer ${renewedToken.access_token}`, "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 9, method: "initialize" }) })).status).toBe(401);
    const limited: number[] = [];
    let firstLimited = -1;
    for (let attempt = 0; attempt < 24 && limited.length < 2; attempt += 1) {
      const status = (await runtime.dispatchFetch(`${ISSUER}/register`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ redirect_uris: [`http://127.0.0.1:${9000 + attempt}/callback`] }) })).status;
      if (status === 429) {
        if (firstLimited < 0) firstLimited = attempt;
        limited.push(status);
      }
    }
    expect(firstLimited).toBe(9);
    expect(limited).toEqual([429, 429]);
    const tokenLimited: number[] = [];
    let firstTokenLimited = -1;
    for (let attempt = 0; attempt < 40 && tokenLimited.length < 2; attempt += 1) {
      const status = (await runtime.dispatchFetch(`${ISSUER}/token`, { method: "POST", body: new URLSearchParams({ grant_type: "client_credentials", resource: `${MCP}/mcp` }) })).status;
      if (status === 429) {
        if (firstTokenLimited < 0) firstTokenLimited = attempt;
        tokenLimited.push(status);
      }
    }
    expect(firstTokenLimited).toBe(15);
    expect(tokenLimited).toEqual([429, 429]);
  } finally { await runtime.dispose(); }
}, 20000);
