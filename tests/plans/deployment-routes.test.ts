import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("Route Profile deployment activation", () => {
  it("activates Codex, Grok, and explicit xAI production hostnames only", () => {
    const config = JSON.parse(
      readFileSync(new URL("../../wrangler.jsonc", import.meta.url), "utf8")
    ) as {
      compatibility_flags: string[];
      routes: Array<{ pattern?: string }>;
    };
    const patterns = config.routes.map((route) => route.pattern ?? null);

    expect(patterns).toEqual([
      "api.trustedtunnel.app/*",
      "grok.trustedtunnel.app/*",
      "xai.trustedtunnel.app/*",
      "mini-proxy.uniweaver.com"
    ]);
    expect(config.compatibility_flags).toContain("global_fetch_strictly_public");
  });
});
