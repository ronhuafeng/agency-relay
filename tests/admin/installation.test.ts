import { describe, expect, it } from "vitest";
import { JSDOM } from "jsdom";
import { handleRequest } from "../../src/router";
import { DASHBOARD_APP_PATHS } from "../../src/admin/app";
import { memberHref } from "../../src/admin/member-href";
import { consoleCookie, makeFixture } from "../router/fixture";

const ORIGIN = "https://admin.example.test";
describe("shared authenticated console installation", () => {
  it.each(["user", "admin"] as const)("serves only exact shared resources to an active %s", async role => {
    const f = makeFixture();
    f.db.seedConsoleUser({ id: "viewer", email: "viewer@example.com", role });
    const token = await consoleCookie(f, "viewer@example.com");
    const call = (path: string, cookie = true, origin = ORIGIN) => handleRequest(new Request(`${origin}${path}`, { headers: cookie ? { Cookie: `__Host-mini-console=${token}` } : {} }), f.env, f.ctx, f.deps);
    for (const path of DASHBOARD_APP_PATHS) {
      const response = await call(path);
      expect(response.status).toBe(200);
      expect(response.headers.get("Cache-Control")).toBe("no-store");
      expect(response.headers.get("Content-Type")).toContain(path.endsWith("webmanifest") ? "manifest+json" : path.endsWith("js") ? "javascript" : "image/png");
      expect((await call(path, false)).status).toBe(403);
      expect((await call(path, true, "https://untrusted.invalid")).status).toBe(404);
    }
    const doc = new JSDOM(await (await call("/")).text()).window.document;
    expect(doc.querySelector('link[rel="manifest"]')?.getAttribute("crossorigin")).toBe("use-credentials");
    expect(doc.querySelector('link[rel="apple-touch-icon"]')?.getAttribute("href")).toBe("/admin/app-icon-192.png");
    expect(doc.querySelector(role === "admin" ? '[data-dashboard-view="overview"]' : '[data-member-view="home"]')).not.toBeNull();
    await f.env.DB.prepare("UPDATE users SET status = 'disabled' WHERE id = 'viewer'").run();
    for (const path of DASHBOARD_APP_PATHS) expect((await call(path)).status).toBe(403);
  });

  it("keeps an administrator's personal HTML separate and current-role home authoritative", async () => {
    const f = makeFixture();
    f.db.seedConsoleUser({ id: "viewer", email: "viewer@example.com", role: "admin" });
    f.db.seedConsoleUser({ id: "other", email: "other-private@example.com", role: "user" });
    const token = await consoleCookie(f, "viewer@example.com");
    const call = (path: string) => handleRequest(new Request(`${ORIGIN}${path}`, { headers: { Cookie: `__Host-mini-console=${token}` } }), f.env, f.ctx, f.deps);
    const own = await call(memberHref("keys"));
    expect(own.status).toBe(200);
    const ownDoc = new JSDOM(await own.text()).window.document;
    expect(ownDoc.querySelector('[data-member-view="keys"]')).not.toBeNull();
    expect(ownDoc.body.textContent).not.toContain("other-private@example.com");
    expect([...ownDoc.querySelectorAll('[data-member-nav] a[href*="view="]')].every(a => new URL(a.getAttribute("href")!, ORIGIN).searchParams.get("area") === "me")).toBe(true);
    expect((await call("/admin?area=unknown&view=keys")).status).toBe(404);
    expect((await call("/admin?area=me&area=me&view=keys")).status).toBe(404);
    await f.env.DB.prepare("UPDATE users SET role = 'user' WHERE id = 'viewer'").run();
    expect(new JSDOM(await (await call("/")).text()).window.document.querySelector('[data-member-view="home"]')).not.toBeNull();
    expect((await call("/admin?view=access&person=other")).status).toBe(404);
    expect((await call("/admin/codex-auths")).status).toBe(403);
  });

  it("encodes an exact personal key target without accepting caller URL structure", () => {
    const url = new URL(memberHref("setup", "key /?other=1#x"), ORIGIN);
    expect(url.pathname).toBe("/admin");
    expect([...url.searchParams]).toEqual([["area", "me"], ["view", "setup"], ["key", "key /?other=1#x"]]);
  });
});
