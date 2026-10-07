import type { WebSocketRoute } from "@playwright/test";
import { authenticate, test, expect } from "./fixtures";

test("a credential notification updates the open exact detail while retaining its task and search draft", async ({ page, worker }) => {
  worker.seedAdminLayouts();
  let channel: WebSocketRoute | undefined;
  await page.routeWebSocket("**/admin/events/credentials", socket => { channel = socket; socket.send(JSON.stringify({type: "connected"})); });
  await page.goto("/admin?view=credentials&account=codex%3Afixture-codex&range=30d&q=Synthetic");
  const detail = page.locator('[data-account-detail="codex:fixture-codex"] [data-credential-key="codex:fixture-codex"]');
  await expect(detail.locator("[data-credential-status]")).toHaveText("已连接");
  await expect.poll(() => worker.requests.filter(request => request.path === "/admin/credential-status").length).toBeGreaterThan(0);
  await expect.poll(() => Boolean(channel)).toBe(true);
  const draft = page.locator('input[name="q"]'); await draft.fill("unfinished search"); await draft.focus();
  await page.evaluate(() => {
    (window as unknown as {credentialTask: unknown}).credentialTask = {
      main: document.querySelector("main#content"), detail: document.querySelector('[data-account-detail="codex:fixture-codex"]'),
      field: document.querySelector('input[name="q"]')
    };
  });
  const priorPageReads = worker.requests.filter(request => request.method === "GET" && request.path === "/admin").length;
  worker.setBoundCredentialStatus("reauth_required"); channel!.send(JSON.stringify({type: "credentials-changed"}));
  await expect(detail.locator("[data-credential-status]")).toHaveText("需要重新连接");
  await expect(page.locator('[data-account-key="codex:fixture-codex"] [data-credential-status]')).toHaveText("需要重新连接");
  await expect(detail.locator("[data-credential-hint]")).toContainText("请重新登录");
  await expect(detail.getByRole("button", {name: "刷新账号", exact: true})).toBeDisabled();
  await expect(detail.getByRole("button", {name: "重新连接", exact: true})).toBeVisible();
  const current = detail.locator("[data-credential-read-current]"); await expect(current).toBeVisible();
  const readUrl = new URL((await current.getAttribute("href"))!, worker.origin);
  expect(readUrl.searchParams.get("account")).toBe("codex:fixture-codex"); expect(readUrl.searchParams.get("q")).toBe("Synthetic"); expect(readUrl.searchParams.get("range")).toBe("30d");
  await expect(draft).toHaveValue("unfinished search"); await expect(draft).toBeFocused();
  expect(await page.evaluate(() => {
    const task = (window as unknown as {credentialTask: {main: Element; detail: Element; field: Element}}).credentialTask;
    return task.main === document.querySelector("main#content") && task.detail === document.querySelector('[data-account-detail="codex:fixture-codex"]') && task.field === document.querySelector('input[name="q"]');
  })).toBe(true);
  expect(worker.requests.filter(request => request.method === "GET" && request.path === "/admin")).toHaveLength(priorPageReads);
  expect(worker.requests.filter(request => request.method !== "GET")).toHaveLength(0);
  expect(worker.requests.filter(request => request.path === "/admin/credential-status").every(request => request.cookiePresent && !request.authorizationPresent)).toBe(true);
});

test("refreshed expiry and refresh time stay consistent with a changed connection state", async ({ page, worker }) => {
  let channel: WebSocketRoute | undefined;
  await page.routeWebSocket("**/admin/events/credentials", socket => { channel = socket; socket.send(JSON.stringify({type: "connected"})); });
  worker.setBoundCredentialTimes("2026-06-23T12:00:00Z", "2026-06-22T12:00:00Z");
  await page.goto("/admin?view=credentials&account=codex%3Afixture-codex");
  const detail = page.locator('[data-account-detail="codex:fixture-codex"] [data-credential-key="codex:fixture-codex"]');
  await expect(detail.locator("[data-credential-status]")).toHaveText("访问已过期");
  await expect(detail.locator("[data-credential-expiry] dt")).toHaveText("已过期");
  await expect.poll(() => Boolean(channel)).toBe(true);
  const reads = worker.requests.filter(request => request.path === "/admin").length;
  worker.setBoundCredentialTimes("2026-07-24T12:00:00Z", "2026-06-24T12:00:00Z");
  channel!.send(JSON.stringify({type: "credentials-changed"}));
  await expect(detail.locator("[data-credential-status]")).toHaveText("已连接");
  await expect(detail.locator("[data-credential-expiry] dt")).toHaveText("到期时间");
  await expect(detail.locator("[data-credential-expiry] dd")).toHaveText("2026-07-24 12:00 UTC");
  await expect(detail.locator("[data-credential-last-refresh] dd")).toHaveText("2026-06-24 12:00 UTC");
  expect(worker.requests.filter(request => request.path === "/admin")).toHaveLength(reads);
  expect(worker.requests.filter(request => request.method !== "GET")).toHaveLength(0);
});

test("Home keeps connection status and recovery actions consistent as an account fails and recovers", async ({ page, worker }) => {
  let channel: WebSocketRoute | undefined;
  await page.routeWebSocket("**/admin/events/credentials", socket => { channel = socket; socket.send(JSON.stringify({type: "connected"})); });
  await page.goto("/admin?view=overview");
  const account = page.locator('[data-home-account="chatgpt"][data-credential-key="codex:fixture-codex"]');
  await expect(account.locator("[data-credential-status]")).toHaveText("已连接");
  await expect.poll(() => Boolean(channel)).toBe(true);
  const priorPageReads = worker.requests.filter(request => request.method === "GET" && request.path === "/admin").length;
  await expect(page.locator('[data-panel="attention"]')).toBeHidden();
  const attention = page.locator('[data-attention="account"][data-attention-account="codex:fixture-codex"]');
  worker.setBoundCredentialStatus("reauth_required"); channel!.send(JSON.stringify({type: "credentials-changed"}));
  await expect(account.locator("[data-credential-status]")).toHaveText("需要重新连接");
  await expect(attention).toBeVisible();
  await expect(attention).toContainText("需要重新连接");
  await expect(page.locator("[data-attention-count]")).toHaveText("1 项");
  await attention.getByRole("link").focus();
  worker.setBoundCredentialStatus("active"); channel!.send(JSON.stringify({type: "credentials-changed"}));
  await expect(account.locator("[data-credential-status]")).toHaveText("已连接");
  await expect(attention).toBeHidden();
  await expect(account.getByRole("link")).toBeFocused();
  await expect(page.locator('[data-panel="attention"]')).toBeHidden();
  expect(worker.requests.filter(request => request.method === "GET" && request.path === "/admin")).toHaveLength(priorPageReads);
  expect(worker.requests.filter(request => request.method !== "GET")).toHaveLength(0);
});

test("a restored connection offers a current exact GET for newly available controls", async ({ page, worker }) => {
  worker.setBoundCredentialStatus("reauth_required");
  let channel: WebSocketRoute | undefined;
  await page.routeWebSocket("**/admin/events/credentials", socket => { channel = socket; socket.send(JSON.stringify({type: "connected"})); });
  await page.goto("/admin?view=credentials&account=codex%3Afixture-codex&range=30d&q=Synthetic");
  const detail = page.locator('[data-account-detail="codex:fixture-codex"] [data-credential-key="codex:fixture-codex"]');
  await expect(detail.locator("[data-credential-status]")).toHaveText("需要重新连接");
  await expect(detail.locator("[data-credential-refresh]")).toHaveCount(0);
  await expect.poll(() => Boolean(channel)).toBe(true);
  const draft = page.locator('input[name="q"]'); await draft.fill("unfinished search");
  worker.setBoundCredentialStatus("active"); channel!.send(JSON.stringify({type: "credentials-changed"}));
  await expect(detail.locator("[data-credential-status]")).toHaveText("已连接");
  await expect(detail.locator("[data-credential-refresh]")).toHaveCount(0); await expect(draft).toHaveValue("unfinished search");
  await expect(detail.locator("[data-credential-read-current]")).toBeVisible();
  await detail.locator("[data-credential-read-current]").click();
  await expect(page.locator("[data-credential-refresh] button")).toBeEnabled();
  const current = new URL(page.url()); expect(current.searchParams.get("account")).toBe("codex:fixture-codex"); expect(current.searchParams.get("range")).toBe("30d"); expect(current.searchParams.get("q")).toBe("Synthetic");
  expect(worker.requests.filter(request => request.method !== "GET")).toHaveLength(0);
});

for (const authority of ["demoted", "different actor"] as const) test(`metadata recovery clears the former administrator when ${authority}`, async ({ page, context, worker }) => {
  let channel: WebSocketRoute | undefined;
  await page.routeWebSocket("**/admin/events/credentials", socket => { channel = socket; socket.send(JSON.stringify({type: "connected"})); });
  await page.goto("/admin?view=credentials&account=codex%3Afixture-codex");
  await expect(page.locator("[data-credential-refresh] button")).toBeVisible();
  await expect.poll(() => worker.requests.filter(request => request.path === "/admin/credential-status").length).toBeGreaterThan(0);
  await expect.poll(() => Boolean(channel)).toBe(true);
  if (authority === "demoted") worker.setRole("admin", "user"); else await authenticate(context, worker, "backup");
  channel!.send(JSON.stringify({type: "credentials-changed"}));
  await expect(page.locator("[data-console-recovery]")).toBeVisible();
  expect(await page.locator(".shell,.identity,input,[data-credential-key]").count()).toBe(0);
  expect(worker.requests.filter(request => request.method !== "GET")).toHaveLength(0);
});

test("websocket authorization loss uses the same fresh-read recovery", async ({ page, worker }) => {
  let channel: WebSocketRoute | undefined;
  await page.routeWebSocket("**/admin/events/credentials", socket => { channel = socket; socket.send(JSON.stringify({type: "connected"})); });
  await page.goto("/admin?view=credentials&account=codex%3Afixture-codex");
  await expect(page.locator("[data-credential-refresh] button")).toBeVisible();
  await expect.poll(() => Boolean(channel)).toBe(true);
  channel!.close({code: 4403});
  await expect(page.locator("[data-console-recovery]")).toBeVisible();
  expect(await page.locator(".shell,.identity,input,[data-credential-key]").count()).toBe(0);
  expect(worker.requests.filter(request => request.method !== "GET")).toHaveLength(0);
});
