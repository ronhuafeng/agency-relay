import { describe, expect, it, vi } from "vitest";
import {
  fetchCodexAccountResource,
  forwardCodexChatGptBackend,
  forwardModels,
  forwardResponses
} from "../../src/codex/adapter";
import { codexEgressReadiness } from "../../src/codex/egress-transport";
import type { AppDependencies, RequestContext } from "../../src/types";
import type { FreshAccessToken } from "../../src/codex/types";

// Independent oracle: the only origin the VPC transport may address, and the shim's
// accepted paths, written as literals rather than derived from adapter helpers.
const VPC_ORIGIN = "http://codex-egress.internal";

interface RecordedCall {
  url: string;
  init: RequestInit;
}

function recordingBinding(response: () => Response = () => new Response("{}", { status: 200 })) {
  const calls: RecordedCall[] = [];
  const binding = {
    fetch: vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return response();
    })
  };
  return { binding, calls };
}

type EnvOverrides = Omit<Partial<Env>, "CODEX_EGRESS"> & { CODEX_EGRESS?: unknown };

function env(overrides: EnvOverrides = {}): Env {
  return {
    CODEX_EGRESS_SECRET: "egress-secret",
    ...overrides
  } as Env;
}

function deps(fetchMock: AppDependencies["fetch"]): AppDependencies {
  return { fetch: fetchMock, now: () => new Date("2026-11-25T00:00:00.000Z") };
}

function token(): FreshAccessToken {
  return { access_token: "codex_access", account_id: "acct_1" };
}

function requestContext(): RequestContext {
  return { requestId: "req_transport", startedAt: Date.now() };
}

function bodyStream(): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("{\"input\":\"hi\"}"));
      controller.close();
    }
  });
}

describe("Codex egress over the VPC binding", () => {
  it("sends models, account, responses and backend requests only through the binding", async () => {
    const { binding, calls } = recordingBinding();
    const globalFetch = vi.fn();
    const realGlobalFetch = vi.spyOn(globalThis, "fetch");
    const vpcEnv = env({ CODEX_EGRESS: binding });

    await forwardModels(new Request("https://relay.test/v1/models?client_version=0.99.0&x=a%2Fb"), vpcEnv, token());
    await fetchCodexAccountResource(vpcEnv, token(), "/account/usage");
    await forwardResponses(
      new Request("https://relay.test/v1/responses", { method: "POST" }),
      vpcEnv, deps(globalFetch), requestContext(), token(), bodyStream()
    );
    await forwardCodexChatGptBackend(
      new Request("https://relay.test/backend-api/transcribe", { method: "POST" }),
      vpcEnv, deps(globalFetch), requestContext(), token(), "/transcribe", bodyStream()
    );

    expect(globalFetch).not.toHaveBeenCalled();
    expect(realGlobalFetch).not.toHaveBeenCalled();
    realGlobalFetch.mockRestore();
    expect(calls.map(({ url, init }) => [init.method, url])).toEqual([
      ["GET", `${VPC_ORIGIN}/models?client_version=0.99.0&x=a%2Fb`],
      ["GET", `${VPC_ORIGIN}/account/usage`],
      ["POST", `${VPC_ORIGIN}/responses`],
      ["POST", `${VPC_ORIGIN}/transcribe`]
    ]);
    for (const { init } of calls) {
      expect(init.redirect).toBe("manual");
    }
  });

  it("fails closed before any credential exists when the binding is missing", async () => {
    const globalFetch = vi.fn();
    for (const missing of [undefined, null, {}, { fetch: "not-a-function" }]) {
      await expect(forwardModels(
        new Request("https://relay.test/v1/models"),
        env({ CODEX_EGRESS: missing }),
        token()
      )).rejects.toMatchObject({ status: 500, code: "missing_codex_egress_binding" });
    }
    // No fallback: global fetch is never used for Codex egress.
    expect(globalFetch).not.toHaveBeenCalled();
  });

  it("maps a VPC proxy failure to a sanitized transport error", async () => {
    const errors: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((line: string) => { errors.push(line); });
    const binding = {
      fetch: vi.fn(async () => {
        throw new Error("ProxyError: connection_refused Bearer codex_access");
      })
    };
    try {
      await expect(forwardResponses(
        new Request("https://relay.test/v1/responses", { method: "POST" }),
        env({ CODEX_EGRESS: binding }), deps(vi.fn()), requestContext(), token(), bodyStream()
      )).rejects.toMatchObject({ status: 502, code: "codex_upstream_transport_error" });
    } finally {
      spy.mockRestore();
    }
    const logged = errors.join("\n");
    expect(logged).toContain("connection_refused");
    expect(logged).not.toContain("codex_access");
    expect(logged).not.toContain("egress-secret");
  });

});

describe("Codex egress readiness", () => {
  const binding = { fetch: () => Promise.reject(new Error("unused")) };

  it.each([
    [{ CODEX_EGRESS: binding }, "configured"],
    [{ CODEX_EGRESS: undefined }, "missing"],
    [{ CODEX_EGRESS: { fetch: "not-a-function" } }, "missing"],
    [{ CODEX_EGRESS: binding, CODEX_EGRESS_SECRET: "" }, "missing"]
  ])("reports %j as %s without performing a request", (overrides, expected) => {
    expect(codexEgressReadiness(env(overrides as EnvOverrides))).toBe(expected);
  });
});
