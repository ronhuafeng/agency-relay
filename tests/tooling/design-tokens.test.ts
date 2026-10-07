import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { projectDesignTokens } from "../../scripts/design-tokens";

describe("DTCG console projection", () => {
  it("projects the shared palette into the runtime theme and design.md", async () => {
    const source = readFileSync("design.md", "utf8");
    const projected = await projectDesignTokens(source);
    for (const theme of [projected.theme.light, projected.theme.dark]) {
      expect(theme.background).toMatch(/^#[0-9a-f]{6}$/);
      expect(theme.card).toMatch(/^#[0-9a-f]{6}$/);
      expect(projected.css).toContain(`--background: ${theme.background};`);
      expect(projected.css).toContain(`--card: ${theme.card};`);
      expect(projected.designMd).toContain(`"${theme.background}"`);
      expect(projected.designMd).toContain(`"${theme.card}"`);
    }
    expect(projected.theme.light.background).not.toBe(projected.theme.dark.background);
    expect(projected.css).toContain("--shadow-soft: 2px 2px 0 var(--pixel);");
    expect(projected.css).not.toContain("var(color-pixel)");
    const defined = new Set([...projected.css.matchAll(/(--[\w-]+)\s*:/g)].map(match => match[1]));
    const references = [...projected.css.matchAll(/var\(([^,)]+)/g)].map(match => match[1]);
    expect(references.every(name => defined.has(name))).toBe(true);
    expect(projected.css).toContain("--typography-body-font-family: var(--font-family-sans);");
    expect(projected.css).toContain("--typography-technical-font-family: var(--font-family-mono);");
    expect(projected.designMd).toBe(source);
  });
  it("projects an edited canonical typography into both native CSS and design.md", async () => {
    const directory = mkdtempSync(join(tmpdir(), "mini-typography-"));
    try {
      cpSync("tokens", directory, {recursive: true});
      const path = join(directory, "shared.tokens.json");
      const shared = JSON.parse(readFileSync(path, "utf8"));
      shared.typography.body.$value.fontSize.value = 18;
      shared.typography.body.$value.fontWeight = 425;
      shared.typography.body.$value.lineHeight = 1.7;
      shared.typography.body.$value.letterSpacing.value = 0.2;
      shared.typography.body.$value.fontFamily = "{font.mono}";
      shared.font.sans.$value = ["Fixture Sans", "sans-serif"];
      shared.font.mono.$value = ["Fixture Mono", "monospace"];
      writeFileSync(path, JSON.stringify(shared));
      const projected = await projectDesignTokens(readFileSync("design.md", "utf8"), pathToFileURL(join(directory, "console.resolver.json")));
      expect(projected.css).toContain("--typography-body-font-size: 18px;");
      expect(projected.css).toContain("--typography-body-font-weight: 425;");
      expect(projected.css).toContain("--typography-body-line-height: 1.7;");
      expect(projected.css).toContain("--typography-body-letter-spacing: 0.2px;");
      expect(projected.css).toContain('--font-family-sans: "Fixture Sans", sans-serif;');
      expect(projected.css).toContain('--font-family-mono: "Fixture Mono", monospace;');
      expect(projected.css).toContain("--typography-body-font-family: var(--font-family-mono);");
      expect(projected.css).toContain("--typography-body: var(--typography-body-font-weight) var(--typography-body-font-size)/var(--typography-body-line-height) var(--typography-body-font-family);");
      expect(projected.designMd).toContain("  body:\n    fontFamily: '\"Fixture Mono\", monospace'\n    fontSize: 18px\n    fontWeight: 425\n    lineHeight: 1.7");
    } finally {
      rmSync(directory, {recursive: true, force: true});
    }
  });
});
