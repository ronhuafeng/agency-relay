import { describe, expect, it } from "vitest";
import { normalizeError } from "../../src/errors";
import { isStrictHttpsOrigin } from "../../src/proxy/origin";

describe("Provider origins and public errors", () => {
  it("accepts only a bare HTTPS origin", () => {
    expect(isStrictHttpsOrigin("https://provider.example")).toBe(true);
    for (const rejected of ["http://provider.example", "https://user:pw@provider.example", "https://provider.example/path", "https://provider.example/?q=1", "not a url"]) {
      expect(isStrictHttpsOrigin(rejected)).toBe(false);
    }
  });

  it("redacts unknown exception messages from public errors", () => {
    const publicError = normalizeError(new Error("ECONNREFUSED 10.0.0.1:443 secret=abc"));
    expect(publicError.status).toBe(500);
    expect(publicError.message).not.toContain("ECONNREFUSED");
    expect(publicError.message).not.toContain("secret");
  });
});
