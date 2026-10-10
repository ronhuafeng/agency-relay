import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { build } from "esbuild";
import { expect, it } from "vitest";

const { Miniflare, convertV4MiniflareOptions } = createRequire(import.meta.resolve("wrangler/package.json"))("miniflare");
const CODEX_PACKAGE = "/tmp/codex-cli";

async function codexBin(): Promise<string> {
  const bin = join(CODEX_PACKAGE, "node_modules/.bin/codex");
  if (!existsSync(bin)) await run("npm", ["install", "--prefix", CODEX_PACKAGE, "@openai/codex@0.156.1"]);
  return bin;
}

function run(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "ignore" });
    child.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`${command} exited ${code}`)));
  });
}

function listen(handler: (request: IncomingMessage, response: ServerResponse) => void): Promise<{ port: number; close: () => Promise<void> }> {
  const server = createServer(handler);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("no port");
      resolve({ port: address.port, close: () => new Promise((done, fail) => server.close((error) => error ? fail(error) : done())) });
    });
  });
}

it("lets Codex 0.156.1 complete login and present the bearer", async () => {
  let resourceOrigin = "";
  let issuerOrigin = "";
  const resourceServer = await listen((request, response) => void forward(resourceOrigin, request, response));
  const issuerServer = await listen((request, response) => void forward(issuerOrigin, request, response));
  resourceOrigin = `http://127.0.0.1:${resourceServer.port}`;
  issuerOrigin = `http://127.0.0.1:${issuerServer.port}`;
  const compiled = await build({
    stdin: {
      contents: `export { RuntimeGrantAuthority } from "./tests/runtime/synthetic-oauth-worker";
        import worker from "./tests/runtime/synthetic-oauth-worker";
        export default worker;`,
      resolveDir: process.cwd(), sourcefile: "synthetic-oauth-codex-fixture.ts"
    },
    bundle: true, write: false, format: "esm", platform: "browser", external: ["cloudflare:workers", "node:*"],
    define: { "process.env.NODE_ENV": '"production"' }, logLevel: "silent"
  });
  const runtime = new Miniflare(convertV4MiniflareOptions({
    modules: true, script: compiled.outputFiles[0]!.text, compatibilityDate: "2026-06-24", compatibilityFlags: ["nodejs_compat"],
    bindings: {
      ADMIN_DASHBOARD_HOST: "127.0.0.1",
      OAUTH_ISSUER_ORIGIN: issuerOrigin,
      OAUTH_RESOURCE_ORIGIN: resourceOrigin,
      OAUTH_OTHER_RESOURCE_ORIGIN: "https://other.example.test"
    },
    durableObjects: { GRANTS: { className: "RuntimeGrantAuthority", useSQLite: true } }
  }));
  const forward = async (origin: string, request: IncomingMessage, response: ServerResponse) => {
    const incoming = new URL(request.url ?? "/", origin);
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks);
    if (request.method === "GET" && incoming.pathname === "/authorize") {
      const begun = await runtime.dispatchFetch(incoming.href);
      const consent = await begun.json() as { consent_id?: string };
      const allowed = await runtime.dispatchFetch(`${issuerOrigin}/consent`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: "https://127.0.0.1", "Sec-Fetch-Site": "same-origin" },
        body: JSON.stringify({ consent_id: consent.consent_id, decision: "allow" })
      });
      const decision = await allowed.json() as { redirect?: string };
      if (!decision.redirect) {
        response.writeHead(allowed.status).end();
        return;
      }
      response.writeHead(302, { Location: decision.redirect }).end();
      return;
    }
    const headers = new Headers();
    if (request.headers.authorization) headers.set("authorization", request.headers.authorization);
    if (request.headers["content-type"]) headers.set("content-type", String(request.headers["content-type"]));
    if (request.headers.accept) headers.set("accept", String(request.headers.accept));
    const upstream = await runtime.dispatchFetch(incoming.href, { method: request.method, headers, body: body.length > 0 ? body : undefined });
    response.writeHead(upstream.status, { "content-type": upstream.headers.get("content-type") ?? "application/octet-stream" });
    response.end(Buffer.from(await upstream.arrayBuffer()));
  };
  const home = await mkdtemp(join(tmpdir(), "codex-oauth-"));
  const bin = await codexBin();
  try {
    await writeFile(join(home, "config.toml"), `[mcp_servers.probe]\nurl = "${resourceOrigin}/mcp"\n`);
    await new Promise<void>((resolve, reject) => {
      const child = spawn("python3", ["-c", LOGIN, bin, home, `${resourceOrigin}/mcp`], { stdio: ["ignore", "pipe", "pipe"] });
      let output = "";
      child.stdout.on("data", (chunk) => { output += String(chunk); });
      child.stderr.on("data", (chunk) => { output += String(chunk); });
      const timer = setTimeout(() => { child.kill(); reject(new Error("codex login timed out")); }, 25_000);
      child.on("exit", (code) => {
        clearTimeout(timer);
        if (code === 0 && output.includes("success")) resolve();
        else reject(new Error("codex login failed"));
      });
    });
    const status = await appServerStatus(bin, home);
    expect(status).toContain("authStatus=oAuth");
  } finally {
    await rm(home, { recursive: true, force: true });
    await resourceServer.close();
    await issuerServer.close();
    await runtime.dispose();
  }
}, 60_000);

const LOGIN = String.raw`
import os, pty, select, subprocess, sys, time
from urllib.request import urlopen
bin, home, _resource = sys.argv[1:]
env = os.environ.copy()
env["CODEX_HOME"] = home
master, slave = pty.openpty()
login = subprocess.Popen([bin, "mcp", "login", "probe", "--no-browser", "--oauth-client-registration", "dcr"], env=env, stdin=slave, stdout=slave, stderr=slave)
os.close(slave)
buf = b""
url = None
deadline = time.time() + 20
while time.time() < deadline and url is None and login.poll() is None:
    ready, _, _ = select.select([master], [], [], 1)
    if not ready:
        continue
    try:
        buf += os.read(master, 4096)
    except OSError:
        break
    text = buf.decode("utf-8", "replace")
    marker = "http://127.0.0.1:"
    auth = "/authorize?"
    if auth in text:
        start = text.rfind(marker, 0, text.index(auth) + len(auth))
        if start >= 0:
            url = text[start:].split()[0].strip()
if url:
    try:
        urlopen(url, timeout=8).read()
    except Exception:
        pass
deadline = time.time() + 15
while time.time() < deadline and login.poll() is None and b"Successfully logged in" not in buf:
    ready, _, _ = select.select([master], [], [], 1)
    if ready:
        try:
            buf += os.read(master, 4096)
        except OSError:
            break
if login.poll() is None:
    login.kill()
print("success" if b"Successfully logged in" in buf else "failed")
raise SystemExit(0 if b"Successfully logged in" in buf else 1)
`;

async function appServerStatus(bin: string, home: string): Promise<string> {
  const child = spawn(bin, ["app-server"], { cwd: tmpdir(), env: { ...process.env, CODEX_HOME: home }, stdio: ["pipe", "pipe", "ignore"] });
  const send = (value: unknown) => child.stdin!.write(`${JSON.stringify(value)}\n`);
  send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { clientInfo: { name: "probe", version: "0" }, capabilities: { experimentalApi: true } } });
  await readLine(child, (line) => line.includes('"id":1') || line.includes('"id": 1'));
  send({ jsonrpc: "2.0", method: "initialized" });
  send({ jsonrpc: "2.0", id: 2, method: "mcpServerStatus/list", params: { detail: "toolsAndAuthOnly", limit: 5 } });
  const result = await readLine(child, (line) => line.includes('"id":2') || line.includes('"id": 2'));
  child.kill();
  const fields: string[] = [];
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) value.forEach(walk);
    else if (value && typeof value === "object") {
      for (const [key, item] of Object.entries(value)) {
        if ((key === "authStatus" || key === "name") && typeof item === "string") fields.push(`${key}=${item}`);
        else walk(item);
      }
    }
  };
  walk(JSON.parse(result).result);
  return fields.join(" ");
}

function readLine(child: ReturnType<typeof spawn>, match: (line: string) => boolean): Promise<string> {
  return new Promise((resolve, reject) => {
    let pending = "";
    const timer = setTimeout(() => { child.kill(); reject(new Error("app-server timed out")); }, 20_000);
    child.stdout!.on("data", (chunk) => {
      pending += String(chunk);
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) if (match(line)) { clearTimeout(timer); resolve(line); }
    });
  });
}
