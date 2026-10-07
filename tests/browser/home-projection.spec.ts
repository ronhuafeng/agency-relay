import { test, expect, expectAccountRole } from "./fixtures";

for (const width of [320, 390, 1440]) test.describe(`organization Home ${width}px`, () => {
  test.use({identity: "admin", viewport: {width, height: 900}, colorScheme: width === 390 ? "dark" : "light"});
  test("shares report trends, preserves actor context and fits the available width", async ({page, worker}, testInfo) => {
    worker.seedUsageTrends();
    await page.goto("/admin?view=overview&range=7d");
    const trends = page.getByRole("region", {name: "按日用量趋势"});
    await expect(trends).toBeVisible();
    const grok = page.locator('[data-trend-plan="grok.production.responses"]');
    const description = trends.locator("details.usage-chart-description");
    await expect(description).toHaveJSProperty("open", false);
    await expect(trends.locator(".usage-bar-plot")).toHaveCount(1);
    expect(await grok.locator(".usage-metrics").textContent()).toContain("0 · 已记录 1/4 次请求");
    const initialMetrics = await trends.locator(".usage-metrics").allTextContents();
    const rail = await page.locator(".nav-rail").elementHandle();
    const account = await page.getByRole("button", {name: "账号菜单", exact: true}).elementHandle();
    await expect(page.locator("[data-console-actor-id]")).toHaveAttribute("data-console-actor-id", "admin");

    await trends.getByRole("link", {name: "30 天", exact: true}).click();
    await expect(page.locator("[data-usage-range-label]")).toHaveAttribute("data-usage-range-label", "2026-05-26 至 2026-06-24 UTC");
    await expect(trends.getByRole("link", {name: "30 天", exact: true})).toHaveAttribute("aria-current", "true");
    await expect(page).toHaveURL(/view=overview&range=30d/);
    expect(await rail!.evaluate(node => node === document.querySelector(".nav-rail"))).toBe(true);
    expect(await account!.evaluate(node => node === document.querySelector('button[aria-label="账号菜单"]'))).toBe(true);
    await expect(page.locator("[data-console-actor-id]")).toHaveAttribute("data-console-actor-id", "admin");
    await expectAccountRole(page, "管理员");
    const homeMetrics = await trends.locator(".usage-metrics").allTextContents();
    expect(homeMetrics).not.toEqual(initialMetrics);
    const homeBars = await trends.locator(".usage-chart-bar").evaluateAll(nodes => nodes.map(node => ({x: node.getAttribute("x"), y: node.getAttribute("y"), height: node.getAttribute("height")})));

    await description.locator("summary").focus();
    await page.keyboard.press("Enter");
    await expect(description).toHaveJSProperty("open", true);
    const grokDays = description.locator('[data-text-plan="grok.production.responses"] dl>div');
    await expect(grokDays).toHaveCount(30);
    await expect(grokDays.first()).toContainText("2026-05-26 UTC");
    await expect(grokDays.last()).toContainText("2026-06-24 UTC · 未结束");
    await expect(grokDays.last()).toContainText("已记录 1/4 次请求");
    await expect(description.locator("table")).toHaveCount(0);
    await description.locator("summary").click();

    const geometry = await page.evaluate(() => {
      const boxes = Array.from(document.querySelectorAll<HTMLElement>("#usage-trends .usage-comparison"));
      const overlaps = (first: DOMRect, second: DOMRect) => Math.min(first.right, second.right) - Math.max(first.left, second.left) > 1 && Math.min(first.bottom, second.bottom) - Math.max(first.top, second.top) > 1;
      let overlapping = 0;
      for (const comparison of boxes) {
        const title = comparison.querySelector<HTMLElement>("h3")!;
        const ranges = comparison.querySelector<HTMLElement>(".ranges");
        if (ranges && overlaps(title.getBoundingClientRect(), ranges.getBoundingClientRect())) overlapping++;
        const fields = Array.from(comparison.querySelectorAll<HTMLElement>(".usage-chart-controls>label"));
        for (let first = 0; first < fields.length; first++) for (let second = first + 1; second < fields.length; second++) if (overlaps(fields[first].getBoundingClientRect(), fields[second].getBoundingClientRect())) overlapping++;
        const plot = comparison.querySelector<HTMLElement>(".usage-chart-frame")!.getBoundingClientRect();
        if (fields.some(field => overlaps(field.getBoundingClientRect(), plot))) overlapping++;
      }
      const controls = Array.from(document.querySelectorAll<HTMLElement>('#usage-trends .ranges a,#usage-trends .usage-chart-controls select,#usage-trends .usage-chart-legend button,#usage-trends .usage-chart-description>summary,[data-home-summary] a,.home-overview-grid .action-link')).filter(control => control.checkVisibility());
      return {
        overflowing: document.documentElement.scrollWidth > innerWidth + 1,
        overlapping,
        clippedComparisons: boxes.filter(comparison => {const box = comparison.getBoundingClientRect(); return box.left < -1 || box.right > innerWidth + 1;}).length,
        smallOrClippedControls: controls.filter(control => {const box = control.getBoundingClientRect(); return box.width < 44 || box.height < 44 || box.left < -1 || box.right > innerWidth + 1;}).length
      };
    });
    expect(geometry).toEqual({overflowing: false, overlapping: 0, clippedComparisons: 0, smallOrClippedControls: 0});
    expect(await page.locator("[data-one-time-key],[data-created-token]").count()).toBe(0);
    await page.evaluate(() => document.fonts.ready);
    await page.evaluate(() => scrollTo(0, 0));
    // Only this synthetic Home ledger and connection metadata can emit pixels.
    const image = testInfo.outputPath(`safe-home-projection-${width}.png`);
    await page.screenshot({path: image, fullPage: true, animations: "disabled"});
    await testInfo.attach(`safe organization Home ${width}px`, {path: image, contentType: "image/png"});

    if (width < 1000) await page.locator(".nav-toggle-label").click();
    await page.getByRole("navigation", {name: "控制台页面"}).getByRole("link", {name: "用量报告", exact: true}).click();
    await expect(page.locator('main[data-dashboard-view="usage"]')).toBeVisible();
    await expect(page.locator("[data-usage-range-label]")).toHaveAttribute("data-usage-range-label", "2026-05-26 至 2026-06-24 UTC");
    expect(await page.locator("#usage-trends .usage-metrics").allTextContents()).toEqual(homeMetrics);
    expect(await page.locator("#usage-trends .usage-chart-bar").evaluateAll(nodes => nodes.map(node => ({x: node.getAttribute("x"), y: node.getAttribute("y"), height: node.getAttribute("height")})))).toEqual(homeBars);
    expect(await rail!.evaluate(node => node === document.querySelector(".nav-rail"))).toBe(true);
    expect(await account!.evaluate(node => node.isConnected)).toBe(true);
    expect(worker.requests.every(request => request.method === "GET")).toBe(true);
  });
});

test.describe("organization Home partial read recovery", () => {
  test.use({identity: "admin", viewport: {width: 390, height: 900}, colorScheme: "dark"});
  test("keeps known resources and account recovery when usage is unknown, then retries the selected range", async ({page, worker}) => {
    worker.seedUsageTrends();
    worker.setBoundCredentialStatus("reauth_required");
    await page.goto("/admin?view=overview&range=7d");
    await expect(page.locator('[data-attention="account"]')).toBeVisible();
    const resources = await page.locator("[data-home-summary] strong").allTextContents();
    const attention = await page.locator('[data-attention="account"] a').getAttribute("href");
    const rail = await page.locator(".nav-rail").elementHandle();
    const account = await page.getByRole("button", {name: "账号菜单", exact: true}).elementHandle();
    worker.failMemberRead("usage");
    await page.getByRole("navigation", {name: "UTC 时间范围"}).getByRole("link", {name: "30 天", exact: true}).click();
    const unknown = page.locator('[data-home-usage="unavailable"]');
    await expect(unknown).toBeVisible();
    await expect(unknown).toContainText("统计未知");
    await expect(unknown).toHaveAttribute("role", "alert");
    expect(await page.locator("[data-home-summary] strong").allTextContents()).toEqual(resources);
    const newAttention = await page.locator('[data-attention="account"] a').getAttribute("href");
    expect(new URL(newAttention!, worker.origin).searchParams.get("account")).toBe(new URL(attention!, worker.origin).searchParams.get("account"));
    expect(await page.locator("[data-trend-empty],[data-trend-plan]").count()).toBe(0);
    expect(await rail!.evaluate(node => node === document.querySelector(".nav-rail"))).toBe(true);
    expect(await account!.evaluate(node => node.isConnected)).toBe(true);
    await expect(page.locator("[data-console-actor-id]")).toHaveAttribute("data-console-actor-id", "admin");
    worker.failMemberRead(null);
    await unknown.getByRole("link", {name: "重试", exact: true}).click();
    await expect(page.locator("[data-usage-range-label]")).toHaveAttribute("data-usage-range-label", "2026-05-26 至 2026-06-24 UTC");
    await expect(page.locator('[data-home-usage="unavailable"]')).toHaveCount(0);
    expect(worker.requests.every(request => request.method === "GET")).toBe(true);
  });
});


test.describe('member connection recovery',()=>{
  test.use({identity:'member',viewport:{width:390,height:900},colorScheme:'dark'});
  test('distinguishes first-key prerequisites from existing bindings and read uncertainty',async({page,worker},testInfo)=>{
    const service=await worker.seedDelegatedService();
    worker.setBoundCredentialStatus('reauth_required');
    await page.goto(`/me/service-accounts/${service}?view=home`);
    const row=page.locator('[data-member-home] [data-surface=codex]');
    await expect(row).toHaveAttribute('data-service-reason','default-unavailable');
    await expect(row).toContainText('请联系管理员处理');
    await expect(row.getByRole('link',{name:'创建密钥',exact:true})).toHaveCount(0);
    await page.screenshot({path:testInfo.outputPath('safe-member-connection-recovery.png'),fullPage:true,animations:'disabled'});
    await page.goto('/admin?area=me&view=home');
    const own=page.locator('[data-member-home] [data-surface=codex]');
    await expect(own).toHaveAttribute('data-service-reason','binding-unavailable');
    await expect(own.locator('a[href="/admin?area=me&view=keys&key=member-key"]')).toBeVisible();
    worker.setBoundCredentialStatus('active');
    worker.failMemberRead('defaults');
    await page.goto(`/me/service-accounts/${service}?view=home`);
    await expect(row).toHaveAttribute('data-service-reason','default-unknown');
    const retry=row.getByRole('link',{name:'重新读取',exact:true});
    await expect(retry).toBeVisible();
    worker.failMemberRead(null);
    await retry.click();
    await expect(row).toHaveAttribute('data-service-reason','no-key');
    await row.getByRole('link',{name:'创建密钥',exact:true}).click();
    await expect(page).toHaveURL(new RegExp(`/me/service-accounts/${service}\\?view=keys#member-key-form`));
    expect(worker.requests.every(r=>r.method==='GET')).toBe(true);
  });
});
