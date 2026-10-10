import { DurableObject } from "cloudflare:workers";
import { assertConsoleBrowserWrite } from "../../src/admin/browser-write";
import { HttpError, jsonResponse } from "../../src/errors";

const REQUIRED_SCOPE = "relay.read";
const MAX_BODY_BYTES = 4096;

interface FixtureEnv extends Env {
  GRANTS: DurableObjectNamespace<RuntimeGrantAuthority>;
  OAUTH_ISSUER_ORIGIN: string;
  OAUTH_RESOURCE_ORIGIN: string;
  OAUTH_OTHER_RESOURCE_ORIGIN: string;
}

interface ClientRecord {
  redirects: string[];
}

interface ConsentRecord {
  redirect: string;
  challenge: string;
  resource: string;
  scope: string;
  state: string;
  decision: "pending" | "allow" | "deny";
  code?: string;
}

interface AuthorityState {
  generation: number;
  account: string;
}

interface CodeRecord {
  challenge: string;
  redirect: string;
  resource: string;
  scope: string;
  generation: number;
  account: string;
  consumed: boolean;
  refresh: string;
  access: string;
}

interface RefreshRecord {
  resource: string;
  scope: string;
  access: string;
  generation: number;
  account: string;
  spent: boolean;
  replacement?: string;
  previous?: string;
}

interface AccessRecord {
  resource: string;
  scope: string;
  generation: number;
  account: string;
}

type ConsumeResult = { ok: true; access: string; refresh: string; scope: string; resource: string; account: string } | { ok: false; reason: "replay" | "pkce" | "redirect" | "resource" | "missing" };

export class RuntimeGrantAuthority extends DurableObject<FixtureEnv> {
  private storageOps = 0;

  async fetch(request: Request): Promise<Response> {
    try {
      const body = await request.json() as Record<string, unknown>;
      const action = new URL(request.url).pathname;
      if (action === "/register") return jsonResponse(await this.register(body));
      if (action === "/begin") return jsonResponse(await this.begin(body));
      if (action === "/decide") return jsonResponse(await this.decide(body));
      if (action === "/consume") return jsonResponse(await this.consume(body));
      if (action === "/refresh") return jsonResponse(await this.refresh(body));
      if (action === "/access") return jsonResponse(await this.access(body));
      if (action === "/revoke") return jsonResponse(await this.revoke());
      if (action === "/rebind") return jsonResponse(await this.rebind(body));
      if (action === "/budget") return jsonResponse({ storage_operations: this.storageOps });
      if (action === "/held") return jsonResponse({ refresh: (await this.ctx.storage.list({ prefix: "refresh:" })).size });
      if (action === "/budget-reset") { this.storageOps = 0; return jsonResponse({ storage_operations: 0 }); }
      return new Response(null, { status: 404 });
    } catch (error) {
      const status = typeof error === "object" && error !== null && "status" in error && error.status === 400 ? 400 : 500;
      return jsonResponse({ error: status === 400 ? "invalid_request" : "server_error" }, { status });
    }
  }

  private async register(body: Record<string, unknown>): Promise<{ client_id: string; redirect_uris: string[]; grant_types: string[]; response_types: string[]; token_endpoint_auth_method: "none" }> {
    const redirects = stringList(body.redirect_uris);
    if (redirects.length !== 1) throw Object.assign(new Error("one redirect"), { status: 400 });
    this.storageOps += 1;
    const existing = await this.ctx.storage.get<ClientRecord>("client");
    if (existing) throw Object.assign(new Error("registered"), { status: 400 });
    this.storageOps += 1;
    await this.ctx.storage.put("client", { redirects } satisfies ClientRecord);
    return { client_id: "synthetic-public-client", redirect_uris: redirects, grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none" };
  }

  private async begin(body: Record<string, unknown>): Promise<{ consent_id: string }> {
    this.storageOps += 1;
    const client = await this.ctx.storage.get<ClientRecord>("client");
    const redirect = stringField(body, "redirect");
    const resource = stringField(body, "resource");
    if (!client?.redirects.some((registered) => redirectsMatch(registered, redirect))) throw Object.assign(new Error("unregistered redirect"), { status: 400 });
    if (resource !== `${this.env.OAUTH_RESOURCE_ORIGIN}/mcp` && resource !== `${this.env.OAUTH_OTHER_RESOURCE_ORIGIN}/mcp`) throw Object.assign(new Error("unknown resource"), { status: 400 });
    if (stringField(body, "method") !== "S256") throw Object.assign(new Error("pkce"), { status: 400 });
    const consent: ConsentRecord = {
      redirect, challenge: stringField(body, "challenge"), resource, scope: stringField(body, "scope"), state: stringField(body, "state"), decision: "pending"
    };
    const consentId = crypto.randomUUID();
    this.storageOps += 1;
    await this.ctx.storage.put(`consent:${consentId}`, consent);
    return { consent_id: consentId };
  }

  private async decide(body: Record<string, unknown>): Promise<{ error?: string; code?: string; redirect?: string }> {
    const consentId = stringField(body, "consent_id");
    const decision = stringField(body, "decision");
    return this.ctx.storage.transaction(async (txn) => {
      this.storageOps += 1;
      const consent = await txn.get<ConsentRecord>(`consent:${consentId}`);
      if (!consent || consent.decision !== "pending") return { error: "invalid_request" };
      if (decision === "deny") {
        this.storageOps += 1;
        await txn.put(`consent:${consentId}`, { ...consent, decision: "deny" });
        return { error: "access_denied" };
      }
      if (decision !== "allow") return { error: "invalid_request" };
      const code = crypto.randomUUID();
      const refresh = crypto.randomUUID();
      const access = crypto.randomUUID();
      const authority = await this.readAuthority(txn);
      const generation = authority.generation;
      const account = authority.account;
      const issued: ConsentRecord = { ...consent, decision: "allow", code };
      this.storageOps += 4;
      await txn.put(`consent:${consentId}`, issued);
      await txn.put(`code:${code}`, { challenge: consent.challenge, redirect: consent.redirect, resource: consent.resource, scope: consent.scope, generation, account, consumed: false, refresh, access } satisfies CodeRecord);
      await txn.put(`refresh:${refresh}`, { resource: consent.resource, scope: consent.scope, access, generation, account, spent: false } satisfies RefreshRecord);
      await txn.put(`access:${access}`, { resource: consent.resource, scope: consent.scope, generation, account } satisfies AccessRecord);
      const redirect = new URL(consent.redirect);
      redirect.searchParams.set("code", code);
      redirect.searchParams.set("state", consent.state);
      return { code, redirect: redirect.toString() };
    });
  }

  private async consume(body: Record<string, unknown>): Promise<ConsumeResult> {
    const code = stringField(body, "code");
    return this.ctx.storage.transaction(async (txn) => {
      this.storageOps += 1;
      const row = await txn.get<CodeRecord>(`code:${code}`);
      const authority = await this.readAuthority(txn);
      if (!row || row.generation !== authority.generation) return { ok: false, reason: "missing" };
      const matches = row.challenge === stringField(body, "challenge") && row.redirect === stringField(body, "redirect") && row.resource === stringField(body, "resource");
      if (row.consumed) return matches ? { ok: true, access: row.access, refresh: row.refresh, scope: row.scope, resource: row.resource, account: row.account } : { ok: false, reason: "replay" };
      if (row.challenge !== stringField(body, "challenge")) return { ok: false, reason: "pkce" };
      if (row.redirect !== stringField(body, "redirect")) return { ok: false, reason: "redirect" };
      if (row.resource !== stringField(body, "resource")) return { ok: false, reason: "resource" };
      this.storageOps += 1;
      await txn.put(`code:${code}`, { ...row, consumed: true });
      return { ok: true, access: row.access, refresh: row.refresh, scope: row.scope, resource: row.resource, account: row.account };
    });
  }

  private async refresh(body: Record<string, unknown>): Promise<{ ok: true; access: string; refresh: string; account: string } | { ok: false }> {
    const current = stringField(body, "refresh");
    return this.ctx.storage.transaction(async (txn) => {
      this.storageOps += 1;
      const row = await txn.get<RefreshRecord>(`refresh:${current}`);
      const authority = await this.readAuthority(txn);
      if (!row || row.generation !== authority.generation || row.resource !== stringField(body, "resource")) return { ok: false };
      if (row.spent) {
        if (!row.replacement) return { ok: false };
        this.storageOps += 1;
        const successor = await txn.get<RefreshRecord>(`refresh:${row.replacement}`);
        if (!successor || successor.spent || successor.generation !== authority.generation) return { ok: false };
        return { ok: true, access: successor.access, refresh: row.replacement, account: successor.account };
      }
      const next = crypto.randomUUID();
      const access = crypto.randomUUID();
      this.storageOps += row.previous === undefined ? 3 : 4;
      await txn.put(`refresh:${current}`, { ...row, spent: true, replacement: next });
      await txn.put(`refresh:${next}`, { resource: row.resource, scope: row.scope, access, generation: row.generation, account: row.account, spent: false, previous: current } satisfies RefreshRecord);
      await txn.put(`access:${access}`, { resource: row.resource, scope: row.scope, generation: row.generation, account: row.account } satisfies AccessRecord);
      if (row.previous !== undefined) await txn.delete(`refresh:${row.previous}`);
      return { ok: true, access, refresh: next, account: row.account };
    });
  }

  private async access(body: Record<string, unknown>): Promise<AccessRecord | null> {
    const token = stringField(body, "token");
    return this.ctx.storage.transaction(async (txn) => {
      this.storageOps += 1;
      const row = await txn.get<AccessRecord>(`access:${token}`);
      const authority = await this.readAuthority(txn);
      return row && row.generation === authority.generation ? row : null;
    });
  }

  private async revoke(): Promise<{ revoked: true }> {
    await this.ctx.storage.transaction(async (txn) => {
      const authority = await this.readAuthority(txn);
      this.storageOps += 1;
      await txn.put("authority", { generation: authority.generation + 1, account: authority.account });
    });
    return { revoked: true };
  }

  private async rebind(body: Record<string, unknown>): Promise<{ account: string }> {
    const account = stringField(body, "account");
    return this.ctx.storage.transaction(async (txn) => {
      const authority = await this.readAuthority(txn);
      if (authority.account === account) throw Object.assign(new Error("same account"), { status: 400 });
      this.storageOps += 1;
      await txn.put("authority", { generation: authority.generation + 1, account });
      return { account };
    });
  }

  private async readAuthority(txn: { get<T>(key: string): Promise<T | undefined> }): Promise<AuthorityState> {
    this.storageOps += 1;
    return (await txn.get<AuthorityState>("authority")) ?? { generation: 1, account: "account-a" };
  }
}

function stringField(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  if (typeof value !== "string" || value.length === 0) throw new Error(`missing ${key}`);
  return value;
}

function redirectsMatch(registered: string, requested: string): boolean {
  if (registered === requested) return true;
  let allowed: URL;
  let actual: URL;
  try {
    allowed = new URL(registered);
    actual = new URL(requested);
  } catch {
    return false;
  }
  const loopback = allowed.hostname === "127.0.0.1" || allowed.hostname === "localhost" || allowed.hostname === "::1";
  return loopback && actual.hostname === allowed.hostname && actual.protocol === allowed.protocol && actual.username === allowed.username && actual.password === allowed.password && actual.pathname === allowed.pathname && actual.search === allowed.search && actual.hash === allowed.hash;
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw new Error("redirects");
  return value as string[];
}

async function s256(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return btoa(String.fromCharCode(...new Uint8Array(digest))).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function authority(env: FixtureEnv): DurableObjectStub<RuntimeGrantAuthority> {
  return env.GRANTS.get(env.GRANTS.idFromName("authority"));
}

async function callAuthority(env: FixtureEnv, path: string, body: unknown): Promise<Response> {
  return authority(env).fetch(`https://authority.internal${path}`, { method: "POST", body: JSON.stringify(body) });
}

export default {
  async fetch(request: Request, env: FixtureEnv): Promise<Response> {
    const url = new URL(request.url);
    const issuerOrigin = url.origin === env.OAUTH_ISSUER_ORIGIN;
    const resourceOrigin = url.origin === env.OAUTH_RESOURCE_ORIGIN || url.origin === env.OAUTH_OTHER_RESOURCE_ORIGIN;
    try {
      if (url.pathname === "/consent" || url.pathname === "/revoke" || url.pathname === "/rebind") assertConsoleBrowserWrite(request, env, url);
      if (resourceOrigin && request.method === "GET" && url.pathname === "/.well-known/oauth-protected-resource/mcp") {
        const resource = `${url.origin}/mcp`;
        return jsonResponse({ resource, authorization_servers: [env.OAUTH_ISSUER_ORIGIN], bearer_methods_supported: ["header"], scopes_supported: [REQUIRED_SCOPE] });
      }
      if (issuerOrigin && request.method === "GET" && url.pathname === "/.well-known/oauth-authorization-server") {
        const issuer = env.OAUTH_ISSUER_ORIGIN;
        return jsonResponse({ issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, registration_endpoint: `${issuer}/register`, response_types_supported: ["code"], grant_types_supported: ["authorization_code", "refresh_token"], code_challenge_methods_supported: ["S256"], token_endpoint_auth_methods_supported: ["none"] });
      }
      if (issuerOrigin && request.method === "POST" && url.pathname === "/register") {
        const body = JSON.parse(await readBounded(request)) as Record<string, unknown>;
        if ("client_secret" in body || "jwks" in body || "jwks_uri" in body) throw Object.assign(new Error("credential metadata"), { status: 400 });
        return callAuthority(env, "/register", body);
      }
      if (issuerOrigin && request.method === "GET" && url.pathname === "/authorize") {
        if (url.searchParams.get("response_type") !== "code") throw Object.assign(new Error("response_type"), { status: 400 });
        return callAuthority(env, "/begin", { redirect: url.searchParams.get("redirect_uri"), challenge: url.searchParams.get("code_challenge"), method: url.searchParams.get("code_challenge_method"), resource: url.searchParams.get("resource"), scope: url.searchParams.get("scope"), state: url.searchParams.get("state") });
      }
      if (issuerOrigin && request.method === "POST" && url.pathname === "/consent") return callAuthority(env, "/decide", JSON.parse(await readBounded(request)) as Record<string, unknown>);
      if (issuerOrigin && request.method === "POST" && url.pathname === "/revoke") return callAuthority(env, "/revoke", {});
      if (issuerOrigin && request.method === "POST" && url.pathname === "/rebind") return callAuthority(env, "/rebind", JSON.parse(await readBounded(request)) as Record<string, unknown>);
      if (issuerOrigin && request.method === "POST" && url.pathname === "/budget") return callAuthority(env, "/budget", {});
      if (issuerOrigin && request.method === "POST" && url.pathname === "/held") return callAuthority(env, "/held", {});
      if (issuerOrigin && request.method === "POST" && url.pathname === "/budget-reset") return callAuthority(env, "/budget-reset", {});
      if (issuerOrigin && request.method === "POST" && url.pathname === "/token") return await token(await readBounded(request), env);
      if (resourceOrigin && request.method === "POST" && url.pathname === "/mcp") return await resourceRequest(request, env, `${url.origin}/mcp`);
      return new Response(null, { status: 404 });
    } catch (error) {
      if (error instanceof HttpError) return jsonResponse({ error: error.code ?? error.message }, { status: error.status });
      const status = typeof error === "object" && error !== null && "status" in error && error.status === 400 ? 400 : 500;
      return jsonResponse({ error: status === 400 ? "invalid_request" : "server_error" }, { status });
    }
  }
};

async function discardRequest(request: Request): Promise<void> {
  const reader = request.body?.getReader();
  if (!reader) return;
  await discardReader(reader);
}

async function discardReader(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> {
  try {
    for (;;) {
      const { done } = await reader.read();
      if (done) break;
    }
  } catch {
    // The sender closed the upload.
  }
}

async function readBounded(request: Request): Promise<string> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    await discardRequest(request);
    throw Object.assign(new Error("body"), { status: 400 });
  }
  const reader = request.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      await discardReader(reader);
      throw Object.assign(new Error("body"), { status: 400 });
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

async function token(body: string, env: FixtureEnv): Promise<Response> {
  const form = new URLSearchParams(body);
  const grant = form.get("grant_type");
  const resource = form.get("resource");
  if (grant === "authorization_code") {
    const verifier = form.get("code_verifier");
    const code = form.get("code");
    const redirect = form.get("redirect_uri");
    if (typeof verifier !== "string" || verifier.length < 43 || verifier.length > 128 || typeof code !== "string" || typeof redirect !== "string" || typeof resource !== "string") return jsonResponse({ error: "invalid_request" }, { status: 400 });
    const result = await (await callAuthority(env, "/consume", { code, challenge: await s256(verifier), redirect, resource })).json() as ConsumeResult;
    if (!result.ok) return jsonResponse({ error: "invalid_grant" }, { status: 400 });
    return jsonResponse({ access_token: result.access, refresh_token: result.refresh, token_type: "bearer", scope: result.scope, resource: result.resource, account: result.account });
  }
  if (grant === "refresh_token") {
    const refreshToken = form.get("refresh_token");
    if (typeof refreshToken !== "string" || typeof resource !== "string") return jsonResponse({ error: "invalid_request" }, { status: 400 });
    const result = await (await callAuthority(env, "/refresh", { refresh: refreshToken, resource })).json() as { ok: true; access: string; refresh: string; account: string } | { ok: false };
    if (!result.ok) return jsonResponse({ error: "invalid_grant" }, { status: 400 });
    return jsonResponse({ access_token: result.access, refresh_token: result.refresh, token_type: "bearer", account: result.account });
  }
  return jsonResponse({ error: "unsupported_grant_type" }, { status: 400 });
}

async function resourceRequest(request: Request, env: FixtureEnv, resource: string): Promise<Response> {
  const header = request.headers.get("Authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
  const access = token ? await (await callAuthority(env, "/access", { token })).json() as AccessRecord | null : null;
  if (!access || access.resource !== resource) {
    await discardRequest(request);
    return jsonResponse({ error: "invalid_token" }, { status: 401, headers: { "WWW-Authenticate": "Bearer error=\"invalid_token\"" } });
  }
  if (!access.scope.split(" ").includes(REQUIRED_SCOPE)) {
    await discardRequest(request);
    return jsonResponse({ error: "insufficient_scope" }, { status: 403, headers: { "WWW-Authenticate": `Bearer error="insufficient_scope", scope="${REQUIRED_SCOPE}"` } });
  }
  const body = JSON.parse(await readBounded(request)) as { method?: string };
  return jsonResponse({ jsonrpc: "2.0", result: body.method === "initialize" ? { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "synthetic", version: "0" } } : {} });
}
