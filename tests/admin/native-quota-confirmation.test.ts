import { expect, it } from "vitest";
import { JSDOM } from "jsdom";
import { handleRequest } from "../../src/router";
import { consoleCookie, makeFixture, seedDashboardAdmin } from "../router/fixture";

it("retains a native quota commit acknowledgement through a following read failure and recovers with GET", async () => {
  const fixture = makeFixture();
  seedDashboardAdmin(fixture);
  const cookie = `__Host-mini-console=${await consoleCookie(fixture, "operator@example.com")}`;
  const real = fixture.env.DB;
  let quotaReads = 0;
  let failedReads = 0;
  fixture.env.DB = new Proxy(real, {
    get(target, property) {
      if (property === "prepare") return (sql: string) => {
        if (sql.includes("SELECT surface_grant, monthly_allowance") && sql.includes("FROM organization_surface_credit_defaults") && ++quotaReads === 1) {
          failedReads++;
          throw new Error("synthetic quota read failure after commit");
        }
        return target.prepare(sql);
      };
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    }
  });
  const open = (url: string) => handleRequest(new Request(new URL(url, "https://admin.example.test"), {
    headers: { Accept: "text/html", "Sec-Fetch-Mode": "navigate", Cookie: cookie }
  }), fixture.env, fixture.ctx, fixture.deps);
  const post = await handleRequest(new Request("https://admin.example.test/admin/ui/credit-defaults", {
    method: "POST",
    headers: { Accept: "text/html", "Sec-Fetch-Mode": "navigate", Origin: "https://admin.example.test", Cookie: cookie, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ confirm: "1", codex: "129", grok: "1000000", xai: "1000000", expected_codex: "1000000", expected_grok: "1000000", expected_xai: "1000000" })
  }), fixture.env, fixture.ctx, fixture.deps);
  const visible = post.status === 303 ? await open(post.headers.get("location")!) : post;
  const saved = await real.prepare("SELECT monthly_allowance FROM organization_surface_credit_defaults WHERE surface_grant = 'surface:codex:production'").first<{ monthly_allowance: number }>();
  expect(saved?.monthly_allowance).toBe(129);
  expect(visible.status).toBe(503);
  expect(failedReads).toBe(1);
  const document = new JSDOM(await visible.text()).window.document;
  expect(Boolean(document.querySelector('[data-mutation-flash="credit_default"]')), "Committed native write remains explicitly acknowledged").toBe(true);
  expect(Boolean(document.querySelector('[data-dashboard-unavailable]'))).toBe(true);
  expect(document.querySelector('[data-mutation-flash="credit_default"]')?.textContent).toContain("每月 129 credits");
  const recovery = document.querySelector<HTMLAnchorElement>('[data-quota-confirmed-read]');
  expect(recovery?.getAttribute("href")).toBe("/admin?view=quotas");
  expect(post.headers.get("location")).toBeNull();
  fixture.env.DB = real;
  const fresh = await open(recovery!.getAttribute("href")!);
  expect(fresh.status).toBe(200);
  const page = new JSDOM(await fresh.text()).window.document;
  expect(page.querySelector<HTMLInputElement>('[data-quota-default="codex"] input[name="codex"]')?.value).toBe("129");
  const audits = await real.prepare("SELECT COUNT(*) AS count FROM operator_mutation_audit WHERE action = 'credit_default.set' AND result = 'ok'").first<{ count: number }>();
  expect(audits?.count).toBe(3);
});
