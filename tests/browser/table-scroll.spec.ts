import { test, expect } from "./fixtures";

for (const script of [true, false]) test.describe(`table keyboard access, script ${script}`, () => {
  test.use({script, viewport: {width: 768, height: 900}});
  for (const view of ["audit", "surfaces"] as const) test(`${view} exposes reachable rows and uses scrolling only for wide content`, async ({page, worker}) => {
    if (view === "audit") worker.seedRequestHistory();
    await page.goto(`/admin?view=${view}`);
    const region = page.getByRole("region", {name: view === "audit" ? "保留的请求记录" : /上的路由$/, exact: true}).first();
    await expect(region).toHaveAttribute("data-slot", "table-container");
    const geometry = await region.evaluate(element => ({
      clientWidth: element.clientWidth, scrollWidth: element.scrollWidth,
      parentWidth: element.parentElement?.clientWidth,
      overflowX: getComputedStyle(element).overflowX
    }));
    if(view === "audit") {
      expect(geometry.overflowX).toBe("visible");
      expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.clientWidth+1);
      const request=region.getByRole('link',{name:/^查看请求/}).first();
      await request.focus();await expect(request).toBeFocused();
      await page.keyboard.press('Enter');
      await expect(page.getByRole('article')).toBeVisible();
      await expect(region).toBeVisible();
      expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
      return;
    }
    expect(geometry.overflowX).toBe("auto");
    expect(geometry.scrollWidth, JSON.stringify(geometry)).toBeGreaterThan(geometry.clientWidth);
    await region.focus();
    await expect(region).toBeFocused();
    // Hold one native key through a render frame; WebKit starts keyboard scrolling asynchronously.
    await page.keyboard.press("ArrowRight", {delay: 80});
    await expect.poll(() => region.evaluate(element => element.scrollLeft)).toBeGreaterThan(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  });
});
