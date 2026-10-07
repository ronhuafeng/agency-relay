import { describe, expect, it } from "vitest";
import {
  projectUpstreamClientIdentity,
  type ProjectedUpstreamClientIdentity
} from "../../src/plans/client-identity";
import type { UpstreamClientIdentity } from "../../src/plans/execution-plans";

const FALLBACK_VERSION = "1.2.3";

function projectedIdentity(
  identity: UpstreamClientIdentity,
  request: Request,
  headers: Headers,
  fallbackVersion: string | null = null
): ProjectedUpstreamClientIdentity {
  const projected = projectUpstreamClientIdentity(identity, request, headers, fallbackVersion);
  if (!projected) throw new Error("expected identity projection");
  return projected;
}

describe("Upstream Client Identity", () => {
  it("does not project identity for a none plan", () => {
    const request = new Request("https://xai.trustedtunnel.app/v1/models?future=a%20b", {
      headers: {
        Originator: "third-party",
        "User-Agent": "third-party/9.0",
        "x-grok-client-version": "9.0.0"
      }
    });

    const projected = projectedIdentity("none", request, request.headers);

    expect(projected.search).toBe("?future=a%20b");
    expect(Object.fromEntries(projected.headers)).toMatchObject({
      originator: "third-party",
      "user-agent": "third-party/9.0",
      "x-grok-client-version": "9.0.0"
    });
  });

  it("passes a native Codex bundle with an official thread-scoped Originator override", () => {
    const request = new Request("https://api.trustedtunnel.app/v1/responses?future=%2f", {
      method: "POST",
      headers: {
        Originator: "codex-tui",
        "User-Agent": "codex_cli_rs/0.149.0 (Mac OS 15.6; arm64) Apple_Terminal/455"
      }
    });

    const projected = projectedIdentity("codex_cli", request, request.headers);

    expect(projected.search).toBe("?future=%2f");
    expect(projected.headers.get("Originator")).toBe("codex-tui");
    expect(projected.headers.get("User-Agent")).toBe(
      "codex_cli_rs/0.149.0 (Mac OS 15.6; arm64) Apple_Terminal/455"
    );
  });

  it("requires the matching models query to accept a native Codex bundle", () => {
    const native = new Request(
      "https://api.trustedtunnel.app/v1/models?client_version=0.149.0&future=a%20b",
      {
        headers: {
          Originator: "codex_cli_rs",
          "User-Agent": "codex_cli_rs/0.149.0+dev (Linux 6.6; x86_64) unknown"
        }
      }
    );

    const projected = projectedIdentity("codex_cli", native, native.headers);

    expect(projected.search).toBe("?client_version=0.149.0&future=a%20b");
    expect(projected.headers.get("User-Agent")).toContain("/0.149.0+dev ");
  });

  it("atomically replaces a partial Codex bundle and preserves unrelated query bytes", () => {
    const request = new Request(
      "https://api.trustedtunnel.app/v1/models?future=a%20b&client_version=old&slash=%2f&client%5Fversion=older&tail=%7e",
      {
        headers: {
          Originator: "codex_cli_rs",
          "User-Agent": "third-party/9.0.0"
        }
      }
    );

    const projected = projectedIdentity(
      "codex_cli",
      request,
      request.headers,
      FALLBACK_VERSION
    );

    expect(projected?.search).toBe(
      `?future=a%20b&slash=%2f&tail=%7e&client_version=${FALLBACK_VERSION}`
    );
    expect(projected?.headers.get("Originator")).toBe("codex_cli_rs");
    expect(projected?.headers.get("User-Agent")).toBe(
      `codex_cli_rs/${FALLBACK_VERSION} (Linux 6.6; x86_64) unknown`
    );
  });

  it("does not invent a Codex fallback version", () => {
    const request = new Request("https://api.trustedtunnel.app/v1/models", {
      headers: { Originator: "codex_cli_rs", "User-Agent": "third-party/9.0.0" }
    });

    expect(projectUpstreamClientIdentity("codex_cli", request, request.headers, null)).toBeNull();
  });

  it("passes one complete native Grok bundle without changing its version", () => {
    const request = new Request("https://grok.trustedtunnel.app/v1/responses", {
      method: "POST",
      headers: {
        "x-grok-client-version": "1.0.11",
        "x-grok-client-identifier": "grok-shell",
        "x-grok-client-mode": "interactive",
        "User-Agent": "grok-shell/1.0.11 (macos; aarch64)"
      }
    });

    const projected = projectedIdentity("grok_build", request, request.headers);

    expect(projected.headers.get("x-grok-client-version")).toBe("1.0.11");
    expect(projected.headers.get("x-grok-client-identifier")).toBe("grok-shell");
    expect(projected.headers.get("x-grok-client-mode")).toBe("interactive");
    expect(projected.headers.get("User-Agent")).toBe("grok-shell/1.0.11 (macos; aarch64)");
  });

  it.each([
    ["mismatched version", {
      "x-grok-client-version": "1.0.11",
      "x-grok-client-identifier": "grok-shell",
      "x-grok-client-mode": "headless",
      "User-Agent": "grok-shell/1.0.10 (macos; aarch64)"
    }]
  ])("atomically replaces a Grok bundle with %s", (_label, inputHeaders) => {
    const request = new Request("https://grok.trustedtunnel.app/v1/responses", {
      method: "POST",
      headers: inputHeaders
    });

    const projected = projectedIdentity(
      "grok_build",
      request,
      request.headers,
      FALLBACK_VERSION
    );

    expect(projected?.headers.get("x-grok-client-version")).toBe(FALLBACK_VERSION);
    expect(projected?.headers.get("x-grok-client-identifier")).toBe("grok-shell");
    expect(projected?.headers.get("x-grok-client-mode")).toBe("headless");
    expect(projected?.headers.get("User-Agent")).toBe(
      `grok-shell/${FALLBACK_VERSION} (linux; x86_64)`
    );
  });

  it("does not invent a Grok fallback version", () => {
    const request = new Request("https://grok.trustedtunnel.app/v1/responses", { method: "POST" });

    expect(projectUpstreamClientIdentity("grok_build", request, request.headers, null)).toBeNull();
  });

  it("passes a native Grok bundle without the optional custom-base-url mode", () => {
    const request = new Request("https://grok.trustedtunnel.app/v1/responses", {
      method: "POST",
      headers: {
        "x-grok-client-version": "1.0.11",
        "x-grok-client-identifier": "grok-shell",
        "User-Agent": "grok-shell/1.0.11 (macos; aarch64)"
      }
    });

    const projected = projectedIdentity("grok_build", request, request.headers);

    expect(projected.headers.get("x-grok-client-version")).toBe("1.0.11");
    expect(projected.headers.get("x-grok-client-mode")).toBeNull();
    expect(projected.headers.get("User-Agent")).toBe("grok-shell/1.0.11 (macos; aarch64)");
  });
});
