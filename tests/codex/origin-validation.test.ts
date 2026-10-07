import { describe, expect, it } from "vitest";
import { normalizeError } from "../../src/errors";
import { assertCodexEgressBaseUrl, CODEX_EGRESS_HOSTNAME, isStrictHttpsOrigin } from "../../src/proxy/origin";

describe("Codex egress origin and public errors", () => {
  it("accepts only the fixed Codex egress HTTPS origin", () => {
    expect(CODEX_EGRESS_HOSTNAME).toBe("codex-egress-us-west1-a.trustedtunnel.app");
    expect(assertCodexEgressBaseUrl(`https://${CODEX_EGRESS_HOSTNAME}`)).toBe(`https://${CODEX_EGRESS_HOSTNAME}`);
    expect(isStrictHttpsOrigin(`https://${CODEX_EGRESS_HOSTNAME}`)).toBe(true);
    expect(() => assertCodexEgressBaseUrl("https://evil.example")).toThrow();
  });

  it("redacts unknown exception messages from public errors", () => {
    const publicError = normalizeError(new Error("ECONNREFUSED 10.0.0.1:443 secret=abc"));
    expect(publicError.status).toBe(500);
    expect(publicError.message).not.toContain("ECONNREFUSED");
    expect(publicError.message).not.toContain("secret");
  });
});
