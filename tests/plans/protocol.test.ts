import { describe, expect, it } from "vitest";
import { assertIssuableSurfaceGrants } from "../../src/auth/authenticate";
import { listExecutionPlans } from "../../src/plans/execution-plans";
import { hasReservedCredentialQuery } from "../../src/proxy/protocol";

describe("Execution Plan protocol", () => {
  it("detects reserved credential query names", () => {
    expect(hasReservedCredentialQuery(new URL("https://api.trustedtunnel.app/v1/models?api_key=x"))).toBe(true);
    expect(hasReservedCredentialQuery(new URL("https://api.trustedtunnel.app/v1/models?foo=1"))).toBe(false);
  });

  it("keeps the approved execution modes and protocol labels", () => {
    const modes = new Set(listExecutionPlans().map((plan) => plan.mode));
    expect([...modes].sort()).toEqual([
      "file_owner",
      "file_upload",
      "transparent",
      "video_poll",
      "video_start",
      "websocket_426",
      "websocket_transparent"
    ].sort());
    for (const plan of listExecutionPlans()) {
      expect(["openai/codex", "xai/grok", "xai/api"]).toContain(plan.protocol);
    }
  });

  it("rejects route-profile grants at issue time", () => {
    expect(() => assertIssuableSurfaceGrants(["route-profile:codex"])).toThrow();
    expect(() => assertIssuableSurfaceGrants(["surface:codex:production"])).not.toThrow();
  });
});
