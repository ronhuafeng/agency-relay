import { createServer } from "node:http";
import { mkdirSync, readFileSync, watch } from "node:fs";
import { readSnapshot, reportSnapshotColumns } from "./snapshot";
import { createPreviewFixture, scenarios, type Scenario } from "./fixtures";
import { buildPreviewRouter, emulateTheme, forwardPreviewRequest, type PreviewTheme } from "./transport";

const port = Number(process.env.PREVIEW_PORT ?? 4183);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("PREVIEW_PORT must be between 1024 and 65535");
const localOrigin = `http://127.0.0.1:${port}`;
let scene: Scenario = "populated";
let role = "admin";
let theme: PreviewTheme = "light";
const preferredEmail = process.env.PREVIEW_ACCOUNT_EMAIL;
let fixture = await createPreviewFixture(scene, preferredEmail);
let revision = 0;
let preview: Awaited<ReturnType<typeof buildPreviewRouter>>;
mkdirSync("tmp/console-preview", { recursive: true });
async function rebuild() {
  preview = await buildPreviewRouter("tmp/console-preview", ++revision);
  if(scene==="runtime") {const next=await createPreviewFixture(scene);const previous=fixture;fixture=next;await previous.close();}
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
      const workbench = readFileSync(new URL("./workbench.html", import.meta.url), "utf8");
      const theme = readFileSync(new URL("../../src/console/generated/tokens.css", import.meta.url), "utf8");
      outgoing.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(workbench.replace("<style>", `<style>${theme}</style><style>`)); return;
    }
    if (url.pathname === "/__preview/data" && method === "GET") { const snapshot = readSnapshot(); outgoing.setHeader("Content-Type", "application/json"); outgoing.end(JSON.stringify({ snapshot: Boolean(snapshot), capturedAt: snapshot?.capturedAt, reporting: Boolean(snapshot && Object.keys(reportSnapshotColumns).every(table => Array.isArray(snapshot.tables[table]))), accountScoped: Boolean(snapshot?.accountScoped), requestHistory: snapshot?.requestHistory, roles: snapshot ? [...new Set(snapshot.tables.users.filter(row => row.status === "active" && row.login_capable === 1 && row.account_kind === "human").map(row => row.role === "admin" ? "admin" : "member"))] : ["admin", "member"] })); return; }
    if (url.pathname === "/__preview/revision" && method === "GET") { outgoing.end(String(revision)); return; }
    if (url.pathname === "/__preview/config" && method === "POST") {
      const input = JSON.parse(body.toString()) as { scene?: Scenario; role?: string; theme?: string; reset?: boolean };
      if (!scenarios.includes(input.scene!) || !["admin", "member"].includes(input.role!) || !["light", "dark", "system"].includes(input.theme!)) { outgoing.writeHead(400).end(); return; }
      if (scene !== input.scene || input.reset) { const next = await createPreviewFixture(input.scene!, preferredEmail); const previous = fixture; fixture = next; scene = input.scene!; await previous.close(); }
      role = input.role!; theme = input.theme as PreviewTheme; outgoing.end("ok"); return;
    }
    if (url.pathname === "/__preview/primitives" && method === "GET") { outgoing.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(emulateTheme(preview.renderPrimitiveGallery(), theme)); return; }
    // Service worker caching/registration is outside this preview's transport contract.
    if (url.pathname === "/admin/app-worker.js") { outgoing.writeHead(404).end(); return; }
    const response = await forwardPreviewRequest({ url, method, headers: incoming.headers, body, localOrigin, cookie: fixture.cookies.get(role)!, theme, fixture, handleRequest: preview.handleRequest });
    outgoing.writeHead(response.status, response.headers); outgoing.end(response.content);
  } catch {
    outgoing.writeHead(500, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" }).end("本地预览加载失败。请重置示例后重试。");
  }
});
await new Promise<void>((done, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", done); });
console.info(`Agency Relay preview: ${localOrigin}/__preview`);
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, async () => { watcher.close(); tokenWatcher.close(); clearTimeout(timer); server.closeAllConnections(); server.close(); await fixture.close(); process.exit(0); });
