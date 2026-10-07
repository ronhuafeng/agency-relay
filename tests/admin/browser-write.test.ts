import { describe, expect, it } from "vitest";
import { SHARED_CODEX_AUTH_ID } from "../../src/db";
import { handleRequest } from "../../src/router";
import { admin, consoleCookie, makeFixture, seedDashboardAdmin } from "../router/fixture";

async function consoleWrite(
  fixture: ReturnType<typeof makeFixture>,
  url: string,
  input: { method?: string; body?: string; contentType?: string; origin?: string | null; fetchSite?: string; token?: string | null; emailHeader?: string }
): Promise<Response> {
  const headers = new Headers();
  if (input.token !== null) {
    const existing = await fixture.env.DB.prepare(
      "SELECT id FROM users WHERE canonical_email = 'operator@example.com' AND login_capable = 1"
    ).first();
    if (existing) headers.set("Cookie", `__Host-mini-console=${await consoleCookie(fixture, "operator@example.com")}`);
  }
  if (input.origin) headers.set("Origin", input.origin);
  if (input.fetchSite) headers.set("Sec-Fetch-Site", input.fetchSite);
  if (input.body !== undefined) headers.set("Content-Type", input.contentType ?? "application/json");
  if (input.emailHeader) headers.set("Cf-Access-Authenticated-User-Email", input.emailHeader);
  return handleRequest(new Request(url, {
    method: input.method ?? "POST",
    headers,
    body: input.body
  }), fixture.env, fixture.ctx, fixture.deps);
}

describe("console browser writes", () => {
  it("rejects untrusted origins and still allows the same-origin console and the operator API", async () => {
    const fixture = makeFixture();
    const dashboard = "https://admin.example.test";
    const users = `${dashboard}/admin/ui/users`;
    const form = "email=browser@example.com";

    const missing = await consoleWrite(fixture, users, {
      body: form,
      contentType: "application/x-www-form-urlencoded"
    });
    expect(missing.status).toBe(403);
    expect(fixture.db.users.has("Browser")).toBe(false);

    const foreign = await consoleWrite(fixture, users, {
      body: form,
      contentType: "application/x-www-form-urlencoded",
      origin: "https://untrusted.example.test"
    });
    expect(foreign.status).toBe(403);

    const crossSite = await consoleWrite(fixture, users, {
      body: form,
      contentType: "application/x-www-form-urlencoded",
      origin: dashboard,
      fetchSite: "cross-site"
    });
    expect(crossSite.status).toBe(403);
    expect(fixture.db.users.size).toBe(0);
    expect(fixture.db.operatorMutationAudit).toHaveLength(0);

    seedDashboardAdmin(fixture);
    const created = await consoleWrite(fixture, users, {
      body: form,
      contentType: "application/x-www-form-urlencoded",
      origin: dashboard
    });
    expect(created.status).toBe(200);
    const person = [...fixture.db.users.values()].find(user => user.email === "browser@example.com")!;
    expect(person.id).toMatch(/^usr_/);

    fixture.db.ensureCredentialAccountsForScopes(["surface:codex:production"]);
    const jsonKey = await admin(fixture, `${dashboard}/admin/ui/keys`, {
      method: "POST",
      body: {
        user_id: String(person.id),
        name: "Browser key",
        scopes: ["surface:codex:production"],
        codex_credential_account_id: SHARED_CODEX_AUTH_ID
      }
    });
    expect(jsonKey.status).toBe(201);
    expect(fixture.db.apiKeys.size).toBe(1);

    const operator = await handleRequest(new Request("https://api.trustedtunnel.app/admin/users", {
      method: "POST",
      headers: {
        Authorization: "Bearer admin-secret",
        "Content-Type": "application/json",
        Origin: "https://untrusted.example.test"
      },
      body: JSON.stringify({ id: "Operator", email: "operator@example.test" })
    }), fixture.env, fixture.ctx, fixture.deps);
    expect(operator.status).toBe(201);
    expect(fixture.db.users.has("Operator")).toBe(true);

    const alternate = await consoleWrite(fixture, "https://other.example.test/admin/ui/users", {
      body: "id=Alternate",
      contentType: "application/x-www-form-urlencoded",
      origin: dashboard
    });
    expect(alternate.status).toBe(404);
    expect(fixture.db.users.has("Alternate")).toBe(false);

    const unsigned = await consoleWrite(fixture, users, {
      body: "id=Unsigned",
      contentType: "application/x-www-form-urlencoded",
      origin: dashboard,
      token: null,
      emailHeader: "operator@example.com"
    });
    expect(unsigned.status).toBe(403);
    expect(fixture.db.users.has("Unsigned")).toBe(false);

    const page = await admin(fixture, `${dashboard}/admin`, { method: "GET" });
    expect(page.status).toBe(200);
    expect(page.headers.get("Cache-Control")).toBe("no-store");
  });
});
