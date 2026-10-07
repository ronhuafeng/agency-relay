import { describe, expect, it, vi } from "vitest";
import { readCodexAccountSnapshot } from "../../src/codex/account";
import type { AppDependencies, FreshAccessToken } from "../../src/types";
import egressProtocol from "../../deploy/codex-egress-shim/egress-protocol.json";
import {
  CODEX_PROFILE_RESPONSE,
  CODEX_RESET_CREDITS_RESPONSE,
  CODEX_USAGE_RESPONSE
} from "../fixtures/codex-account";

describe("Codex account snapshot", () => {
  it("reads the three fixed account resources concurrently with server-held auth", async () => {
    const pending = new Map<string, (response: Response) => void>();
    const transportTraceIds = new Set<string>();
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      expect(init?.method).toBe("GET");
      expect(init?.body).toBeUndefined();
      const headers = new Headers(init?.headers);
      expect(headers.get("Authorization")).toBe("Bearer shared-access");
      expect(headers.get("Chatgpt-Account-Id")).toBe("acct-shared");
      expect(headers.get("Accept")).toBe("application/json");
      expect(headers.get("Cookie")).toBeNull();
      expect(headers.get("CF-Access-Jwt-Assertion")).toBeNull();
      expect(headers.get(egressProtocol.manifestHeader)).toBe(JSON.stringify([
        "accept",
        "authorization",
        "chatgpt-account-id"
      ]));
      const transportTraceId = headers.get(egressProtocol.transportTrace.header);
      expect(transportTraceId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      transportTraceIds.add(transportTraceId!);
      return new Promise<Response>((resolve) => pending.set(url, resolve));
    });

    const snapshotPromise = readCodexAccountSnapshot(
      env(),
      deps(fetchMock as typeof fetch),
      token()
    );

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(transportTraceIds.size).toBe(3);
    expect([...pending.keys()].sort()).toEqual([
      "https://codex-egress-us-west1-a.trustedtunnel.app/account/profile",
      "https://codex-egress-us-west1-a.trustedtunnel.app/account/rate-limit-reset-credits",
      "https://codex-egress-us-west1-a.trustedtunnel.app/account/usage"
    ]);

    pending.get("https://codex-egress-us-west1-a.trustedtunnel.app/account/usage")?.(Response.json(CODEX_USAGE_RESPONSE));
    pending.get("https://codex-egress-us-west1-a.trustedtunnel.app/account/profile")?.(Response.json(CODEX_PROFILE_RESPONSE));
    pending.get("https://codex-egress-us-west1-a.trustedtunnel.app/account/rate-limit-reset-credits")?.(Response.json(CODEX_RESET_CREDITS_RESPONSE));

    await expect(snapshotPromise).resolves.toMatchObject({
      usage: {
        status: "available",
        data: {
          planType: "business",
          rateLimit: {
            allowed: true,
            primaryWindow: { usedPercent: 25, windowSeconds: 18_000 }
          },
          credits: { hasCredits: true, balance: "42.50" },
          spendControl: {
            reached: false,
            individualLimit: { used: "40.00", remaining: "60.00" }
          },
          additionalRateLimits: [{ name: "Code review", meteredFeature: "codex_review" }],
          rateLimitReachedType: "workspace_member_usage_limit_reached",
          resetCreditAvailableCount: 2
        }
      },
      profile: {
        status: "available",
        data: {
          lifetimeTokens: 1_234_567,
          peakDailyTokens: 45_678,
          longestRunningTurnSeconds: 321,
          currentStreakDays: 7,
          longestStreakDays: 19,
          dailyUsage: [
            { date: "2026-07-14", tokens: 12_345 },
            { date: "2026-07-15", tokens: 23_456 }
          ]
        }
      },
      resetCredits: {
        status: "available",
        data: {
          availableCount: 2,
          credits: [{
            id: "RateLimitResetCredit_1",
            resetType: "codexRateLimits",
            status: "available",
            title: "Full reset"
          }]
        }
      }
    });
  });

  it("isolates unavailable resources and ignores malformed optional fields", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = new URL(String(input)).pathname;
      if (path === "/account/usage") {
        return Response.json({
          plan_type: "business",
          credits: {
            has_credits: true,
            unlimited: false,
            balance: null
          }
        });
      }
      if (path === "/account/profile") {
        return Response.json({ stats: { lifetime_tokens: "not-a-number" } });
      }
      return Response.json({ available_count: 1 });
    });

    await expect(readCodexAccountSnapshot(env(), deps(fetchMock), token())).resolves.toMatchObject({
      usage: {
        status: "available",
        data: {
          planType: "business",
          credits: {
            approxLocalMessagesReported: undefined,
            approxCloudMessagesReported: undefined
          }
        }
      },
      profile: {
        status: "available",
        data: {
          lifetimeTokens: null,
          peakDailyTokens: null,
          longestRunningTurnSeconds: null,
          currentStreakDays: null,
          longestStreakDays: null,
          dailyUsage: []
        }
      },
      resetCredits: { status: "unavailable" }
    });
  });

  it("marks a successful usage response without required plan data unavailable", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = new URL(String(input)).pathname;
      if (path === "/account/usage") {
        return Response.json({ error: "unexpected-success-shape" });
      }
      if (path === "/account/profile") {
        return Response.json(CODEX_PROFILE_RESPONSE);
      }
      return Response.json(CODEX_RESET_CREDITS_RESPONSE);
    });

    const snapshot = await readCodexAccountSnapshot(env(), deps(fetchMock), token());

    expect(snapshot.usage).toEqual({ status: "unavailable" });
    expect(snapshot.profile.status).toBe("available");
    expect(snapshot.resetCredits.status).toBe("available");
  });

  it("bounds repeated presentation data while preserving authoritative counts", async () => {
    const additionalRateLimits = Array.from({ length: 60 }, (_, index) => ({
      limit_name: `Limit ${index}`,
      metered_feature: `feature_${index}`,
      rate_limit: null
    }));
    const dailyUsage = Array.from({ length: 400 }, (_, index) => ({
      start_date: `day-${index}`,
      tokens: index
    }));
    const resetCredits = Array.from({ length: 120 }, (_, index) => ({
      id: `credit_${index}`,
      reset_type: "codexRateLimits",
      status: "available",
      granted_at: "2026-07-15T00:00:00Z",
      expires_at: null,
      title: `Reset ${index}`,
      description: null
    }));
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = new URL(String(input)).pathname;
      if (path === "/account/usage") {
        return Response.json({
          ...CODEX_USAGE_RESPONSE,
          credits: {
            ...CODEX_USAGE_RESPONSE.credits,
            approx_local_messages: Array.from({ length: 600 }, () => ({ unknown: true })),
            approx_cloud_messages: Array.from({ length: 700 }, () => ({ future: true }))
          },
          additional_rate_limits: additionalRateLimits
        });
      }
      if (path === "/account/profile") {
        return Response.json({ stats: { ...CODEX_PROFILE_RESPONSE.stats, daily_usage_buckets: dailyUsage } });
      }
      return Response.json({ available_count: 321, credits: resetCredits });
    });

    const snapshot = await readCodexAccountSnapshot(env(), deps(fetchMock), token());

    expect(snapshot.usage.status).toBe("available");
    if (snapshot.usage.status !== "available") {
      throw new Error("usage should be available");
    }
    expect(snapshot.usage.data.additionalRateLimits).toHaveLength(50);
    expect(snapshot.usage.data.additionalRateLimits[0]).toMatchObject({ name: "Limit 0" });
    expect(snapshot.usage.data.credits).toMatchObject({
      approxLocalMessagesReported: 600,
      approxCloudMessagesReported: 700
    });
    expect(snapshot.profile.status).toBe("available");
    if (snapshot.profile.status !== "available") {
      throw new Error("profile should be available");
    }
    expect(snapshot.profile.data.dailyUsage).toHaveLength(366);
    expect(snapshot.resetCredits).toMatchObject({
      status: "available",
      data: { availableCount: 321 }
    });
    if (snapshot.resetCredits.status !== "available") {
      throw new Error("reset credits should be available");
    }
    expect(snapshot.resetCredits.data.credits).toHaveLength(100);
  });
});

function deps(fetchImpl: typeof fetch): AppDependencies {
  return { fetch: fetchImpl, now: () => new Date("2026-07-15T12:00:00.000Z") };
}

function env(): Env {
  return {
    CODEX_EGRESS_BASE_URL: "https://codex-egress-us-west1-a.trustedtunnel.app",
    CODEX_EGRESS_SECRET: "egress-secret"
  } as Env;
}

function token(): FreshAccessToken {
  return { access_token: "shared-access", account_id: "acct-shared" };
}
