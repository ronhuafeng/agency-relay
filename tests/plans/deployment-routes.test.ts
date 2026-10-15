import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("Route Profile deployment activation", () => {
  it("declares only approved Provider, Runtime and console hosts with the canonical Stitch resource", () => {
    const config = JSON.parse(
      readFileSync(new URL("../../wrangler.jsonc", import.meta.url), "utf8")
    ) as {
      compatibility_flags: string[];
      routes: Array<{ pattern?: string; custom_domain?: boolean }>;
      vars: { RUNTIME_INSTALLATIONS: string };
    };
    const patterns = config.routes.map((route) => route.pattern ?? null);

    expect(patterns.sort()).toEqual([
      "api.trustedtunnel.app/*",
      "grok.trustedtunnel.app/*",
      "xai.trustedtunnel.app/*",
      "mcp.trustedtunnel.app",
      "mini-proxy.uniweaver.com"
    ].sort());
    expect(config.routes.find(route=>route.pattern==="mcp.trustedtunnel.app")).toEqual({pattern:"mcp.trustedtunnel.app",custom_domain:true});
    expect(JSON.parse(config.vars.RUNTIME_INSTALLATIONS)).toEqual([expect.objectContaining({
      id:"google-stitch",resource:"https://mcp.trustedtunnel.app/google-stitch",profile:"google.stitch"
    })]);
    expect(config.compatibility_flags).toContain("global_fetch_strictly_public");
  });
});
