import { describe, expect, it } from "vitest";
import {
  codexTokenFromParsedSession,
  parseCodexSessionArtifact
} from "../../src/codex/session-import";
import { HttpError } from "../../src/errors";

describe("parseCodexSessionArtifact", () => {
  it("parses Codex auth.json tokens nested shape", () => {
    const parsed = parseCodexSessionArtifact(JSON.stringify({
      tokens: {
        access_token: "at_live",
        refresh_token: "rt_live",
        id_token: "idt_live",
        expires_at: "2099-01-01T00:00:00.000Z"
      },
      email: "user@example.com",
      chatgpt_account_id: "acct_123"
    }), new Date("2026-07-28T00:00:00.000Z"));

    expect(parsed).toMatchObject({
      access_token: "at_live",
      refresh_token: "rt_live",
      id_token: "idt_live",
      email: "user@example.com",
      account_id: "acct_123",
      import_source: "codex_session"
    });
    expect(parsed.warnings.some((w) => w.includes("sessionToken"))).toBe(false);

    const token = codexTokenFromParsedSession("shared_default", parsed, new Date("2026-07-28T00:00:00.000Z"));
    expect(token.access_token).toBe("at_live");
    expect(token.refresh_token).toBe("rt_live");
    expect(token.email).toBe("user@example.com");
  });

  it("ignores sessionToken and accepts bare access token", () => {
    const withSession = parseCodexSessionArtifact(JSON.stringify({
      access_token: "at_only",
      session_token: "not_a_refresh"
    }));
    expect(withSession.refresh_token).toBeUndefined();
    expect(withSession.warnings.join(" ")).toMatch(/sessionToken/i);

    const bare = parseCodexSessionArtifact("plain_access_token_value");
    expect(bare.access_token).toBe("plain_access_token_value");
    expect(bare.import_source).toBe("access_token_only");
  });

  it("rejects expired access tokens", () => {
    expect(() => parseCodexSessionArtifact(JSON.stringify({
      access_token: "at",
      expires_at: "2020-01-01T00:00:00.000Z"
    }), new Date("2026-07-28T00:00:00.000Z"))).toThrow(HttpError);
  });
});
