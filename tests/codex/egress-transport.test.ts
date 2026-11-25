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
import egressProtocol from "../../deploy/codex-egress-shim/egress-protocol.json";

// Independent oracle: the only origin the VPC transport may address, and the shim's
// accepted paths, written as literals rather than derived from adapter helpers.
const VPC_ORIGIN = "http://codex-egress.internal";
const PUBLIC_ORIGIN = "https://codex-egress-us-west1-a.trustedtunnel.app";

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
    CODEX_EGRESS_TRANSPORT: "vpc",
    CODEX_EGRESS_BASE_URL: PUBLIC_ORIGIN,
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
    const vpcEnv = env({ CODEX_EGRESS: binding });

    await forwardModels(new Request("https://relay.test/v1/models?client_version=0.99.0&x=a%2Fb"), vpcEnv, deps(globalFetch), token());
    await fetchCodexAccountResource(vpcEnv, deps(globalFetch), token(), "/account/usage");
    await forwardResponses(
      new Request("https://relay.test/v1/responses", { method: "POST" }),
      vpcEnv, deps(globalFetch), requestContext(), token(), bodyStream()
    );
    await forwardCodexChatGptBackend(
      new Request("https://relay.test/backend-api/transcribe", { method: "POST" }),
      vpcEnv, deps(globalFetch), requestContext(), token(), "/transcribe", bodyStream()
    );

    expect(globalFetch).not.toHaveBeenCalled();
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

  it("attaches the same credentials, manifest and secret as the public transport", async () => {
    const { binding, calls } = recordingBinding();
    const publicFetch = vi.fn(async () => new Response("{}", { status: 200 }));
    const request = () => new Request("https://relay.test/v1/models", {
      headers: { Originator: "codex-cli", "X-Future-Codex-Header": "keep", "CF-Connecting-IP": "203.0.113.9" }
    });

    await forwardModels(request(), env({ CODEX_EGRESS: binding }), deps(vi.fn()), token());
    await forwardModels(request(), env({ CODEX_EGRESS_TRANSPORT: "public" }), deps(publicFetch), token());

    const vpcHeaders = new Headers(calls[0].init.headers);
    const [publicUrl, publicInit] = publicFetch.mock.calls[0] as unknown as [string, RequestInit];
    const publicHeaders = new Headers(publicInit.headers);
    expect(publicUrl).toBe(`${PUBLIC_ORIGIN}/models`);

    const comparable = (headers: Headers) => [...headers.entries()]
      .filter(([name]) => name !== egressProtocol.transportTrace.header)
      .sort(([a], [b]) => a.localeCompare(b));
    expect(comparable(vpcHeaders)).toEqual(comparable(publicHeaders));
    expect(vpcHeaders.get(egressProtocol.secretHeader)).toBe("egress-secret");
    expect(vpcHeaders.get("authorization")).toBe("Bearer codex_access");
    expect(vpcHeaders.get("cf-connecting-ip")).toBeNull();
    expect(JSON.parse(vpcHeaders.get(egressProtocol.manifestHeader) ?? "[]")).toContain("x-future-codex-header");
  });

  it("fails closed before any credential exists when the binding is missing", async () => {
    const globalFetch = vi.fn();
    for (const missing of [undefined, null, {}, { fetch: "not-a-function" }]) {
      await expect(forwardModels(
        new Request("https://relay.test/v1/models"),
        env({ CODEX_EGRESS: missing }),
        deps(globalFetch),
        token()
      )).rejects.toMatchObject({ status: 500, code: "missing_codex_egress_binding" });
    }
    // No fallback: the public origin is configured and still never used.
    expect(globalFetch).not.toHaveBeenCalled();
  });

  it.each(["", "  ", "VPC", "auto", "public,vpc"])("rejects transport selector %j instead of defaulting", async (selector) => {
    const { binding } = recordingBinding();
    const globalFetch = vi.fn();
    await expect(forwardModels(
      new Request("https://relay.test/v1/models"),
      env({ CODEX_EGRESS_TRANSPORT: selector, CODEX_EGRESS: binding }),
      deps(globalFetch),
      token()
    )).rejects.toMatchObject({ status: 500, code: "invalid_codex_egress_transport" });
    expect(binding.fetch).not.toHaveBeenCalled();
    expect(globalFetch).not.toHaveBeenCalled();
  });

  it("keeps the public transport off the binding and still rejects an unapproved origin", async () => {
    const { binding } = recordingBinding();
    const globalFetch = vi.fn();
    await expect(forwardModels(
      new Request("https://relay.test/v1/models"),
      env({ CODEX_EGRESS_TRANSPORT: "public", CODEX_EGRESS_BASE_URL: "https://attacker.example", CODEX_EGRESS: binding }),
      deps(globalFetch),
      token()
    )).rejects.toMatchObject({ status: 500, code: "invalid_codex_egress_base_url" });
    expect(binding.fetch).not.toHaveBeenCalled();
    expect(globalFetch).not.toHaveBeenCalled();
  });

  it("passes the request body stream and client abort signal through unbuffered", async () => {
    const { binding, calls } = recordingBinding();
    const controller = new AbortController();
    const request = new Request("https://relay.test/v1/responses", { method: "POST", signal: controller.signal });
    const body = bodyStream();

    await forwardResponses(request, env({ CODEX_EGRESS: binding }), deps(vi.fn()), requestContext(), token(), body);

    expect(calls[0].init.body).toBe(body);
    expect(calls[0].init.signal).toBe(request.signal);
  });

  it("maps a client abort during the binding call to 499", async () => {
    const controller = new AbortController();
    const binding = {
      fetch: vi.fn(async () => {
        controller.abort();
        throw new DOMException("aborted", "AbortError");
      })
    };
    await expect(forwardResponses(
      new Request("https://relay.test/v1/responses", { method: "POST", signal: controller.signal }),
      env({ CODEX_EGRESS: binding }), deps(vi.fn()), requestContext(), token(), bodyStream()
    )).rejects.toMatchObject({ status: 499, code: "client_request_aborted" });
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

  it("still rejects redirects returned through the binding", async () => {
    const { binding } = recordingBinding(() => new Response(null, { status: 302, headers: { Location: "https://elsewhere.test" } }));
    await expect(fetchCodexAccountResource(env({ CODEX_EGRESS: binding }), deps(vi.fn()), token(), "/account/profile"))
      .rejects.toMatchObject({ status: 502, code: "upstream_redirect_rejected" });
  });
});

describe("Codex egress readiness", () => {
  const binding = { fetch: () => Promise.reject(new Error("unused")) };

  it.each([
    [{ CODEX_EGRESS: binding }, { transport: "vpc", status: "configured" }],
    [{ CODEX_EGRESS: undefined }, { transport: "vpc", status: "missing" }],
    [{ CODEX_EGRESS: binding, CODEX_EGRESS_SECRET: "" }, { transport: "vpc", status: "missing" }],
    [{ CODEX_EGRESS_TRANSPORT: "public" }, { transport: "public", status: "configured" }],
    [{ CODEX_EGRESS_TRANSPORT: "public", CODEX_EGRESS_BASE_URL: "https://attacker.example" }, { transport: "public", status: "invalid" }],
    [{ CODEX_EGRESS_TRANSPORT: "public", CODEX_EGRESS_BASE_URL: "" }, { transport: "public", status: "missing" }],
    [{ CODEX_EGRESS_TRANSPORT: "auto" }, { transport: null, status: "invalid" }],
    [{ CODEX_EGRESS_TRANSPORT: "" }, { transport: null, status: "missing" }]
  ])("reports %j as %j without performing a request", (overrides, expected) => {
    expect(codexEgressReadiness(env(overrides as EnvOverrides))).toEqual(expected);
  });
});
