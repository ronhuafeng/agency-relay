import { DurableObject } from "cloudflare:workers";
import OAuth2Server from "@node-oauth/oauth2-server";
import { assertConsoleBrowserWrite } from "../../src/admin/browser-write";
import { HttpError, jsonResponse } from "../../src/errors";

const REQUIRED_SCOPE = "relay.read";
const MAX_BODY_BYTES = 4096;
const BODY_READ_DEADLINE_MS = 1000;
const MAX_REGISTRATION_ATTEMPTS = 16;
const MAX_TOKEN_ATTEMPTS = 32;

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
  generation: number;
  expiresAt: number;
  code?: string;
}

interface AuthorityState {
  generation: number;
  account: string;
  registrationAttempts?: number;
  tokenAttempts?: number;
}

interface CodeRecord {
  challenge: string;
  redirect: string;
  resource: string;
  scope: string;
  generation: number;
  account: string;
  consumed: boolean;
  expiresAt: number;
  grant: string;
}

interface RefreshRecord {
  resource: string;
  scope: string;
  generation: number;
  account: string;
  spent: boolean;
  expiresAt: number;
  grant: string;
}

interface AccessRecord {
  resource: string;
  scope: string;
  generation: number;
  account: string;
  expiresAt: number;
  grant: string;
}

export class RuntimeGrantAuthority extends DurableObject<FixtureEnv> {
  private storageOps = 0;

  async fetch(request: Request): Promise<Response> {
    try {
      const body = await request.json() as Record<string, unknown>;
      const action = new URL(request.url).pathname;
      if (action === "/register-attempt") return jsonResponse(await this.attempt("registrationAttempts", MAX_REGISTRATION_ATTEMPTS));
      if (action === "/token-attempt") return jsonResponse(await this.attempt("tokenAttempts", MAX_TOKEN_ATTEMPTS));
      if (action === "/register") return jsonResponse(await this.register(body));
      if (action === "/begin") return jsonResponse(await this.begin(body));
      if (action === "/decide") return jsonResponse(await this.decide(body));
      if (action === "/token") return await this.exchange(body);
      if (action === "/access") return jsonResponse(await this.access(body));
      if (action === "/revoke") return jsonResponse(await this.revoke());
      if (action === "/rebind") return jsonResponse(await this.rebind(body));
      if (action === "/budget") return jsonResponse({ storage_operations: this.storageOps });
      if (action === "/budget-reset") { this.storageOps = 0; return jsonResponse({ storage_operations: 0 }); }
      return new Response(null, { status: 404 });
    } catch (error) {
      const status = typeof error === "object" && error !== null && "status" in error && error.status === 400 ? 400 : 500;
      return jsonResponse({ error: status === 400 ? "invalid_request" : "server_error" }, { status });
    }
  }

  private async attempt(field: "registrationAttempts" | "tokenAttempts", max: number): Promise<{ ok: boolean }> {
    return this.ctx.storage.transaction(async (txn) => {
      const authority = await this.readAuthority(txn);
      const count = (authority[field] ?? 0) + 1;
      this.storageOps += 1;
      await txn.put("authority", { ...authority, [field]: count });
      return { ok: count <= max };
    });
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
    if (body.client_id !== "synthetic-public-client" || !client?.redirects.some((registered) => redirectsMatch(registered, redirect))) throw Object.assign(new Error("unregistered client or redirect"), { status: 400 });
    if (resource !== `${this.env.OAUTH_RESOURCE_ORIGIN}/mcp` && resource !== `${this.env.OAUTH_OTHER_RESOURCE_ORIGIN}/mcp`) throw Object.assign(new Error("unknown resource"), { status: 400 });
    if (stringField(body, "method") !== "S256") throw Object.assign(new Error("pkce"), { status: 400 });
    const authority = await this.readAuthority(this.ctx.storage);
    const consent: ConsentRecord = {
      redirect, challenge: stringField(body, "challenge"), resource, scope: stringField(body, "scope"), state: stringField(body, "state"), decision: "pending", generation: authority.generation, expiresAt: Date.now() + 120_000
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
      const authority = await this.readAuthority(txn);
      if (!consent || consent.decision !== "pending" || consent.expiresAt <= Date.now() || consent.generation !== authority.generation) return { error: "invalid_request" };
      if (decision === "deny") {
        this.storageOps += 1;
        await txn.put(`consent:${consentId}`, { ...consent, decision: "deny" });
        return { error: "access_denied" };
      }
      if (decision !== "allow") return { error: "invalid_request" };
      const code = crypto.randomUUID();
      const generation = authority.generation;
      const account = authority.account;
      const issued: ConsentRecord = { ...consent, decision: "allow", code };
      this.storageOps += 2;
      await txn.put(`consent:${consentId}`, issued);
      await txn.put(`code:${code}`, { challenge: consent.challenge, redirect: consent.redirect, resource: consent.resource, scope: consent.scope, generation, account, consumed: false, expiresAt: Date.now() + 120_000, grant: code } satisfies CodeRecord);
      const redirect = new URL(consent.redirect);
      redirect.searchParams.set("code", code);
      redirect.searchParams.set("state", consent.state);
      return { code, redirect: redirect.toString() };
    });
  }

  private async exchange(body: Record<string, unknown>): Promise<Response> {
    return this.ctx.storage.transaction(async (txn) => {
      const authority = await this.readAuthority(txn);
      const read = async <T,>(key: string): Promise<T | undefined> => { this.storageOps += 1; return txn.get<T>(key); };
      const write = async (key: string, value: unknown): Promise<void> => { this.storageOps += 1; await txn.put(key, value); };
      let binding: CodeRecord | RefreshRecord | undefined;
      const registered = await read<ClientRecord>("client");
      const client: OAuth2Server.Client = { id: "synthetic-public-client", grants: ["authorization_code", "refresh_token"], redirectUris: registered?.redirects };
      const valid = async (row: CodeRecord | RefreshRecord | undefined): Promise<boolean> => !!row && row.generation === authority.generation && row.resource === body.resource && row.expiresAt > Date.now() && !(await read<boolean>(`revoked:${row.grant}`));
      const model = {
        getClient: async (id: string) => registered && id === client.id ? client : false,
        getAccessToken: async (accessToken: string) => {
          const row = await read<AccessRecord>(`access:${accessToken}`);
          if (!row || row.generation !== authority.generation || await read<boolean>(`revoked:${row.grant}`)) return false;
          return { accessToken, accessTokenExpiresAt: new Date(row.expiresAt), scope: row.scope.split(" "), client, user: { id: "synthetic-member" } };
        },
        getAuthorizationCode: async (code: string) => {
          const row = await read<CodeRecord>(`code:${code}`);
          if (!row || !(await valid(row))) return false;
          if (row.consumed) { await write(`revoked:${row.grant}`, true); return false; }
          binding = row;
          return { authorizationCode: code, expiresAt: new Date(row.expiresAt), redirectUri: row.redirect, codeChallenge: row.challenge, codeChallengeMethod: "S256", scope: row.scope.split(" "), client, user: { id: "synthetic-member" } };
        },
        revokeAuthorizationCode: async (code: OAuth2Server.AuthorizationCode) => {
          await write(`code:${code.authorizationCode}`, { ...binding, consumed: true });
          return true;
        },
        getRefreshToken: async (refresh: string) => {
          const row = await read<RefreshRecord>(`refresh:${refresh}`);
          if (!row || !(await valid(row))) return false;
          if (row.spent) { await write(`revoked:${row.grant}`, true); return false; }
          binding = row;
          return { refreshToken: refresh, refreshTokenExpiresAt: new Date(row.expiresAt), scope: row.scope.split(" "), client, user: { id: "synthetic-member" } };
        },
        revokeToken: async (token: OAuth2Server.RefreshToken) => {
          await write(`refresh:${token.refreshToken}`, { ...binding, spent: true });
          return true;
        },
        saveToken: async (token: OAuth2Server.Token, tokenClient: OAuth2Server.Client, user: OAuth2Server.User) => {
          if (!binding || !token.accessTokenExpiresAt || !token.refreshToken || !token.refreshTokenExpiresAt) throw new Error("incomplete issuance");
          const base = { resource: binding.resource, scope: (token.scope ?? []).join(" "), generation: binding.generation, account: binding.account, grant: binding.grant };
          await write(`access:${token.accessToken}`, { ...base, expiresAt: token.accessTokenExpiresAt.getTime() } satisfies AccessRecord);
          await write(`refresh:${token.refreshToken}`, { ...base, expiresAt: token.refreshTokenExpiresAt.getTime(), spent: false } satisfies RefreshRecord);
          return { ...token, client: tokenClient, user };
        }
      };
      const server = new OAuth2Server({ model, accessTokenLifetime: 600, refreshTokenLifetime: 3600, requireClientAuthentication: { authorization_code: false, refresh_token: false } });
      const response = new OAuth2Server.Response();
      try {
        const size = new TextEncoder().encode(new URLSearchParams(body as Record<string, string>).toString()).byteLength;
        await server.token(new OAuth2Server.Request({ method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "content-length": String(size) }, query: {}, body }), response);
        return jsonResponse({ ...response.body, resource: binding?.resource, account: binding?.account }, { headers: response.headers });
      } catch (error) {
        // Protocol rejection commits consumption/replay revocation. Storage failures roll back.
        if (!(error instanceof OAuth2Server.OAuthError) || error.code >= 500) throw error;
        return jsonResponse({ error: error.name }, { status: error.code, headers: response.headers });
      }
    });
  }

  private async access(body: Record<string, unknown>): Promise<AccessRecord | null> {
    const token = stringField(body, "token");
    return this.ctx.storage.transaction(async (txn) => {
      this.storageOps += 1;
      const row = await txn.get<AccessRecord>(`access:${token}`);
      const authority = await this.readAuthority(txn);
      if (!row || row.generation !== authority.generation || row.expiresAt <= Date.now()) return null;
      this.storageOps += 1;
      return await txn.get<boolean>(`revoked:${row.grant}`) ? null : row;
    });
  }

  private async revoke(): Promise<{ revoked: true }> {
    await this.ctx.storage.transaction(async (txn) => {
      const authority = await this.readAuthority(txn);
      this.storageOps += 1;
      await txn.put("authority", { generation: authority.generation + 1, account: authority.account, registrationAttempts: authority.registrationAttempts ?? 0, tokenAttempts: authority.tokenAttempts ?? 0 });
    });
    return { revoked: true };
  }

  private async rebind(body: Record<string, unknown>): Promise<{ account: string }> {
    const account = stringField(body, "account");
    return this.ctx.storage.transaction(async (txn) => {
      const authority = await this.readAuthority(txn);
      if (authority.account === account) throw Object.assign(new Error("same account"), { status: 400 });
      this.storageOps += 1;
      await txn.put("authority", { generation: authority.generation + 1, account, registrationAttempts: authority.registrationAttempts ?? 0, tokenAttempts: authority.tokenAttempts ?? 0 });
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
  const loopback = allowed.hostname === "127.0.0.1" || allowed.hostname === "localhost" || allowed.hostname === "[::1]";
  return loopback && actual.hostname === allowed.hostname && actual.protocol === allowed.protocol && actual.username === allowed.username && actual.password === allowed.password && actual.pathname === allowed.pathname && actual.search === allowed.search && actual.hash === allowed.hash;
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw new Error("redirects");
  return value as string[];
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
        const attempt = await (await callAuthority(env, "/register-attempt", {})).json() as { ok?: boolean };
        if (!attempt.ok) return jsonResponse({ error: "invalid_request" }, { status: 429 });
        const body = JSON.parse(await readBounded(request)) as Record<string, unknown>;
        if ("client_secret" in body || "jwks" in body || "jwks_uri" in body) throw Object.assign(new Error("credential metadata"), { status: 400 });
        return callAuthority(env, "/register", body);
      }
      if (issuerOrigin && request.method === "GET" && url.pathname === "/authorize") {
        if (url.searchParams.get("response_type") !== "code") throw Object.assign(new Error("response_type"), { status: 400 });
        return callAuthority(env, "/begin", { client_id: url.searchParams.get("client_id"), redirect: url.searchParams.get("redirect_uri"), challenge: url.searchParams.get("code_challenge"), method: url.searchParams.get("code_challenge_method"), resource: url.searchParams.get("resource"), scope: url.searchParams.get("scope"), state: url.searchParams.get("state") });
      }
      if (issuerOrigin && request.method === "POST" && url.pathname === "/consent") return callAuthority(env, "/decide", JSON.parse(await readBounded(request)) as Record<string, unknown>);
      if (issuerOrigin && request.method === "POST" && url.pathname === "/revoke") return callAuthority(env, "/revoke", {});
      if (issuerOrigin && request.method === "POST" && url.pathname === "/rebind") return callAuthority(env, "/rebind", JSON.parse(await readBounded(request)) as Record<string, unknown>);
      if (issuerOrigin && request.method === "POST" && url.pathname === "/budget") return callAuthority(env, "/budget", {});
      if (issuerOrigin && request.method === "POST" && url.pathname === "/budget-reset") return callAuthority(env, "/budget-reset", {});
      if (issuerOrigin && request.method === "POST" && url.pathname === "/token") {
        const attempt = await (await callAuthority(env, "/token-attempt", {})).json() as { ok?: boolean };
        if (!attempt.ok) return jsonResponse({ error: "invalid_request" }, { status: 429 });
        return await token(await readBounded(request), env);
      }
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

async function readChunk(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<ReadableStreamReadResult<Uint8Array>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(Object.assign(new Error("body"), { status: 400 })), BODY_READ_DEADLINE_MS);
      })
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function discardReader(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> {
  for (;;) {
    const { done } = await readChunk(reader);
    if (done) break;
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
    const { done, value } = await readChunk(reader);
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
  if (!resource) return jsonResponse({ error: "invalid_request" }, { status: 400 });
  if (grant === "authorization_code") {
    const verifier = form.get("code_verifier");
    if (!verifier || !/^[A-Za-z0-9._~-]{43,128}$/u.test(verifier)) return jsonResponse({ error: "invalid_request" }, { status: 400 });
  }
  if (grant !== "authorization_code" && grant !== "refresh_token") return jsonResponse({ error: "unsupported_grant_type" }, { status: 400 });
  return callAuthority(env, "/token", Object.fromEntries(form));
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
  const body = JSON.parse(await readBounded(request)) as { id?: string | number; method?: string };
  if (body.id === undefined) return new Response(null, { status: 202 });
  if (body.method === "initialize") {
    return jsonResponse({ jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "synthetic", version: "0" } } });
  }
  if (body.method === "tools/list") {
    return jsonResponse({ jsonrpc: "2.0", id: body.id, result: { tools: [{ name: "runtime_probe", description: "Synthetic authenticated resource probe", inputSchema: { type: "object", properties: {} } }] } });
  }
  return jsonResponse({ jsonrpc: "2.0", id: body.id, error: { code: -32601, message: "Method not found" } });
}

