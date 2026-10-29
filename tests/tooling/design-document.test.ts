import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";

it("checks without writing, updates only the token projection, then accepts the updated document", () => {
  const directory = mkdtempSync(join(tmpdir(), "design-document-"));
  try {
    const source = readFileSync("design.md", "utf8");
    const end = source.indexOf("\n---\n", 4) + 5;
    const prose = "\n# Human guidance\nPreserve this exact text.\n";
    const stale = source.slice(0, end).replace(/name: Agency Relay Console/, "name: Stale Projection") + prose;
    const path = join(directory, "design.md");
    writeFileSync(path, stale);
    const run = (mode: string) => spawnSync(process.execPath, [resolve("node_modules/tsx/dist/cli.mjs"), resolve("scripts/design-document.ts"), mode], { cwd: directory, encoding: "utf8" });
    expect(run("check").status).toBe(1);
    expect(readFileSync(path, "utf8")).toBe(stale);
    expect(run("update").status).toBe(0);
    expect(readFileSync(path, "utf8")).toBe(source.slice(0, end) + prose);
    expect(run("check").status).toBe(0);
    expect(readdirSync(directory)).toEqual(["design.md"]);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
