import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { PREVIEW_ORIGIN, type PreviewFixture } from "./fixtures";

export type PreviewTheme = "light" | "dark" | "system";
type HandleRequest = typeof import("../../src/router").handleRequest;

export interface PreviewBuild {
  readonly handleRequest: HandleRequest;
  readonly renderPrimitiveGallery: () => string;
}

/** Builds the generated client/CSS, then bundles the production router and primitive gallery for Node. */
export async function buildPreviewRouter(outdir: string, revision: number): Promise<PreviewBuild> {
  execFileSync("pnpm", ["run", "console:build"], { stdio: "ignore" });
  const bundle = async <T>(entry: string, name: string): Promise<T> => {
    const outfile = resolve(outdir, name);
    await build({ entryPoints: [entry], outfile, bundle: true, platform: "node", format: "esm", packages: "external", jsx: "automatic", define: { "process.env.NODE_ENV": '"production"' }, logLevel: "silent" });
    return await import(`${pathToFileURL(outfile).href}?v=${revision}`) as T;
  };
  const router = await bundle<typeof import("../../src/router")>("src/router.ts", "worker.mjs");
  const gallery = await bundle<typeof import("./primitives")>("scripts/console-preview/primitives.tsx", "primitives.mjs");
  return { handleRequest: router.handleRequest, renderPrimitiveGallery: gallery.renderPrimitiveGallery };
}

interface ForwardInput {
  readonly url: URL;
  readonly method: string;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly body: Buffer<ArrayBuffer>;
  readonly localOrigin: string;
  readonly cookie: string;
  readonly theme: PreviewTheme;
  readonly fixture: PreviewFixture;
  readonly handleRequest: HandleRequest;
}

/** Maps a loopback request to the canonical fixture origin and injects the local session server-side. */
export async function forwardPreviewRequest(input: ForwardInput): Promise<{ status: number; headers: Record<string, string>; content: Buffer }> {
  const canonical = new URL(input.url.pathname + input.url.search, PREVIEW_ORIGIN);
  const headers = new Headers();
  for (const [name, value] of Object.entries(input.headers)) if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(", ") : value);
  headers.set("Host", new URL(PREVIEW_ORIGIN).host);
  headers.set("Cookie", input.cookie);
  if (headers.get("Origin") === input.localOrigin) headers.set("Origin", PREVIEW_ORIGIN);
  const request = new Request(canonical, { method: input.method, headers, ...(input.body.length ? { body: input.body } : {}) });
  const response = input.fixture.dispatchRequest ? await input.fixture.dispatchRequest(request) : await input.handleRequest(request, input.fixture.env, { waitUntil: promise => { void promise.catch(() => console.error("Preview background operation failed.")); } }, { now: () => new Date(), fetch: async () => { throw new Error("Provider network is unavailable in local scenarios"); } });
  const responseHeaders = new Headers(response.headers);
  responseHeaders.delete("Set-Cookie");
  const location = responseHeaders.get("Location");
  if (location?.startsWith(PREVIEW_ORIGIN)) responseHeaders.set("Location", location.replace(PREVIEW_ORIGIN, input.localOrigin));
  let content = Buffer.from(await response.arrayBuffer());
  if (responseHeaders.get("Content-Type")?.includes("text/html")) {
    // Preview-only framing and theme emulation. The product response stays unchanged.
    responseHeaders.set("Content-Security-Policy", (responseHeaders.get("Content-Security-Policy") ?? "").replace("frame-ancestors 'none'", "frame-ancestors 'self'"));
    responseHeaders.set("X-Frame-Options", "SAMEORIGIN");
    content = Buffer.from(emulateTheme(content.toString().replaceAll(PREVIEW_ORIGIN, input.localOrigin), input.theme));
  }
  responseHeaders.delete("Content-Length");
  return { status: response.status, headers: Object.fromEntries(responseHeaders), content };
}

/** Forces the selected theme for both color-scheme media queries and native controls. */
export function emulateTheme(html: string, theme: PreviewTheme): string {
  if (theme === "system") return html;
  return html.replace('name="color-scheme" content="light dark"', `name="color-scheme" content="${theme}"`)
    .replaceAll(/color-scheme:\s*light dark/g, `color-scheme:${theme}`)
    .replaceAll("prefers-color-scheme:dark", theme === "dark" ? "min-width:0px" : "min-width:999999px")
    .replaceAll("prefers-color-scheme: dark", theme === "dark" ? "min-width:0px" : "min-width:999999px");
}
