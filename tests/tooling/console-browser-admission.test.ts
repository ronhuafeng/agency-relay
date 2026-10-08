import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const workflow = readFileSync(
  new URL("../../.github/workflows/console-browser.yml", import.meta.url),
  "utf8",
);

describe("console browser repository admission", () => {
  it("runs for pull requests to main and pushes to main", () => {
    expect(workflow).toMatch(/pull_request:\n\s+branches: \[main\]/);
    expect(workflow).toMatch(/push:\n\s+branches: \[main\]/);
  });

  it("has no changed-path or partial-engine selection path", () => {
    expect(workflow).not.toContain("Select the browser boundary");
    expect(workflow).not.toContain("needs: changes");
    expect(workflow).not.toContain("outputs:\n      relevant:");
    expect(workflow).not.toContain("fromJSON(");
  });

  it("runs the complete console suite in Chromium and WebKit", () => {
    expect(workflow).toContain("name: Chromium browser contracts");
    expect(workflow).toContain("project: chromium");
    expect(workflow).toContain("name: WebKit cross-engine contracts");
    expect(workflow).toContain("project: webkit");
    expect(workflow.match(/pnpm run test:browser --project=\$\{\{ matrix\.project \}\}/g)).toHaveLength(1);
  });

  it("keeps PR base comparison diagnostic rather than an admission substitute", () => {
    expect(workflow).toContain("Compare the same display fixture with the PR base when compatible");
    expect(workflow).toContain("continue-on-error: true");
    expect(workflow).toContain("HEAD_OUTCOME: ${{ steps.browser.outcome }}");
  });
});
