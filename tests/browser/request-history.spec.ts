import { test, expect } from "./fixtures";

for (const script of [true, false]) test.describe(`request date correction ${script ? "enhanced" : "native"}`, () => {
  test.use({script, viewport:{width:390,height:900}});
  test("keeps filters and lets the user correct a reversed date range", async ({page, worker}) => {
    worker.seedRequestHistory();
    await page.goto("/admin?view=audit");
    if (script) await expect(page.getByRole('button',{name:'账号菜单',exact:true})).toHaveAttribute('aria-haspopup','menu');
    await page.getByRole('button',{name:'精确定位',exact:true}).click();
    await page.getByRole('textbox',{name:'成员',exact:true}).fill('member');
    await page.getByRole('textbox',{name:'请求 ID',exact:true}).fill('request-shared');
    await page.getByRole('button',{name:'精确定位',exact:true}).click();
    await expect(page.getByRole('textbox',{name:'成员',exact:true})).toBeHidden();
    await page.getByRole('button',{name:'精确定位',exact:true}).click();
    await expect(page.getByRole('textbox',{name:'成员',exact:true})).toHaveValue('member');
    await expect(page.getByRole('textbox',{name:'请求 ID',exact:true})).toHaveValue('request-shared');
    await page.getByRole('combobox',{name:'结果',exact:true}).selectOption('error');
    await page.getByLabel('开始日期（UTC）').fill('2026-06-25');
    await page.getByLabel('结束日期（UTC）').fill('2026-06-24');
    await page.getByRole('button',{name:'筛选请求',exact:true}).click();
    const form = page.getByRole('form',{name:'筛选请求记录'});
    await expect(form.getByRole('alert')).toHaveText('结束日期不能早于开始日期。');
    await expect(form.getByRole('textbox',{name:'成员',exact:true})).toHaveValue('member');
    await expect(form.getByRole('textbox',{name:'请求 ID',exact:true})).toHaveValue('request-shared');
    await expect(form.getByRole('combobox',{name:'结果',exact:true})).toHaveValue('error');
    await expect(form.getByLabel('开始日期（UTC）')).toHaveValue('2026-06-25');
    await expect(form.getByLabel('结束日期（UTC）')).toHaveValue('2026-06-24');
    await form.getByLabel('开始日期（UTC）').fill('2026-06-24');
    await form.getByRole('button',{name:'筛选请求',exact:true}).click();
    await expect(page.locator('[data-request-record]')).toHaveCount(1);
    await expect(page.locator('[data-request-record="history-27"]')).toBeVisible();
    await expect(page.getByRole('form',{name:'筛选请求记录'}).getByRole('alert')).toHaveCount(0);
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  });
});

for (const width of [320, 390, 768, 1105, 1440, 1920]) test.describe(`request history ${width}px`, () => {
  test.use({ viewport: { width, height: 900 } });
  test("filters, keyboard detail, Back/Forward and return preserve context", async ({ page, worker }, testInfo) => {
    worker.seedRequestHistory();
    await page.goto("/admin?view=audit");
    const inspectBounds = await page.getByRole('link',{name:'查看请求 history-27',exact:true}).evaluate(link => {
      const box = link.getBoundingClientRect();
      return {left:box.left,right:box.right,viewport:innerWidth};
    });
    expect(inspectBounds.left).toBeGreaterThanOrEqual(0);
    expect(inspectBounds.right).toBeLessThanOrEqual(inspectBounds.viewport);
    const scope = page.locator('.request-filter-actions').getByRole('button', { name: '记录范围', exact: true });
    await expect(scope).toBeVisible();
    const scopeBounds = await scope.evaluate(button => ({left:button.getBoundingClientRect().left,right:button.getBoundingClientRect().right,width:button.getBoundingClientRect().width,height:button.getBoundingClientRect().height,viewport:innerWidth}));
    expect(scopeBounds.left).toBeGreaterThanOrEqual(0);
    expect(scopeBounds.right).toBeLessThanOrEqual(scopeBounds.viewport);
    expect(scopeBounds.width).toBeGreaterThanOrEqual(44);
    expect(scopeBounds.height).toBeGreaterThanOrEqual(44);
    await scope.click();
    await expect(page.locator('#request-history-scope')).toContainText('不代表当前服务健康');
    await page.keyboard.press('Escape');
    if (width < 720) {
      await expect(page.getByRole("button", { name: "精确定位", exact: true })).toBeVisible();
      const bounds = await page.locator("[data-request-record]").first().evaluate(row => ({bottom:row.getBoundingClientRect().bottom,viewport:innerHeight}));
      expect(bounds.bottom).toBeLessThanOrEqual(bounds.viewport);
      const table = page.getByRole("region", {name: "保留的请求记录", exact: true});
      expect(await table.evaluate(element => element.scrollWidth > element.clientWidth)).toBe(true);
      await table.focus();
      await page.keyboard.press("ArrowRight", {delay: 80});
      await expect.poll(() => table.evaluate(element => element.scrollLeft)).toBeGreaterThan(0);
    }
    await expect(page.locator("[data-request-record]").first().locator("td")).toHaveCount(8);
    expect(await page.locator("[data-request-record]").first().evaluate(row => getComputedStyle(row).display)).toBe("table-row");
    await page.getByRole("button", { name: "精确定位", exact: true }).click();
    await page.getByRole("combobox", { name: "服务与路由", exact: true }).selectOption('codex.responses');
    await page.getByRole("textbox", { name: "成员", exact: true }).fill('member');
    await page.getByRole("textbox", { name: "请求 ID" }).fill("request-shared");
    await page.getByRole("combobox", { name: "结果", exact: true }).selectOption("error");
    await page.getByRole("button", { name: "筛选请求" }).click();
    await expect(page.locator("[data-request-record]")).toHaveCount(1);
    // SSR search is already usable before enhancement. Wait for a real runtime
    // outcome before testing the separate in-document task/focus contract.
    await expect(page.getByRole('button', {name:'账号菜单',exact:true})).toHaveAttribute('aria-haspopup','menu');
    await page.evaluate(() => { document.documentElement.dataset.taskDocument = "filtered-requests"; });
    const filteredUrl = page.url();
    const record = page.getByRole("link", { name: /查看请求.*history-27/ });
    const recordHref = await record.getAttribute("href");
    await record.focus();
    const taskRead = page.waitForRequest(request => request.method() === 'GET'
      && new URL(request.url()).pathname === '/admin' && new URL(request.url()).searchParams.get('record') === 'history-27');
    await page.keyboard.press("Enter");
    expect((await taskRead).isNavigationRequest()).toBe(false);
    await expect(page.locator('[data-request-detail="history-27"]')).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('data-task-document','filtered-requests');
    await expect(page.getByRole('combobox',{name:'结果',exact:true})).toHaveValue('error');
    await expect(page.locator('[data-request-record="history-27"]')).toBeVisible();
    await expect(page.locator('[data-request-detail] > .usage-facts').getByText("上游 HTTP 状态", {exact: true}).locator("..").locator("dd")).toHaveText("未记录");
    await expect(page.locator("main")).not.toContainText("0 ms");
    await page.goBack();
    await expect(page).toHaveURL(filteredUrl);
    await expect(page.locator('html')).toHaveAttribute('data-task-document','filtered-requests');
    await expect(page.getByRole("textbox", { name: "请求 ID" })).toHaveValue("request-shared");
    await expect(page.getByRole("textbox", { name: "成员", exact: true })).toHaveValue("member");
    await expect(page.getByRole("combobox", { name: "服务与路由", exact: true })).toHaveValue("codex.responses");
    await expect(page.getByRole("link", { name: /查看请求.*history-27/ })).toHaveAttribute("href", recordHref!);
    await expect(page.getByRole("link", { name: /查看请求.*history-27/ })).toBeFocused();
    await page.goForward();
    await expect(page.locator('[data-request-detail="history-27"]')).toBeVisible();
    await page.getByRole("button", { name:"记录字段与当前标签", exact: true }).focus(); await page.keyboard.press("Space");
    await expect(page.getByText("当前密钥名称", { exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await expect.poll(() => page.locator("[data-one-time-key],[data-created-token]").count()).toBe(0);
    await expect(page.locator("main")).not.toContainText(/not-a-key-hash|synthetic-provider-token|browser-fixture-/);
    await page.evaluate(() => document.fonts.ready);
    // Only fixed, invalid-placeholder metadata, with no provider call or real secret.
    await page.evaluate(() => scrollTo(0, 0));
    const path = testInfo.outputPath(`safe-request-history-${width}.png`);
    await page.screenshot({ path, animations: "disabled", fullPage: true });
    await testInfo.attach("safe request history detail", { path, contentType: "image/png" });
    await page.keyboard.press("Escape");
    await page.getByRole("link", { name: "收起请求详情" }).click();
    await expect(page.getByRole("combobox", { name: "结果", exact: true })).toHaveValue("error");
    await expect(page.locator("[data-request-record]")).toHaveCount(1);
  });
});

test("stable pagination, unavailable reads and retry stay distinct from missing", async ({ page, worker }) => {
  worker.seedRequestHistory();
  await page.goto("/admin?view=audit");
  await expect(page.locator("[data-request-record]")).toHaveCount(25);
  await page.getByRole("link", { name: "较旧记录" }).click();
  await expect(page.locator("[data-request-record]")).toHaveCount(3);
  await page.getByRole("link", { name: "较新记录" }).click();
  await expect(page.locator("[data-request-record]")).toHaveCount(25);
  await expect(page.getByRole('button', {name:'账号菜单',exact:true})).toHaveAttribute('aria-haspopup','menu');
  worker.failRequestHistoryRead();
  await page.getByRole("link", { name: /查看请求.*history-27/ }).click();
  await expect(page.locator("[data-dashboard-notice]")).toContainText("页面暂时打不开");
  await expect(page.locator("[data-request-record]")).toHaveCount(25);
  await expect(page.locator("[data-request-missing]")).toHaveCount(0);
  worker.restoreRequestHistoryRead();
  await page.locator("[data-dashboard-notice]").getByRole("link", { name: "重试" }).click();
  await expect(page.locator('[data-request-detail="history-27"]')).toBeVisible();
  await page.goto("/admin?view=audit&record=not-retained");
  await expect(page.locator("[data-request-missing]")).toContainText("不代表没有发生请求");
});

test.describe("request history without JavaScript", () => {
  test.use({ script: false });
  test("native filter, exact detail and return work without a client runtime", async ({ page, worker }) => {
    worker.seedRequestHistory();
    await page.goto("/admin?view=audit");
    const exactMember = page.getByRole("textbox", {name:"成员",exact:true});
    await expect(exactMember).toBeHidden();
    await page.getByRole("button", {name:"精确定位",exact:true}).click();
    await exactMember.fill("member");
    await page.getByRole("combobox", { name: "结果", exact: true }).selectOption("error");
    await page.getByRole("button", { name: "筛选请求" }).click();
    await expect(page.locator("[data-request-record]")).toHaveCount(1);
    await page.getByRole("link", { name: /查看请求.*history-27/ }).click();
    await expect(page.locator('[data-request-detail="history-27"]')).toBeVisible();
    await page.keyboard.press("Escape");
    await page.getByRole("link", { name: "收起请求详情" }).click();
    await expect(page.getByRole("combobox", { name: "结果", exact: true })).toHaveValue("error");
  });
});
