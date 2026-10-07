import { describe, expect, it, vi } from "vitest";
import { refreshGrokOidcToken } from "../../src/grok/oauth";
import type { SubscriptionCredential } from "../../src/auth/subscription-accounts";
import type { AppDependencies } from "../../src/types";

describe("Grok OIDC refresh", () => {
  it("discovers the same-origin token endpoint and rotates tokens", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith("/.well-known/openid-configuration")) {
        expect(init).toMatchObject({ method: "GET", redirect: "manual" });
        return Response.json({ token_endpoint: "https://auth.x.ai/oauth/token" });
      }
      expect(String(input)).toBe("https://auth.x.ai/oauth/token");
      expect(init).toMatchObject({ method: "POST", redirect: "manual" });
      const body = new URLSearchParams(String(init?.body));
      expect(body.get("grant_type")).toBe("refresh_token");
      expect(body.get("refresh_token")).toBe("old-refresh");
      expect(body.get("client_id")).toBe("grok-client");
      return Response.json({
        access_token: "new-access",
        refresh_token: "new-refresh",
        expires_in: 3600
      });
    });

    const refreshed = await refreshGrokOidcToken(
      deps(fetchMock),
      credential(),
      new Date("2026-07-26T00:00:00.000Z")
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(refreshed).toMatchObject({
      access_token: "new-access",
      refresh_token: "new-refresh",
      expires_at: "2026-07-26T01:00:00.000Z",
      status: "active",
      last_refresh_at: "2026-07-26T00:00:00.000Z"
    });
  });

  it("retains the previous refresh token when the authority does not rotate it", async () => {
    const fetchMock = successfulFetch({ access_token: "new-access", expires_in: 60 });
    const refreshed = await refreshGrokOidcToken(deps(fetchMock), credential());

    expect(refreshed.refresh_token).toBe("old-refresh");
  });

  it.each(["invalid_grant", "invalid_client"])(
    "classifies %s as a terminal credential failure",
    async (error) => {
      const fetchMock = successfulFetch({ error }, 400);

      await expect(refreshGrokOidcToken(deps(fetchMock), credential())).rejects.toMatchObject({
        status: 401,
        code: error
      });
    }
  );

  it("keeps network and non-terminal OAuth failures retryable and secret-safe", async () => {
    const refreshSecret = "never-leak-this-refresh-token";
    const cases = [
      vi.fn(async () => {
        throw new Error(refreshSecret);
      }),
      successfulFetch({ error: "temporarily_unavailable", error_description: refreshSecret }, 503)
    ];

    for (const fetchMock of cases) {
      const failure = await refreshGrokOidcToken(
        deps(fetchMock),
        credential({ refresh_token: refreshSecret })
      ).catch((error: unknown) => error);
      expect(failure).toMatchObject({
        status: 502,
        code: "grok_token_refresh_failed"
      });
      expect(String(failure)).not.toContain(refreshSecret);
    }
  });

  it("never sends a refresh token to a cross-origin discovered endpoint", async () => {
    const refreshSecret = "never-send-cross-origin";
    const fetchMock = vi.fn(async () => Response.json({
      token_endpoint: "https://attacker.example/token"
    }));

    const failure = await refreshGrokOidcToken(
      deps(fetchMock),
      credential({ refresh_token: refreshSecret })
    ).catch((error: unknown) => error);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(failure).toMatchObject({
      status: 502,
      code: "grok_token_refresh_failed"
    });
    expect(JSON.stringify(fetchMock.mock.calls)).not.toContain(refreshSecret);
  });
});

function credential(
  patch: Partial<SubscriptionCredential> = {}
): SubscriptionCredential {
  return {
    account_id: "sub_grok",
    capability_source: "grok",
    access_token: "old-access",
    refresh_token: "old-refresh",
    oidc_issuer: "https://auth.x.ai",
    oidc_client_id: "grok-client",
    expires_at: "2026-07-26T00:05:00.000Z",
    status: "active",
    ...patch
  };
}

function deps(fetchMock: typeof fetch): AppDependencies {
  return {
    fetch: fetchMock,
    now: () => new Date("2026-07-26T00:00:00.000Z")
  };
}

function successfulFetch(
  tokenBody: Record<string, unknown>,
  tokenStatus = 200
): typeof fetch {
  return vi.fn(async (input: RequestInfo | URL) => {
    if (String(input).endsWith("/.well-known/openid-configuration")) {
      return Response.json({ token_endpoint: "https://auth.x.ai/oauth/token" });
    }
    return Response.json(tokenBody, { status: tokenStatus });
  }) as unknown as typeof fetch;
}
