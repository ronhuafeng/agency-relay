import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

// Execute the actual workflow shell against a real Git diff. Keep the selector
// in its owning workflow instead of duplicating its path expressions in a test.
const workflow = readFileSync(new URL("../../.github/workflows/console-browser.yml", import.meta.url), "utf8");
const pathsStep = workflow.match(/^      - id: paths\n((?:        .*\n|\n)+)/m)?.[1];
const run = pathsStep?.match(/^        run: \|\n((?:          .*\n)+)/m)?.[1];
if (!run) throw new Error("Browser selection step has no executable shell");
const selectionScript = run.replace(/^          /gm, "");

function select(paths: string[], event: "pull_request" | "push" = "pull_request") {
  const directory = mkdtempSync(join(tmpdir(), "mini-browser-selection-"));
  try {
    const git = (...args: string[]) => execFileSync("git", [
      "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "-c", "commit.gpgsign=false", ...args
    ], { cwd: directory, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    git("init", "--quiet", "--initial-branch=main");
    writeFileSync(join(directory, ".fixture"), "base\n");
    git("add", ".fixture");
    git("commit", "--quiet", "-m", "base");
    const base = git("rev-parse", "HEAD");
    for (const path of paths) {
      const file = join(directory, path);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, "changed\n");
    }
    if (paths.length) {
      git("add", ".");
      git("commit", "--quiet", "-m", "change");
    }
    const output = join(directory, "outputs");
    const summary = join(directory, "summary");
    execFileSync("bash", ["-e", "-o", "pipefail", "-c", selectionScript.replaceAll("${{ github.event_name }}", event)], {
      cwd: directory, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, BASE: base, RUNNER_TEMP: directory, GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: summary }
    });
    return Object.fromEntries(readFileSync(output, "utf8").trim().split("\n").map(line => line.split("=")));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe("native console browser workflow selection", () => {
  it.each(["tests/browser/worker.ts", "tests/browser/fixtures.ts"])("selects both engines for the shared %s boundary", path => {
    expect(select([path])).toEqual({ relevant: "true", webkit: "true" });
  });
  it.each(["src/admin/app.ts", "tests/browser/shell-installation.spec.ts", "tests/browser/service-delegation.spec.ts", ".github/workflows/console-browser.yml"])("preserves existing two-engine selection for %s", path => {
    expect(select([path])).toEqual({ relevant: "true", webkit: "true" });
  });
  it.each(["src/admin/console.css", "tokens/light.tokens.json", "tests/browser/remaining-layouts.spec.ts", "tests/browser/worker.ts.bak", "tests/browser/nested/fixtures.ts"])("retains Chromium-only PR selection for %s", path => {
    expect(select([path])).toEqual({ relevant: "true", webkit: "false" });
  });
  it("does not select an unrelated documentation and tooling-test PR", () => {
    expect(select(["docs/product/experience.md", "tests/tooling/console-browser-selection.test.ts"])).toEqual({ relevant: "false", webkit: "false" });
  });
  it.each([{ paths: [] }, { paths: ["docs/product/experience.md"] }])("always selects both engines on main push with paths $paths", ({ paths }) => {
    expect(select(paths, "push")).toEqual({ relevant: "true", webkit: "true" });
  });
});
