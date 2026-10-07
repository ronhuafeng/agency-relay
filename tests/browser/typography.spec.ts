import { readFileSync } from "node:fs";
import type { Locator } from "@playwright/test";
import { test, expect } from "./fixtures";

const source = JSON.parse(readFileSync("tokens/shared.tokens.json", "utf8"));
type TypographyRole = "body" | "label" | "input-phone" | "page-title" | "section-title";

async function expectTypography(element: Locator, role: TypographyRole): Promise<void> {
  const token = source.typography[role].$value;
  const computed = await element.evaluate(node => {
    const style = getComputedStyle(node);
    return {fontSize: style.fontSize, fontWeight: style.fontWeight, lineHeight: parseFloat(style.lineHeight), letterSpacing: style.letterSpacing, fontFamily: style.fontFamily};
  });
  expect(computed.fontSize).toBe(`${token.fontSize.value}${token.fontSize.unit}`);
  expect(computed.fontWeight).toBe(String(token.fontWeight));
  expect(computed.lineHeight).toBeCloseTo(token.fontSize.value * token.lineHeight, 1);
  // Browsers may serialize zero extra tracking as normal. Nonzero tokens remain exact.
  const letterSpacing = computed.letterSpacing === "normal" && token.letterSpacing.value === 0 ? "0px" : computed.letterSpacing;
  expect(letterSpacing).toBe(`${token.letterSpacing.value}${token.letterSpacing.unit}`);
  expect(computed.fontFamily).toContain(source.font.sans.$value[0]);
}

for (const width of [390, 1440]) test.describe(`semantic typography ${width}px`, () => {
  test.use({viewport: {width, height: 900}});
  test("uses canonical fonts in the body and shared form primitives", async ({page}) => {
    await page.goto("/admin?view=audit");
    await expectTypography(page.locator("body"), "body");
    await expectTypography(page.getByRole("button", {name: "筛选请求", exact: true}), "label");
    await expectTypography(page.locator("#request-from"), width === 390 ? "input-phone" : "body");
    // Request-filter captions are an explicit compact composition. Use a standard FieldLabel.
    await page.goto("/admin?view=access&task=add-person");
    await expectTypography(page.locator('[data-slot="field-label"]').first(), "label");
  });
  test("uses the full canonical title role after authority expires", async ({page,worker}) => {
    await page.goto('/admin?view=overview');
    worker.expireSessions();
    await page.evaluate(()=>document.dispatchEvent(new Event('visibilitychange')));
    const recovery = page.locator('[data-console-recovery]');
    await expect(recovery).toHaveAttribute('data-recovery-state','login');
    await expectTypography(recovery.getByRole('heading',{level:1}), 'page-title');
  });
});

test.describe("shared title typography", () => {
  test.use({viewport: {width: 1440, height: 900}});
  test("uses canonical titles in page and section compositions", async ({page}) => {
    await page.goto("/admin?view=access&person=member&task=give-access");
    await expectTypography(page.getByRole("heading", {name:"创建密钥",exact:true}), "page-title");
    await page.goto("/admin?view=surfaces");
    await expectTypography(page.locator(".panel-head h2").first(), "section-title");
  });
});
