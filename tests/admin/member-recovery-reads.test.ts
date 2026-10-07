import { JSDOM } from "jsdom";
import { describe, expect, it, onTestFinished } from "vitest";
import { handleRequest } from "../../src/router";
import { commitServiceAccount } from "../../src/auth/service-accounts";
import { commitServiceOwner } from "../../src/auth/service-delegation";
import { consoleCookie, createUser, makeFixture } from "../router/fixture";
import { createTestD1 } from "../support/sqlite-d1";

describe("member unavailable exact GET", () => {
  it.each([false,true])("retains a 30-day usage read on failure (delegated=%s)", async delegated => {
    let failUsage = false;
    const db = createTestD1({onPrepare:sql => {if (failUsage && sql.includes("usage_daily")) throw new Error("Synthetic usage read unavailable");}});
    onTestFinished(() => db.close()); const fixture = makeFixture({env:{DB:db.binding}});
    const owner = await createUser(fixture,"recover@example.com");
    const actor = {kind:"admin_secret" as const,userId:null,email:null,role:null,subject:null,requestId:"setup"};
    const service = delegated ? await commitServiceAccount(fixture.env,actor,"Recovery service",fixture.deps.now()) : null;
    if (service) await commitServiceOwner(fixture.env,actor,service.id,{owner_user_id:owner.user.id,expected_revision:0},fixture.deps.now());
    const cookie = await consoleCookie(fixture,"recover@example.com");
    const path = service ? `/me/service-accounts/${service.id}?view=usage&range=30d` : "/admin?area=me&view=usage&range=30d";
    failUsage = true;
    const response = await handleRequest(new Request(`https://admin.example.test${path}`,{headers:{Cookie:`__Host-mini-console=${cookie}`,Accept:"text/html"}}),fixture.env,fixture.ctx,fixture.deps);
    expect(response.status).toBe(503);
    const doc = new JSDOM(await response.text()).window.document;
    expect(doc.querySelector('[data-read-state="unavailable"] a')?.getAttribute("href")).toBe(path);
    expect(doc.querySelector('[data-trend-empty],[data-trend-plan]')).toBeNull();
  });
});
