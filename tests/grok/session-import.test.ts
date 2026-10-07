import { describe, expect, it } from "vitest";
import { GROK_OIDC_ISSUER, GROK_OAUTH_DEFAULT_CLIENT_ID } from "../../src/grok/oauth";
import { parseGrokSessionArtifact } from "../../src/grok/session-import";
import { HttpError } from "../../src/errors";

describe("parseGrokSessionArtifact", () => {
  it("parses nested credentials JSON with default OIDC metadata", () => {
    const parsed = parseGrokSessionArtifact(JSON.stringify({
      tokens: {
        access_token: "gat",
        refresh_token: "grt",
        expires_at: "2099-01-01T00:00:00.000Z"
      },
      email: "g@example.com"
    }));
    expect(parsed).toMatchObject({
      access_token: "gat",
      refresh_token: "grt",
      oidc_issuer: GROK_OIDC_ISSUER,
      oidc_client_id: GROK_OAUTH_DEFAULT_CLIENT_ID,
      import_source: "grok_session"
    });
  });

  it("rejects unsupported issuer", () => {
    expect(() => parseGrokSessionArtifact(JSON.stringify({
      access_token: "gat",
      oidc_issuer: "https://evil.example"
    }))).toThrow(HttpError);
  });
});
