import { createRequire } from "node:module";
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
    bindings: { ADMIN_DASHBOARD_HOST: "console.example.test" },
    durableObjects: { GRANTS: { className: "RuntimeGrantAuthority", useSQLite: true } }
  }));
  return { runtime };
}

it("keeps authorization-code use atomic and rejects another resource's token", async () => {
  const { runtime } = await start();
  try {
    const crossSite = await runtime.dispatchFetch(`${ISSUER}/register`, {
      method: "POST", headers: { "Content-Type": "application/json", Origin: "https://attacker.invalid", "Sec-Fetch-Site": "cross-site" },
      body: JSON.stringify({ redirect_uris: [REDIRECT] })
    });
    expect(crossSite.status).toBe(200);
    const verifier = "synthetic-verifier-with-enough-entropy";
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
    const exchange = () => runtime.dispatchFetch(`${ISSUER}/token`, { method: "POST", body: new URLSearchParams({ grant_type: "authorization_code", code: code!, code_verifier: verifier, redirect_uri: REDIRECT, resource: `${MCP}/mcp` }) });
    const [first, second] = await Promise.all([exchange(), exchange()]);
    const statuses = [first.status, second.status].sort();
    expect(statuses).toEqual([200, 400]);
    const issued = (first.status === 200 ? await first.json() : await second.json()) as { access_token: string; refresh_token: string };
    const replay = await exchange();
    expect(replay.status).toBe(400);

    const initialize = { method: "POST", headers: { Authorization: `Bearer ${issued.access_token}`, "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }) };
    expect((await runtime.dispatchFetch(`${MCP}/mcp`, initialize)).status).toBe(200);
    expect((await runtime.dispatchFetch(`${OTHER}/mcp`, initialize)).status).toBe(401);

    const rotated = await runtime.dispatchFetch(`${ISSUER}/token`, { method: "POST", body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: issued.refresh_token, resource: `${MCP}/mcp` }) });
    expect(rotated.status).toBe(200);
    const next = await rotated.json() as { refresh_token: string };
    const [refreshA, refreshB] = await Promise.all([0, 1].map(() => runtime.dispatchFetch(`${ISSUER}/token`, { method: "POST", body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: next.refresh_token, resource: `${MCP}/mcp` }) })));
    expect([refreshA.status, refreshB.status].sort()).toEqual([200, 400]);
    expect((await runtime.dispatchFetch(`${ISSUER}/token`, { method: "POST", body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: issued.refresh_token, resource: `${MCP}/mcp` }) })).status).toBe(400);

    const narrowConsent = await runtime.dispatchFetch(`${ISSUER}/authorize?response_type=code&redirect_uri=${encodeURIComponent(REDIRECT)}&code_challenge=${challenge}&code_challenge_method=S256&resource=${encodeURIComponent(`${MCP}/mcp`)}&scope=other&state=narrow`);
    const narrowId = ((await narrowConsent.json()) as { consent_id: string }).consent_id;
    const narrow = await runtime.dispatchFetch(`${ISSUER}/consent`, { method: "POST", headers: { "Content-Type": "application/json", ...BROWSER }, body: JSON.stringify({ consent_id: narrowId, decision: "allow" }) });
    const narrowCode = new URL(((await narrow.json()) as { redirect: string }).redirect).searchParams.get("code");
    const narrowToken = await (await runtime.dispatchFetch(`${ISSUER}/token`, { method: "POST", body: new URLSearchParams({ grant_type: "authorization_code", code: narrowCode!, code_verifier: verifier, redirect_uri: REDIRECT, resource: `${MCP}/mcp` }) })).json() as { access_token: string };
    const missingScope = await runtime.dispatchFetch(`${MCP}/mcp`, { method: "POST", headers: { Authorization: `Bearer ${narrowToken.access_token}`, "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "initialize" }) });
    expect(missingScope.status).toBe(403);
    expect(await missingScope.json()).toEqual({ error: "insufficient_scope" });
  } finally { await runtime.dispose(); }
}, 20000);
