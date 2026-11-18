import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("Route Profile deployment activation", () => {
  it("keeps the public build configuration local and leaves production ingress closed", () => {
    const config = JSON.parse(
      readFileSync(new URL("../../wrangler.jsonc", import.meta.url), "utf8")
    ) as {
      compatibility_flags: string[];
      routes: Array<{ pattern?: string; custom_domain?: boolean }>;
      vars: { RUNTIME_INSTALLATIONS: string; RUNTIME_MCP_ORIGIN: string };
      workers_dev: boolean;
      preview_urls: boolean;
    };
    expect(config.routes).toEqual([]);
    expect(config.workers_dev).toBe(false);
    expect(config.preview_urls).toBe(false);
    expect(JSON.parse(config.vars.RUNTIME_INSTALLATIONS)).toEqual([]);
    expect(config.vars.RUNTIME_MCP_ORIGIN).toBe("");
    expect(config.compatibility_flags).toContain("global_fetch_strictly_public");
  });
});
