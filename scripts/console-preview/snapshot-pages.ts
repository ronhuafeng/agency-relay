import { createServer } from "node:http";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "@playwright/test";
import { DASHBOARD_VIEW_DEFINITIONS } from "../../src/admin/dashboard-data";
import { memberHref } from "../../src/admin/member-href";
import { createPreviewFixture, type PreviewFixture, type Scenario } from "./fixtures";
import { buildPreviewRouter, forwardPreviewRequest, type PreviewTheme } from "./transport";

/**
 * Non-interactive review captures: production SSR/client/CSS against synthetic local
 * scenarios, without Wrangler, Miniflare or an operator database. Output is ignored
 * under tmp/ and is review material, not a test baseline or shared evidence.
 */
const outdir = "tmp/console-snapshots";
const themes = ["light", "dark"] as const satisfies readonly PreviewTheme[];
const widths = [1280, 390] as const;
const scenes = ["populated", "empty", "long"] as const satisfies readonly Scenario[];
const filter = process.argv.slice(2).find(arg => !arg.startsWith("--"));

interface Target { readonly name: string; readonly role: "admin" | "member" | "gallery"; readonly url: string; readonly scenes: readonly Scenario[] }
const targets: readonly Target[] = [
  ...DASHBOARD_VIEW_DEFINITIONS.map(view => ({ name: `admin-${view.key}`, role: "admin" as const, url: `/admin?view=${view.key}`, scenes })),
  { name: "admin-person", role: "admin", url: "/admin?view=access&person=member", scenes: ["populated", "long"] },
  { name: "admin-service-account", role: "admin", url: "/admin?view=access&person=service-build", scenes: ["populated"] },
  { name: "admin-connection", role: "admin", url: "/admin?view=credentials&account=codex%3Apreview-codex", scenes: ["populated"] },
  ...(["home", "keys", "usage", "quota", "setup"] as const).map(view => ({ name: `member-${view}`, role: "member" as const, url: memberHref(view), scenes })),
  { name: "member-key", role: "member", url: memberHref("keys", "member-key"), scenes: ["populated"] },
  { name: "primitives", role: "gallery", url: "/__preview/primitives", scenes: ["populated"] }
];

// A filtered run refreshes only its own captures.
if (!filter) rmSync(outdir, { recursive: true, force: true });
mkdirSync(outdir, { recursive: true });
const preview = await buildPreviewRouter(outdir, 1);
let fixture: PreviewFixture | undefined;
let role = "admin";
let theme: PreviewTheme = "light";
const server = createServer(async (incoming, outgoing) => {
  try {
    const url = new URL(incoming.url ?? "/", localOrigin);
    const method = incoming.method ?? "GET";
    // Captures are read-only. Writes, workers and external destinations are outside this command.
    if (!["GET", "HEAD"].includes(method) || url.pathname === "/admin/app-worker.js" || !fixture) { outgoing.writeHead(404).end(); return; }
    if (url.pathname === "/__preview/primitives") { outgoing.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(preview.renderPrimitiveGallery()); return; }
    const response = await forwardPreviewRequest({ url, method, headers: incoming.headers, body: Buffer.alloc(0), localOrigin, cookie: fixture.cookies.get(role)!, theme, fixture, handleRequest: preview.handleRequest });
    outgoing.writeHead(response.status, response.headers); outgoing.end(response.content);
  } catch {
    outgoing.writeHead(500).end();
  }
});
await new Promise<void>((done, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", done); });
const address = server.address();
if (!address || typeof address === "string") throw new Error("Snapshot server did not bind a loopback port");
const localOrigin = `http://127.0.0.1:${address.port}`;

const browser = await chromium.launch();
const failures: string[] = [];
let count = 0;
try {
  for (const scene of scenes) {
    const selected = targets.filter(target => target.scenes.includes(scene) && (!filter || target.name.includes(filter)));
    if (!selected.length) continue;
    fixture = await createPreviewFixture(scene);
    try {
      for (const target of selected) {
        role = target.role === "member" ? "member" : "admin";
        for (const nextTheme of themes) {
          theme = nextTheme;
          for (const width of widths) {
            const context = await browser.newContext({ viewport: { width, height: 900 }, colorScheme: nextTheme, serviceWorkers: "block" });
            // The synthetic origin must not reach the network.
            await context.route(url => !url.href.startsWith(localOrigin), route => route.abort());
            const page = await context.newPage();
            try {
              const response = await page.goto(`${localOrigin}${target.url}`, { waitUntil: "load" });
              await page.evaluate(() => document.fonts.ready);
              const file = join(outdir, scene, `${target.name}-${nextTheme}-${width}`);
              mkdirSync(join(outdir, scene), { recursive: true });
              if (width === widths[0] && nextTheme === themes[0]) writeFileSync(`${join(outdir, scene, target.name)}.html`, await page.content());
              await page.screenshot({ path: `${file}.png`, fullPage: true, animations: "disabled" });
              count++;
              if (!response?.ok()) failures.push(`${scene}/${target.name}: HTTP ${response?.status() ?? "none"}`);
            } finally { await context.close(); }
          }
        }
      }
    } finally { await fixture.close(); fixture = undefined; }
  }
} finally {
  await browser.close();
  server.close();
}
console.info(`Wrote ${count} screenshots to ${outdir}/`);
if (failures.length) { console.error(failures.join("\n")); process.exitCode = 1; }
