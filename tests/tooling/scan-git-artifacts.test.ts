import { describe, expect, it } from "vitest";
import { isDisallowedArtifactPath } from "../../scripts/scan-git-artifacts";

describe("Git-visible artifact scan", () => {
  it("detects forbidden Git-visible paths without rejecting the canonical env template", () => {
    expect(isDisallowedArtifactPath(".env")).toBe(true);
    expect(isDisallowedArtifactPath("config/.env.local")).toBe(true);
    expect(isDisallowedArtifactPath("local-secrets/user/api_key.txt")).toBe(true);
    expect(isDisallowedArtifactPath("local-secrets\\user\\api_key.txt")).toBe(true);
    expect(isDisallowedArtifactPath("nested/.codex/config.json")).toBe(true);
    expect(isDisallowedArtifactPath(".codex/config.toml")).toBe(false);
    expect(isDisallowedArtifactPath(".codex/local-state.json")).toBe(true);
    expect(isDisallowedArtifactPath("certificates/private.pem")).toBe(true);
    expect(isDisallowedArtifactPath("keys/identity.key")).toBe(true);
    expect(isDisallowedArtifactPath("password.txt")).toBe(true);
    expect(isDisallowedArtifactPath(".env.example")).toBe(false);
    expect(isDisallowedArtifactPath(".dev.vars")).toBe(true);
    expect(isDisallowedArtifactPath(".dev.vars.local")).toBe(true);
    expect(isDisallowedArtifactPath(".dev.vars.example")).toBe(true);
    expect(isDisallowedArtifactPath("src/auth.ts")).toBe(false);
  });
});
