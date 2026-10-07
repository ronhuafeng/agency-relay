import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const primitives = readFileSync("src/admin/ui/components/primitives.css", "utf8");
const layout = readFileSync("src/admin/console-layout.css", "utf8");

describe("shared control token owners", () => {
  it("uses the generated control and overlay tokens for shared primitive and menu decisions", () => {
    expect(primitives).toContain("min-height:var(--control-target)");
    expect(primitives).toContain("box-shadow:var(--shadow-overlay)");
    expect(primitives).toContain("width:var(--control-menu)");
    expect(primitives).not.toContain("44px");
    expect(primitives).not.toContain("4px 4px 0");
    expect(layout).toContain("box-shadow:var(--shadow-overlay)");
    expect(layout).not.toContain("width:280px");
    expect(layout).not.toContain("4px 4px 0");
  });
});
