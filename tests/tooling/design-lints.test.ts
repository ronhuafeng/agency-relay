import { ESLint } from "eslint";
import stylelint from "stylelint";
import { describe, expect, it } from "vitest";

const eslint = new ESLint({ cwd: process.cwd() });

describe("console design checks", () => {
  it("accepts the authored console stylesheet and rejects a raw token redefinition", async () => {
    const accepted = await stylelint.lint({ files: "src/admin/console.css", configFile: "stylelint.config.mjs" });
    expect(accepted.errored).toBe(false);
    const rejected = await stylelint.lint({
      code: ".sample { color: #ff00aa; background: var(--not-a-token); }\n",
      codeFilename: "src/admin/sample.css",
      configFile: "stylelint.config.mjs",
    });
    expect(rejected.errored).toBe(true);
    const rules = rejected.results[0]?.warnings.map((warning) => warning.rule) ?? [];
    expect(rules).toContain("color-no-hex");
    expect(rules).toContain("mini/token-policy");
  });

  it("accepts a structural custom property and rejects a local elevation alias", async () => {
    const accepted = await stylelint.lint({
      code: ".sample { --track: 24px; width: var(--track); color: var(--background); }\n",
      codeFilename: "src/admin/structural.css",
      configFile: "stylelint.config.mjs",
    });
    expect(accepted.errored).toBe(false);
    const laundered = await stylelint.lint({
      code: ".sample { --local-elevation: 4px 4px 0 var(--pixel); box-shadow: var(--local-elevation); }\n",
      codeFilename: "src/admin/laundered.css",
      configFile: "stylelint.config.mjs",
    });
    expect(laundered.errored).toBe(true);
    expect(laundered.results[0]?.warnings.some((warning) => warning.rule === "mini/token-policy")).toBe(true);
    const fallback = await stylelint.lint({
      code: ".sample { --local-color: var(--primary, red); color: var(--local-color); }\n",
      codeFilename: "src/admin/fallback.css",
      configFile: "stylelint.config.mjs",
    });
    expect(fallback.errored).toBe(true);
    expect(fallback.results[0]?.warnings.some((warning) => warning.rule === "mini/token-policy")).toBe(true);
    expect(fallback.results[0]?.warnings.some((warning) => warning.rule === "color-no-hex")).toBe(false);
    const chain = await stylelint.lint({
      code: ".sample { --shape: 24px; --visual-alias: var(--shape); border-radius: var(--visual-alias); }\n",
      codeFilename: "src/admin/alias-chain.css",
      configFile: "stylelint.config.mjs",
    });
    expect(chain.errored).toBe(true);
    expect(chain.results[0]?.warnings.some((warning) => warning.rule === "mini/token-policy" && warning.text.includes("--visual-alias"))).toBe(true);
  });

  it("rejects an arbitrary visual class and an authored color style", async () => {
    const arbitrary = await eslint.lintText('export function Sample() { return <div className="bg-[#fff]" />; }\n', {
      filePath: "src/admin/ui/sample.tsx",
    });
    expect(arbitrary[0]?.errorCount).toBeGreaterThan(0);
    const visual = await eslint.lintText('export function Sample() { return <div style={{ color: "#fff" }} />; }\n', {
      filePath: "src/admin/ui/sample.tsx",
    });
    expect(visual[0]?.messages.some((message) => message.ruleId === "mini/visual-style")).toBe(true);
    const tokenClass = await eslint.lintText('export function Sample() { return <div className="bg-primary" />; }\n', {
      filePath: "src/admin/ui/sample.tsx",
    });
    expect(tokenClass[0]?.errorCount).toBe(0);
  });
});
