import { createServer } from "node:http";
import { mkdirSync, readFileSync, watch } from "node:fs";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { readSnapshot, reportSnapshotColumns } from "./snapshot";
import { createPreviewFixture, PREVIEW_ORIGIN, scenarios, type Scenario } from "./fixtures";

const port = Number(process.env.PREVIEW_PORT ?? 4183);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("PREVIEW_PORT must be between 1024 and 65535");
const localOrigin = `http://127.0.0.1:${port}`;
let scene: Scenario = "populated";
let role = "admin";
let theme = "light";
const preferredEmail = process.env.PREVIEW_ACCOUNT_EMAIL;
let fixture = await createPreviewFixture(scene, preferredEmail);
let revision = 0;
let handleRequest: typeof import("../../src/router").handleRequest;
mkdirSync("tmp/console-preview", { recursive: true });
async function rebuild() {
  execFileSync("pnpm", ["run", "console:build"], { stdio: "ignore" });
  const outfile = resolve("tmp/console-preview/worker.mjs");
  await build({ entryPoints: ["src/router.ts"], outfile, bundle: true, platform: "node", format: "esm", packages: "external", define: { "process.env.NODE_ENV": '"production"' }, logLevel: "silent" });
  const module = await import(`${pathToFileURL(outfile).href}?v=${++revision}`) as typeof import("../../src/router");
  handleRequest = module.handleRequest;
}
await rebuild();
let timer: ReturnType<typeof setTimeout> | undefined;
let building = false;
let dirty = false;
async function update() {
  if (building) { dirty = true; return; }
  building = true;
  try { await rebuild(); console.info("Preview code updated."); } catch { console.error("Preview build failed. Run pnpm run console:build for diagnostics."); }
  finally { building = false; if (dirty) { dirty = false; void update(); } }
}
function scheduleRefresh(): void {
  clearTimeout(timer); timer = setTimeout(() => void update(), 250);
}
const watcher = watch("src", { recursive: true }, (_event, file) => {
  if (!file || file.includes("generated/")) return;
  scheduleRefresh();
});
const tokenWatcher = watch("tokens", { recursive: true }, () => scheduleRefresh());
const server = createServer(async (incoming, outgoing) => {
  try {
    if (incoming.headers.host !== new URL(localOrigin).host) { outgoing.writeHead(421).end(); return; }
    const url = new URL(incoming.url ?? "/", localOrigin);
    const method = incoming.method ?? "GET";
    // Keep the application's existing same-origin rule at the local transport edge.
    if (!["GET", "HEAD"].includes(method) && (incoming.headers.origin !== localOrigin || incoming.headers["sec-fetch-site"] === "cross-site")) { outgoing.writeHead(403).end(); return; }
    outgoing.setHeader("Cache-Control", "no-store");
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of incoming) { size += chunk.length; if (size > 2_000_000) { outgoing.writeHead(413).end(); return; } chunks.push(Buffer.from(chunk)); }
    const body = Buffer.concat(chunks);
    if (url.pathname === "/__preview" && method === "GET") {
      outgoing.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(readFileSync(new URL("./workbench.html", import.meta.url))); return;
    }
    if (url.pathname === "/__preview/data" && method === "GET") { const snapshot = readSnapshot(); outgoing.setHeader("Content-Type", "application/json"); outgoing.end(JSON.stringify({ snapshot: Boolean(snapshot), capturedAt: snapshot?.capturedAt, reporting: Boolean(snapshot && Object.keys(reportSnapshotColumns).every(table => Array.isArray(snapshot.tables[table]))), accountScoped: Boolean(snapshot?.accountScoped), requestHistory: snapshot?.requestHistory, roles: snapshot ? [...new Set(snapshot.tables.users.filter(row => row.status === "active" && row.login_capable === 1 && row.account_kind === "human").map(row => row.role === "admin" ? "admin" : "member"))] : ["admin", "member"] })); return; }
    if (url.pathname === "/__preview/revision" && method === "GET") { outgoing.end(String(revision)); return; }
    if (url.pathname === "/__preview/config" && method === "POST") {
      const input = JSON.parse(body.toString()) as { scene?: Scenario; role?: string; theme?: string; reset?: boolean };
      if (!scenarios.includes(input.scene!) || !["admin", "member"].includes(input.role!) || !["light", "dark", "system"].includes(input.theme!)) { outgoing.writeHead(400).end(); return; }
      if (scene !== input.scene || input.reset) { const next = await createPreviewFixture(input.scene!, preferredEmail); const previous = fixture; fixture = next; scene = input.scene!; previous.close(); }
      role = input.role!; theme = input.theme!; outgoing.end("ok"); return;
    }
    // Service worker caching/registration is outside this preview's transport contract.
    if (url.pathname === "/admin/app-worker.js") { outgoing.writeHead(404).end(); return; }
    const canonical = new URL(url.pathname + url.search, PREVIEW_ORIGIN);
    const headers = new Headers();
    for (const [name, value] of Object.entries(incoming.headers)) if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(", ") : value);
    headers.set("Host", new URL(PREVIEW_ORIGIN).host);
    headers.set("Cookie", fixture.cookies.get(role)!);
    if (headers.get("Origin") === localOrigin) headers.set("Origin", PREVIEW_ORIGIN);
    const response = await handleRequest(new Request(canonical, { method, headers, ...(body.length ? { body } : {}) }), fixture.env, { waitUntil: promise => { void promise.catch(() => console.error("Preview background operation failed.")); } }, { now: () => new Date(), fetch: async () => { throw new Error("Provider network is unavailable in local scenarios"); } });
    const responseHeaders = new Headers(response.headers);
    responseHeaders.delete("Set-Cookie");
    const location = responseHeaders.get("Location");
    if (location?.startsWith(PREVIEW_ORIGIN)) responseHeaders.set("Location", location.replace(PREVIEW_ORIGIN, localOrigin));
    let content = Buffer.from(await response.arrayBuffer());
    if (responseHeaders.get("Content-Type")?.includes("text/html")) {
      // Preview-only framing and theme emulation. The product response stays unchanged.
      responseHeaders.set("Content-Security-Policy", (responseHeaders.get("Content-Security-Policy") ?? "").replace("frame-ancestors 'none'", "frame-ancestors 'self'"));
      responseHeaders.set("X-Frame-Options", "SAMEORIGIN");
      let html = content.toString().replaceAll(PREVIEW_ORIGIN, localOrigin);
      if (theme !== "system") {
        html = html.replace('name="color-scheme" content="light dark"', `name="color-scheme" content="${theme}"`)
          .replaceAll(/color-scheme:\s*light dark/g, `color-scheme:${theme}`)
          .replaceAll("prefers-color-scheme:dark", theme === "dark" ? "min-width:0px" : "min-width:999999px")
          .replaceAll("prefers-color-scheme: dark", theme === "dark" ? "min-width:0px" : "min-width:999999px");
      }
      content = Buffer.from(html);
    }
    responseHeaders.delete("Content-Length");
    outgoing.writeHead(response.status, Object.fromEntries(responseHeaders)); outgoing.end(content);
  } catch {
    outgoing.writeHead(500, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" }).end("本地预览加载失败。请重置示例后重试。");
  }
});
await new Promise<void>((done, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", done); });
console.info(`Agency Relay preview: ${localOrigin}/__preview`);
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => { watcher.close(); tokenWatcher.close(); clearTimeout(timer); server.closeAllConnections(); server.close(); fixture.close(); process.exit(0); });
