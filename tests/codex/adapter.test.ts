import { describe, expect, it, vi } from "vitest";
import { brotliCompressSync, deflateSync, gzipSync } from "node:zlib";
import {
  fetchCodexAccountResource,
  forwardCompact,
  forwardModels,
  forwardResponses,
  type CodexProviderTerminalOutcome
} from "../../src/codex/adapter";
import { MAX_RESPONSE_OBSERVATION_LAG_BYTES } from "../../src/proxy/observation";
import type { AppDependencies, CapturedResponseUsage, FreshAccessToken, RequestContext } from "../../src/types";
import egressProtocol from "../../deploy/codex-egress-shim/egress-protocol.json";
import { REASONING_SUMMARY_SSE } from "../fixtures/codex-protocol";

const completedSse = "data: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_1\",\"object\":\"response\"}}\n\n";

function collectTerminal(
  captured?: CapturedResponseUsage[],
  observations?: Array<Record<string, unknown>>
): (outcome: CodexProviderTerminalOutcome) => void {
  return ({ usage, observation }) => {
    if (usage) {
      captured?.push(usage);
    }
    observations?.push(observation as unknown as Record<string, unknown>);
  };
}

describe("codex adapter", () => {
  it("projects one Codex fallback identity before signing the egress header manifest", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe(
        "https://codex-egress-us-west1-a.trustedtunnel.app/models?future=a%20b&client_version=1.2.3"
      );
      const headers = new Headers(init?.headers);
      expect(headers.get("Originator")).toBe("codex_cli_rs");
      expect(headers.get("User-Agent")).toBe(
        "codex_cli_rs/1.2.3 (Linux 6.6; x86_64) unknown"
      );
      expect(JSON.parse(headers.get(egressProtocol.manifestHeader) ?? "[]")).toEqual([
        "authorization",
        "chatgpt-account-id",
        "originator",
        "user-agent"
      ]);
      return new Response("{}", { headers: { "Content-Type": "application/json" } });
    });

    await forwardModels(new Request(
      "https://api.trustedtunnel.app/v1/models?client_version=broken&future=a%20b",
      { headers: { Originator: "codex_cli_rs", "User-Agent": "third-party/9.0.0" } }
    ), env(), deps(fetchMock), token(), {
      upstreamClientIdentity: "codex_cli",
      fallbackIdentityVersion: "1.2.3"
    });
  });

  it("transparently proxies models with owned auth and header isolation", async () => {
    const expected = new TextEncoder().encode('{"models":[{"slug":"future-model"}]}');
    const outcomes: CodexProviderTerminalOutcome[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe("https://codex-egress-us-west1-a.trustedtunnel.app/models?client_version=0.144.0%2Bdev&channel=future");
      expect(init?.method).toBe("GET");
      expect(init?.body).toBeUndefined();
      const headers = new Headers(init?.headers);
      expect(headers.get("Authorization")).toBe("Bearer codex_access");
      expect(headers.get("Chatgpt-Account-Id")).toBe("acct_1");
      expect(headers.get("X-Codex-Egress-Secret")).toBe("egress-secret");
      expect(headers.get(egressProtocol.transportTrace.header)).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      expect(headers.get(egressProtocol.transportTrace.header)).not.toBe("forged-transport-trace");
      expect(headers.get(egressProtocol.manifestHeader)).toBe(JSON.stringify([
        "authorization",
        "chatgpt-account-id",
        "originator",
        "x-future-codex-header"
      ]));
      expect(headers.get("Originator")).toBe("codex-cli");
      expect(headers.get("X-Future-Codex-Header")).toBe("preserve-me");
      expect(headers.get("Cookie")).toBeNull();
      expect(headers.get("CF-Connecting-IP")).toBeNull();
      expect(headers.get("X-Hop")).toBeNull();
      return new Response(stream(expected), {
        status: 203,
        statusText: "Non-Authoritative Information",
        headers: {
          "Content-Type": "application/json",
          ETag: '"upstream-etag"',
          "X-Future-Codex-Response": "preserve-me",
          "Set-Cookie": "backend-secret=value",
          Authorization: "Bearer backend-secret",
          "Chatgpt-Account-Id": "acct-internal",
          "X-Mini-Transport-Trace-Id": "forged-backend-transport-trace",
          Server: "internal-backend",
          "CF-Ray": "internal-ray"
        }
      });
    });
    const response = await forwardModels(new Request(
      "https://example.test/v1/models?client_version=0.144.0%2Bdev&channel=future",
      {
        headers: {
          Authorization: "Bearer end-user-key",
          Cookie: "local-cookie=value",
          Originator: "codex-cli",
          "X-Future-Codex-Header": "preserve-me",
          "CF-Connecting-IP": "127.0.0.1",
          Connection: "keep-alive, X-Hop",
          "X-Hop": "hop-local-value",
          "X-Codex-Egress-Secret": "forged-secret",
          "X-Mini-Header-Manifest": "[\"forged\"]",
          "X-Mini-Transport-Trace-Id": "forged-transport-trace"
        }
      }
    ), env({
      CODEX_EGRESS_BASE_URL: "https://codex-egress-us-west1-a.trustedtunnel.app",
      CODEX_EGRESS_SECRET: "egress-secret"
    }), deps(fetchMock), token(), {
      onTerminal: (outcome) => outcomes.push(outcome)
    });

    expect(response.status).toBe(203);
    expect(response.statusText).toBe("Non-Authoritative Information");
    expect(response.headers.get("ETag")).toBe('"upstream-etag"');
    expect(response.headers.get("X-Future-Codex-Response")).toBe("preserve-me");
    expect(response.headers.get("Set-Cookie")).toBeNull();
    expect(response.headers.get("Authorization")).toBeNull();
    expect(response.headers.get("Chatgpt-Account-Id")).toBeNull();
    expect(response.headers.get(egressProtocol.transportTrace.header)).toBeNull();
    expect(response.headers.get("Server")).toBe("internal-backend");
    expect(response.headers.get("CF-Ray")).toBe("internal-ray");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(expected);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(outcomes).toEqual([expect.objectContaining({
      attempted: true,
      requestStatus: "ok",
      providerResult: "accepted",
      upstreamStatus: 203,
      errorCode: null,
      usage: null
    })]);
  });

  it("rejects a models redirect without following or exposing its Location", async () => {
    let bodyCanceled = false;
    const outcomes: CodexProviderTerminalOutcome[] = [];
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.redirect).toBe("manual");
      return new Response(new ReadableStream({
        cancel() {
          bodyCanceled = true;
        }
      }), {
        status: 302,
        headers: { Location: "https://attacker.example/credential-capture" }
      });
    });

    await expect(forwardModels(
      new Request("https://example.test/v1/models"),
      env(),
      deps(fetchMock),
      token(),
      { onTerminal: (outcome) => outcomes.push(outcome) }
    )).rejects.toMatchObject({
      status: 502,
      code: "upstream_redirect_rejected",
      message: "Codex upstream redirect was rejected"
    });
    expect(bodyCanceled).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(outcomes).toEqual([expect.objectContaining({
      attempted: true,
      requestStatus: "error",
      providerResult: "rejected",
      upstreamStatus: 302,
      errorCode: "upstream_redirect_rejected"
    })]);
  });

  it("reports one models transport failure after the provider attempt starts", async () => {
    const outcomes: CodexProviderTerminalOutcome[] = [];
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      await expect(forwardModels(
        new Request("https://example.test/v1/models"),
        env(),
        deps(vi.fn(async () => { throw new Error("network failed"); })),
        token(),
        { onTerminal: (outcome) => outcomes.push(outcome) }
      )).rejects.toMatchObject({ code: "codex_upstream_transport_error" });
      expect(outcomes).toEqual([expect.objectContaining({
        attempted: true,
        requestStatus: "error",
        providerResult: "transport_error",
        upstreamStatus: null,
        errorCode: "codex_upstream_transport_error"
      })]);
    } finally {
      errorSpy.mockRestore();
    }
  });

  it.each(["responses", "compact"] as const)(
    "rejects a %s redirect without following or exposing its Location",
    async (route) => {
      let bodyCanceled = false;
      const observations: Record<string, unknown>[] = [];
      const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        expect(init?.redirect).toBe("manual");
        return new Response(new ReadableStream({
          cancel() {
            bodyCanceled = true;
          }
        }), {
          status: 307,
          headers: { Location: "https://attacker.example/credential-capture" }
        });
      });
      const forward = route === "responses" ? forwardResponses : forwardCompact;

      await expect(forward(
        new Request(
          "https://example.test/v1/responses" + (route === "compact" ? "/compact" : ""),
          { method: "POST" }
        ),
        env(),
        deps(fetchMock),
        requestContext(),
        token(),
        stream(new Uint8Array()),
        {
          onTerminal: collectTerminal(undefined, observations)
        }
      )).rejects.toMatchObject({
        status: 502,
        code: "upstream_redirect_rejected",
        message: "Codex upstream redirect was rejected"
      });
      expect(bodyCanceled).toBe(true);
      expect(observations).toEqual([expect.objectContaining({
        upstream_status: 307,
        observation_status: "skipped",
        observation_error_code: "response_observation_skipped",
        observation_stage: "upstream_fetch"
      })]);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    }
  );

  it("rejects an account resource redirect before exposing it to the dashboard", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.redirect).toBe("manual");
      return Response.redirect("https://attacker.example/account", 301);
    });

    await expect(fetchCodexAccountResource(
      env(),
      deps(fetchMock),
      token(),
      "/account/profile"
    )).rejects.toMatchObject({
      status: 502,
      code: "upstream_redirect_rejected"
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("forwards opaque Responses bytes and only caller-provided identity", async () => {
    const expected = new TextEncoder().encode('{ "stream": false, "future": true }');
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(new Uint8Array(await new Response(init?.body).arrayBuffer())).toEqual(expected);
      const headers = new Headers(init?.headers);
      expect(headers.get("session-id")).toBe("caller-session");
      expect(headers.get("thread-id")).toBeNull();
      expect(headers.get("x-codex-installation-id")).toBeNull();
      expect(headers.get("x-codex-window-id")).toBeNull();
      expect(headers.get("Originator")).toBeNull();
      expect(headers.get("User-Agent")).toBeNull();
      expect(headers.get("Authorization")).toBe("Bearer codex_access");
      expect(headers.get("Chatgpt-Account-Id")).toBe("acct_1");
      expect(headers.get(egressProtocol.transportTrace.header)).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      expect(headers.get(egressProtocol.manifestHeader)).toBe(JSON.stringify([
        "authorization",
        "chatgpt-account-id",
        "session-id"
      ]));
      return sseResponse(completedSse);
    });

    const response = await forwardResponses(new Request("https://example.test/v1/responses", {
      method: "POST",
      headers: { "session-id": "caller-session" }
    }), env(), deps(fetchMock), requestContext(), token(), stream(expected));

    await expect(response.text()).resolves.toBe(completedSse);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("drops a caller account when shared auth has no account id", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      expect(headers.get("Chatgpt-Account-Id")).toBeNull();
      expect(headers.get(egressProtocol.manifestHeader)).toBe(JSON.stringify(["authorization"]));
      return new Response("ok");
    });
    const freshToken = { ...token(), account_id: undefined };

    await forwardModels(
      new Request("https://example.test/v1/models", {
        headers: { "Chatgpt-Account-Id": "forged-client-account" }
      }),
      env(),
      deps(fetchMock),
      freshToken
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("requires the manifest egress path instead of falling back to Backend direct", async () => {
    const fetchMock = vi.fn();
    await expect(forwardModels(
      new Request("https://example.test/v1/models"),
      env({ CODEX_EGRESS_BASE_URL: "" }),
      deps(fetchMock),
      token()
    )).rejects.toMatchObject({ status: 500, code: "missing_codex_egress_base_url" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a non-approved egress origin before attaching credentials", async () => {
    const fetchMock = vi.fn();
    await expect(forwardModels(
      new Request("https://example.test/v1/models"),
      env({ CODEX_EGRESS_BASE_URL: "https://attacker.example", CODEX_EGRESS_SECRET: "egress-secret" }),
      deps(fetchMock),
      token()
    )).rejects.toMatchObject({ status: 500, code: "invalid_codex_egress_base_url" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("forwards compact request bytes without reconstruction", async () => {
    const expected = new TextEncoder().encode('{"unknown_compact_field":true}');
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(new Uint8Array(await new Response(init?.body).arrayBuffer())).toEqual(expected);
      expect(new Headers(init?.headers).get(egressProtocol.manifestHeader)).toBe(JSON.stringify([
        "authorization",
        "chatgpt-account-id"
      ]));
      expect(new Headers(init?.headers).get(egressProtocol.transportTrace.header)).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      return Response.json({ output: [] });
    });
    const response = await forwardCompact(
      new Request("https://example.test/v1/responses/compact", { method: "POST" }),
      env(),
      deps(fetchMock),
      requestContext(),
      token(),
      stream(expected)
    );
    await expect(response.json()).resolves.toEqual({ output: [] });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    {
      name: "regular SSE",
      compact: false,
      status: 200,
      statusText: "OK",
      contentType: "text/event-stream; charset=utf-8",
      contentEncoding: "identity",
      observedEncoding: "identity",
      transport: "http_sse",
      observationStatus: "error",
      observationCode: "response_observation_premature_eof",
      observationStage: "response_body",
      body: new TextEncoder().encode("event: future.event\ndata: not-json\n\n")
    },
    {
      name: "regular unary JSON",
      compact: false,
      status: 201,
      statusText: "Created",
      contentType: "application/problem+json",
      contentEncoding: "br",
      observedEncoding: "br",
      transport: "http_json",
      observationStatus: "error",
      observationCode: "response_observation_decompression_failed",
      observationStage: "response_decompression",
      body: new TextEncoder().encode('{ "future": true }')
    },
    {
      name: "regular unknown non-2xx",
      compact: false,
      status: 418,
      statusText: "Future Error",
      contentType: "application/x-future",
      contentEncoding: "gzip",
      observedEncoding: "gzip",
      transport: "http_other",
      observationStatus: "skipped",
      observationCode: "response_observation_skipped",
      observationStage: "response_body",
      body: new Uint8Array([0x00, 0xff, 0x17, 0x80])
    },
    {
      name: "compact opaque response",
      compact: true,
      status: 202,
      statusText: "Accepted",
      contentType: "application/octet-stream",
      contentEncoding: "future-codec",
      observedEncoding: "unsupported",
      transport: "http_other",
      observationStatus: "skipped",
      observationCode: "response_observation_skipped",
      observationStage: "response_body",
      body: new Uint8Array([0xfe, 0x01, 0x02, 0x03])
    }
  ])("preserves $name status headers and bytes independently of observation", async (scenario) => {
    const observations: Array<Record<string, unknown>> = [];
    const waits: Promise<unknown>[] = [];
    const captured: CapturedResponseUsage[] = [];
    const upstreamHeaders = new Headers({
      "Content-Type": scenario.contentType,
      "Content-Encoding": scenario.contentEncoding,
      "X-Future-Response": "preserve-me",
      Server: "backend-server",
      "CF-Ray": "backend-ray",
      "X-Powered-By": "backend-runtime",
      Authorization: "Bearer backend-secret",
      "Chatgpt-Account-Id": "backend-account",
      "Set-Cookie": "backend-cookie=value",
      [egressProtocol.secretHeader]: "backend-egress-secret",
      [egressProtocol.manifestHeader]: "[\"forged\"]",
      Connection: "X-Hop",
      "X-Hop": "hop-local"
    });
    const fetchMock = vi.fn(async () => new Response(stream(scenario.body), {
      status: scenario.status,
      statusText: scenario.statusText,
      headers: upstreamHeaders
    }));
    const options = {
      onTerminal: collectTerminal(captured, observations),
      waitUntil: (promise: Promise<void>) => waits.push(promise)
    };

    const response = scenario.compact
      ? await forwardCompact(request(), env(), deps(fetchMock), requestContext(), token(), stream(new Uint8Array()), options)
      : await forwardResponses(request(), env(), deps(fetchMock), requestContext(), token(), stream(new Uint8Array()), options);

    expect(response.status).toBe(scenario.status);
    expect(response.statusText).toBe(scenario.statusText);
    expect(response.headers.get("Content-Type")).toBe(scenario.contentType);
    expect(response.headers.get("Content-Encoding")).toBe(scenario.contentEncoding);
    expect(response.headers.get("X-Future-Response")).toBe("preserve-me");
    expect(response.headers.get("Server")).toBe("backend-server");
    expect(response.headers.get("CF-Ray")).toBe("backend-ray");
    expect(response.headers.get("X-Powered-By")).toBe("backend-runtime");
    expect(response.headers.get("Authorization")).toBeNull();
    expect(response.headers.get("Chatgpt-Account-Id")).toBeNull();
    expect(response.headers.get("Set-Cookie")).toBeNull();
    expect(response.headers.get(egressProtocol.secretHeader)).toBeNull();
    expect(response.headers.get(egressProtocol.manifestHeader)).toBeNull();
    expect(response.headers.get("Connection")).toBeNull();
    expect(response.headers.get("X-Hop")).toBeNull();
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(scenario.body);
    await Promise.all(waits);
    expect(captured).toEqual([]);
    expect(observations).toEqual([expect.objectContaining({
      observation_status: scenario.observationStatus,
      observation_error_code: scenario.observationCode,
      observation_stage: scenario.observationStage,
      content_encoding: scenario.observedEncoding,
      usage_captured: false,
      transport: scenario.transport,
      upstream_status: scenario.status
    })]);
    if (scenario.observedEncoding === "unsupported") {
      expect(JSON.stringify(observations)).not.toContain(scenario.contentEncoding);
    }
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("observes one completed usage while preserving the pinned Codex SSE bytes", async () => {
    const captured: CapturedResponseUsage[] = [];
    const observations: Array<Record<string, unknown>> = [];
    const waits: Promise<unknown>[] = [];
    const response = await forwardResponses(
      request(), env(), deps(vi.fn(async () => sseResponse(REASONING_SUMMARY_SSE))), requestContext(), token(),
      stream(new TextEncoder().encode('{"model":"gpt-5.4"}')),
      {
        onTerminal: collectTerminal(captured, observations),
        waitUntil: (promise) => waits.push(promise)
      }
    );

    await expect(response.text()).resolves.toBe(REASONING_SUMMARY_SSE);
    await Promise.all(waits);
    expect(captured).toEqual([{
      response_id: "resp_usage",
      model: "gpt-5.4",
      usage: {
        input_tokens: 10,
        cached_input_tokens: 4,
        output_tokens: 7,
        reasoning_tokens: 3,
        total_tokens: 17,
        provider_cost_usd_ticks: null
      }
    }]);
    expect(observations).toHaveLength(1);
    expect(observations[0]).toMatchObject({
      observation_status: "ok",
      observation_error_code: null,
      observation_stage: "response_body",
      terminal_event: "response.completed",
      usage_captured: true,
      upstream_status: 200,
      transport: "http_sse"
    });
  });

  it("preserves provider cost from a terminal SSE event without changing its bytes", async () => {
    const body = "event: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_metered\",\"object\":\"response\",\"status\":\"completed\",\"model\":\"grok-4.5\",\"usage\":{\"input_tokens\":2,\"output_tokens\":3,\"total_tokens\":5,\"cost_in_usd_ticks\":5944000}}}\n\n";
    const captured: CapturedResponseUsage[] = [];
    const waits: Promise<unknown>[] = [];
    const response = await forwardResponses(
      request(), env(), deps(vi.fn(async () => sseResponse(body))), requestContext(), token(),
      stream(new Uint8Array()),
      {
        onTerminal: collectTerminal(captured),
        waitUntil: (promise) => waits.push(promise)
      }
    );

    await expect(response.text()).resolves.toBe(body);
    await Promise.all(waits);
    expect(captured[0]?.usage).toMatchObject({
      total_tokens: 5,
      provider_cost_usd_ticks: 5944000
    });
  });

  it("does not parse named non-terminal SSE payloads before the terminal event", async () => {
    const body = [
      "event: response.created\ndata: not-json\n\n",
      "event: response.output_text.delta\ndata: also-not-json\n\n",
      completedSse
    ].join("");
    const observations: Array<Record<string, unknown>> = [];
    const waits: Promise<unknown>[] = [];
    const response = await forwardResponses(
      request(),
      env(),
      deps(vi.fn(async () => sseResponse(body))),
      requestContext(),
      token(),
      stream(new Uint8Array()),
      {
        onTerminal: collectTerminal(undefined, observations),
        waitUntil: (promise) => waits.push(promise)
      }
    );

    await expect(response.text()).resolves.toBe(body);
    await Promise.all(waits);
    expect(observations).toEqual([expect.objectContaining({
      observation_status: "ok",
      observation_error_code: null,
      terminal_event: "response.completed"
    })]);
  });

  it("uses the Codex SSE Accept signal for observation when Backend omits Content-Type", async () => {
    const captured: CapturedResponseUsage[] = [];
    const observations: Array<Record<string, unknown>> = [];
    const waits: Promise<unknown>[] = [];
    const incoming = new Request("https://example.test/v1/responses", {
      method: "POST",
      headers: { Accept: "text/event-stream" }
    });
    const response = await forwardResponses(
      incoming,
      env(),
      deps(vi.fn(async () => new Response(stream(new TextEncoder().encode(REASONING_SUMMARY_SSE))))),
      requestContext(),
      token(),
      stream(new TextEncoder().encode('{"model":"gpt-5.4","stream":true}')),
      {
        onTerminal: collectTerminal(captured, observations),
        waitUntil: (promise) => waits.push(promise)
      }
    );

    expect(response.headers.get("Content-Type")).toBe("text/event-stream");
    await expect(response.text()).resolves.toBe(REASONING_SUMMARY_SSE);
    await Promise.all(waits);
    expect(captured).toHaveLength(1);
    expect(captured[0]).toMatchObject({ response_id: "resp_usage", model: "gpt-5.4" });
    expect(observations).toEqual([expect.objectContaining({
      observation_status: "ok",
      terminal_event: "response.completed",
      usage_captured: true,
      transport: "http_sse"
    })]);
  });

  it("does not infer SSE from a missing Content-Type without the exact Codex Accept signal", async () => {
    const observations: Array<Record<string, unknown>> = [];
    const waits: Promise<unknown>[] = [];
    const captured: CapturedResponseUsage[] = [];
    const response = await forwardResponses(
      request(),
      env(),
      deps(vi.fn(async () => new Response(stream(new TextEncoder().encode(REASONING_SUMMARY_SSE))))),
      requestContext(),
      token(),
      stream(new TextEncoder().encode('{"model":"gpt-5.4","stream":true}')),
      {
        onTerminal: collectTerminal(captured, observations),
        waitUntil: (promise) => waits.push(promise)
      }
    );

    expect(response.headers.get("Content-Type")).toBeNull();
    await response.arrayBuffer();
    await Promise.all(waits);
    expect(captured).toEqual([]);
    expect(observations).toEqual([expect.objectContaining({
      observation_status: "skipped",
      usage_captured: false,
      transport: "http_other"
    })]);
  });

  it("does not synthesize an SSE Content-Type for a rejected Responses request", async () => {
    const incoming = new Request("https://example.test/v1/responses", {
      method: "POST",
      headers: { Accept: "text/event-stream" }
    });
    const response = await forwardResponses(
      incoming,
      env(),
      deps(vi.fn(async () => new Response(
        stream(new TextEncoder().encode("rejected")),
        { status: 422 }
      ))),
      requestContext(),
      token(),
      stream(new TextEncoder().encode('{"model":"gpt-5.4","stream":true}'))
    );

    expect(response.status).toBe(422);
    expect(response.headers.get("Content-Type")).toBeNull();
    await expect(response.text()).resolves.toBe("rejected");
  });

  it("does not apply the regular SSE observation signal to compact", async () => {
    const observations: Array<Record<string, unknown>> = [];
    const waits: Promise<unknown>[] = [];
    const captured: CapturedResponseUsage[] = [];
    const incoming = new Request("https://example.test/v1/responses/compact", {
      method: "POST",
      headers: { Accept: "text/event-stream" }
    });
    const response = await forwardCompact(
      incoming,
      env(),
      deps(vi.fn(async () => new Response(stream(new TextEncoder().encode(REASONING_SUMMARY_SSE))))),
      requestContext(),
      token(),
      stream(new TextEncoder().encode('{"model":"gpt-5.4","input":[]}')),
      {
        onTerminal: collectTerminal(captured, observations),
        waitUntil: (promise) => waits.push(promise)
      }
    );

    expect(response.headers.get("Content-Type")).toBeNull();
    await expect(response.text()).resolves.toBe(REASONING_SUMMARY_SSE);
    await Promise.all(waits);
    expect(captured).toEqual([]);
    expect(observations).toEqual([expect.objectContaining({
      observation_status: "skipped",
      usage_captured: false,
      transport: "http_other"
    })]);
  });

  it("observes unary response model and usage without changing its bytes", async () => {
    const body = '{ "id": "resp_unary", "object": "response", "status": "completed", "model": "gpt-5.5", "usage": { "input_tokens": 4, "output_tokens": 6, "total_tokens": 10 } }';
    const captured: CapturedResponseUsage[] = [];
    const observations: Array<Record<string, unknown>> = [];
    const waits: Promise<unknown>[] = [];
    const response = await forwardResponses(
      request(),
      env(),
      deps(vi.fn(async () => new Response(body, { headers: { "Content-Type": "application/json" } }))),
      requestContext(),
      token(),
      stream(new Uint8Array()),
      {
        onTerminal: collectTerminal(captured, observations),
        waitUntil: (promise) => waits.push(promise)
      }
    );

    await expect(response.text()).resolves.toBe(body);
    await Promise.all(waits);
    expect(captured).toEqual([{
      response_id: "resp_unary",
      model: "gpt-5.5",
      usage: {
        input_tokens: 4,
        cached_input_tokens: null,
        output_tokens: 6,
        reasoning_tokens: null,
        total_tokens: 10,
        provider_cost_usd_ticks: null
      }
    }]);
    expect(observations).toEqual([expect.objectContaining({
      observation_status: "ok",
      observation_error_code: null,
      terminal_event: "response.completed",
      usage_captured: true,
      transport: "http_json"
    })]);
  });

  it.each([
    { status: "failed", terminalEvent: "response.failed" },
    { status: "incomplete", terminalEvent: "response.incomplete" }
  ])("observes unary $status as $terminalEvent without changing its bytes", async ({ status, terminalEvent }) => {
    const body = JSON.stringify({ id: `resp_${status}`, object: "response", status, model: "gpt-5.5" });
    const observations: Array<Record<string, unknown>> = [];
    const waits: Promise<unknown>[] = [];
    const response = await forwardResponses(
      request(),
      env(),
      deps(vi.fn(async () => new Response(body, { headers: { "Content-Type": "application/json" } }))),
      requestContext(),
      token(),
      stream(new Uint8Array()),
      {
        onTerminal: collectTerminal(undefined, observations),
        waitUntil: (promise) => waits.push(promise)
      }
    );

    await expect(response.text()).resolves.toBe(body);
    await Promise.all(waits);
    expect(observations).toEqual([expect.objectContaining({
      observation_status: "ok",
      observation_error_code: null,
      terminal_event: terminalEvent,
      transport: "http_json"
    })]);
  });

  it.each([
    {
      encoding: "gzip" as const,
      contentType: "text/event-stream",
      compressed: new Uint8Array(gzipSync(REASONING_SUMMARY_SSE)),
      expectedModel: "gpt-5.4",
      expectedTotal: 17,
      expectedTerminal: "response.completed",
      expectedCost: null
    },
    {
      encoding: "deflate" as const,
      contentType: "application/json",
      compressed: new Uint8Array(deflateSync('{"id":"resp_deflate","object":"response","model":"gpt-5.5","usage":{"input_tokens":2,"output_tokens":3,"total_tokens":5,"cost_in_usd_ticks":11344000}}')),
      expectedModel: "gpt-5.5",
      expectedTotal: 5,
      expectedTerminal: "response.completed",
      expectedCost: 11344000
    },
    {
      encoding: "br" as const,
      contentType: "application/json",
      compressed: new Uint8Array(brotliCompressSync('{"id":"resp_br","object":"response","status":"completed","model":"gpt-5.6","usage":{"input_tokens":7,"output_tokens":8,"total_tokens":15}}')),
      expectedModel: "gpt-5.6",
      expectedTotal: 15,
      expectedTerminal: "response.completed",
      expectedCost: null
    }
  ])("observes $encoding response data without changing encoded client bytes", async (scenario) => {
    const captured: CapturedResponseUsage[] = [];
    const observations: Array<Record<string, unknown>> = [];
    const waits: Promise<unknown>[] = [];
    const response = await forwardResponses(
      request(),
      env(),
      deps(vi.fn(async () => new Response(stream(scenario.compressed), {
        headers: {
          "Content-Type": scenario.contentType,
          "Content-Encoding": scenario.encoding
        }
      }))),
      requestContext(),
      token(),
      stream(new Uint8Array()),
      {
        onTerminal: collectTerminal(captured, observations),
        waitUntil: (promise) => waits.push(promise)
      }
    );

    expect(response.headers.get("Content-Encoding")).toBe(scenario.encoding);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(scenario.compressed);
    await Promise.all(waits);
    expect(captured).toHaveLength(1);
    expect(captured[0]).toMatchObject({ model: scenario.expectedModel });
    expect(captured[0].usage?.total_tokens).toBe(scenario.expectedTotal);
    expect(captured[0].usage?.provider_cost_usd_ticks).toBe(scenario.expectedCost);
    expect(observations).toEqual([expect.objectContaining({
      observation_status: "ok",
      observation_error_code: null,
      terminal_event: scenario.expectedTerminal,
      content_encoding: scenario.encoding,
      usage_captured: true
    })]);
  });

  it.each([
    {
      name: "unsupported encoding",
      contentType: "application/json",
      contentEncoding: "future-secret-codec",
      body: new TextEncoder().encode('{"object":"response"}'),
      expectedEncoding: "unsupported",
      expectedCode: "response_observation_unsupported_encoding",
      expectedStage: "response_decompression"
    },
    {
      name: "damaged gzip",
      contentType: "text/event-stream",
      contentEncoding: "gzip",
      body: new Uint8Array([0x1f, 0x8b, 0x08, 0x00, 0xff]),
      expectedEncoding: "gzip",
      expectedCode: "response_observation_decompression_failed",
      expectedStage: "response_decompression"
    },
    {
      name: "malformed SSE event",
      contentType: "text/event-stream",
      contentEncoding: null,
      body: new TextEncoder().encode("event: response.completed\ndata: not-json\n\n"),
      expectedEncoding: null,
      expectedCode: "response_observation_parse_failed",
      expectedStage: "response_parse"
    },
    {
      name: "premature SSE EOF",
      contentType: "text/event-stream",
      contentEncoding: null,
      body: new TextEncoder().encode('event: response.created\ndata: {"type":"response.created"}\n\n'),
      expectedEncoding: null,
      expectedCode: "response_observation_premature_eof",
      expectedStage: "response_body"
    }
  ])("keeps client bytes intact when observation hits $name", async (scenario) => {
    const waits: Promise<unknown>[] = [];
    const observations: Array<Record<string, unknown>> = [];
    const headers = new Headers({ "Content-Type": scenario.contentType });
    if (scenario.contentEncoding) {
      headers.set("Content-Encoding", scenario.contentEncoding);
    }
    const response = await forwardResponses(
      request(),
      env(),
      deps(vi.fn(async () => new Response(stream(scenario.body), { headers }))),
      requestContext(),
      token(),
      stream(new Uint8Array()),
      {
        onTerminal: collectTerminal(undefined, observations),
        waitUntil: (promise) => waits.push(promise)
      }
    );

    expect(new Uint8Array(await response.arrayBuffer())).toEqual(scenario.body);
    await Promise.all(waits);
    expect(observations).toEqual([expect.objectContaining({
      observation_status: "error",
      observation_error_code: scenario.expectedCode,
      observation_stage: scenario.expectedStage,
      content_encoding: scenario.expectedEncoding,
      usage_captured: false
    })]);
    expect(JSON.stringify(observations)).not.toContain("future-secret-codec");
  });

  it("reports an empty JSON response as premature observation EOF without changing it", async () => {
    const observations: Array<Record<string, unknown>> = [];
    const response = await forwardResponses(
      request(),
      env(),
      deps(vi.fn(async () => new Response(null, {
        status: 204,
        headers: { "Content-Type": "application/json" }
      }))),
      requestContext(),
      token(),
      stream(new Uint8Array()),
      { onTerminal: collectTerminal(undefined, observations) }
    );

    expect(response.status).toBe(204);
    expect(response.body).toBeNull();
    expect(observations).toEqual([expect.objectContaining({
      observation_status: "error",
      observation_error_code: "response_observation_premature_eof",
      observation_stage: "response_body",
      transport: "http_json",
      usage_captured: false
    })]);
  });

  it("stops a lagging unary observer without truncating the client response", async () => {
    const body = new Uint8Array(MAX_RESPONSE_OBSERVATION_LAG_BYTES + 1).fill(0x20);
    const waits: Promise<unknown>[] = [];
    const observations: Array<Record<string, unknown>> = [];
    const response = await forwardResponses(
      request(),
      env(),
      deps(vi.fn(async () => new Response(stream(body), { headers: { "Content-Type": "application/json" } }))),
      requestContext(),
      token(),
      stream(new Uint8Array()),
      {
        onTerminal: collectTerminal(undefined, observations),
        waitUntil: (promise) => waits.push(promise)
      }
    );

    expect((await response.arrayBuffer()).byteLength).toBe(body.byteLength);
    await Promise.all(waits);
    expect(observations).toEqual([expect.objectContaining({
      observation_status: "error",
      observation_error_code: "response_observation_limit",
      observation_stage: "response_body",
      usage_captured: false
    })]);
  });

  it("forwards one upstream attempt for HTTP and transport errors", async () => {
    const unavailable = vi.fn(async () => Response.json({
      error: { message: "unavailable", type: "upstream_error", code: "unavailable" }
    }, { status: 503 }));
    const unavailableResponse = await forwardResponses(
      request(), env(), deps(unavailable), requestContext(), token(), stream(new Uint8Array())
    );
    expect(unavailableResponse.status).toBe(503);
    await expect(unavailableResponse.json()).resolves.toEqual({
      error: { message: "unavailable", type: "upstream_error", code: "unavailable" }
    });
    expect(unavailable).toHaveBeenCalledTimes(1);

    const transport = vi.fn(async () => { throw new Error("network reset"); });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      await expect(forwardResponses(
        request(), env(), deps(transport), requestContext(), token(), stream(new Uint8Array())
      )).rejects.toMatchObject({
        status: 502,
        code: "codex_upstream_transport_error",
        message: "Codex upstream request failed"
      });
      expect(errorSpy).toHaveBeenCalledWith(JSON.stringify({
        event: "codex_upstream_transport_error",
        error_name: "Error",
        error_message: "network reset",
        cause_name: null,
        cause_message: null
      }));
    } finally {
      errorSpy.mockRestore();
    }
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it("propagates client abort directly to the upstream fetch", async () => {
    const controller = new AbortController();
    let upstreamSignal: AbortSignal | null | undefined;
    let markFetchStarted: (() => void) | undefined;
    const fetchStarted = new Promise<void>((resolve) => { markFetchStarted = resolve; });
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      upstreamSignal = init?.signal;
      markFetchStarted?.();
      upstreamSignal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    }));
    const pending = forwardResponses(new Request("https://example.test/v1/responses", {
      method: "POST",
      signal: controller.signal
    }), env(), deps(fetchMock), requestContext(), token(), stream(new Uint8Array()));

    await fetchStarted;
    controller.abort();
    await expect(pending).rejects.toMatchObject({ status: 499, code: "client_request_aborted" });
    expect(upstreamSignal?.aborted).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("cancels an established upstream SSE body when downstream cancels", async () => {
    const upstreamCancel = vi.fn();
    const observations: Array<Record<string, unknown>> = [];
    const waits: Promise<unknown>[] = [];
    const response = await forwardResponses(
      request(),
      env(),
      deps(vi.fn(async () => new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("event: response.created\ndata: {}\n\n"));
        },
        cancel(reason) {
          upstreamCancel(reason);
        }
      }), { headers: { "Content-Type": "text/event-stream" } }))),
      requestContext(),
      token(),
      stream(new Uint8Array()),
      {
        onTerminal: collectTerminal(undefined, observations),
        waitUntil: (promise) => waits.push(promise)
      }
    );

    const reader = response.body!.getReader();
    await reader.read();
    await reader.cancel("downstream cancelled");
    await Promise.all(waits);
    expect(upstreamCancel).toHaveBeenCalledTimes(1);
    expect(observations).toEqual([expect.objectContaining({
      client_aborted: true,
      observation_status: "error",
      observation_error_code: "client_request_aborted",
      observation_stage: "response_body"
    })]);
  });

  it("does not let response observation drain upstream ahead of the client", async () => {
    let pulls = 0;
    const waits: Promise<unknown>[] = [];
    const chunks = [
      "event: response.created\ndata: {\"type\":\"response.created\"}\n\n",
      "event: response.output_text.delta\ndata: {\"type\":\"response.output_text.delta\",\"delta\":\"x\"}\n\n",
      "event: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_paced\"}}\n\n"
    ];
    const response = await forwardResponses(
      request(),
      env(),
      deps(vi.fn(async () => new Response(new ReadableStream<Uint8Array>({
        pull(controller) {
          if (pulls < chunks.length) {
            controller.enqueue(new TextEncoder().encode(chunks[pulls]));
            pulls += 1;
          } else {
            controller.close();
          }
        }
      }), { headers: { "Content-Type": "text/event-stream" } }))),
      requestContext(),
      token(),
      stream(new Uint8Array()),
      { waitUntil: (promise) => waits.push(promise) }
    );

    await Promise.resolve();
    await Promise.resolve();
    expect(pulls).toBeLessThan(chunks.length);
    await expect(response.text()).resolves.toBe(chunks.join(""));
    await Promise.all(waits);
    expect(pulls).toBe(chunks.length);
  });

  it("starts the observation waitUntil grace period only after the client stream ends", async () => {
    const waits: Promise<unknown>[] = [];
    const response = await forwardResponses(
      request(),
      env(),
      deps(vi.fn(async () => sseResponse(completedSse))),
      requestContext(),
      token(),
      stream(new Uint8Array()),
      { waitUntil: (promise) => waits.push(promise) }
    );

    expect(waits).toHaveLength(0);
    await expect(response.text()).resolves.toBe(completedSse);
    expect(waits).toHaveLength(1);
    await Promise.all(waits);
  });

  it("keeps a completed client stream intact when waitUntil registration fails", async () => {
    const response = await forwardResponses(
      request(),
      env(),
      deps(vi.fn(async () => sseResponse(completedSse))),
      requestContext(),
      token(),
      stream(new Uint8Array()),
      { waitUntil: () => { throw new Error("registration failed"); } }
    );

    await expect(response.text()).resolves.toBe(completedSse);
  });

  it("still cancels upstream when waitUntil registration fails during client cancellation", async () => {
    const upstreamCancel = vi.fn();
    const registerWaitUntil = vi.fn(() => { throw new Error("registration failed"); });
    const response = await forwardResponses(
      request(),
      env(),
      deps(vi.fn(async () => new Response(new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.enqueue(new TextEncoder().encode("data: partial\n\n"));
        },
        cancel: upstreamCancel
      }), { headers: { "Content-Type": "text/event-stream" } }))),
      requestContext(),
      token(),
      stream(new Uint8Array()),
      { waitUntil: registerWaitUntil }
    );

    const reader = response.body!.getReader();
    await reader.read();
    expect(registerWaitUntil).not.toHaveBeenCalled();
    await expect(reader.cancel("client closed")).resolves.toBeUndefined();
    expect(registerWaitUntil).toHaveBeenCalledTimes(1);
    expect(upstreamCancel).toHaveBeenCalledTimes(1);
  });

  it("records an upstream body read failure without misclassifying client cancellation", async () => {
    const waits: Promise<unknown>[] = [];
    const observations: Array<Record<string, unknown>> = [];
    const response = await forwardResponses(
      request(),
      env(),
      deps(vi.fn(async () => new Response(new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.error(new Error("upstream body failed"));
        }
      }), { headers: { "Content-Type": "text/event-stream" } }))),
      requestContext(),
      token(),
      stream(new Uint8Array()),
      {
        onTerminal: collectTerminal(undefined, observations),
        waitUntil: (promise) => waits.push(promise)
      }
    );

    await expect(response.text()).rejects.toThrow();
    expect(waits).toHaveLength(1);
    await Promise.all(waits);
    expect(observations).toEqual([expect.objectContaining({
      client_aborted: false,
      observation_status: "error",
      observation_error_code: "response_observation_read_failed",
      observation_stage: "response_body"
    })]);
  });

  it("preserves caller end-to-end headers without synthesizing User-Agent", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      expect(headers.get("X-Codex-Turn-State")).toBe("turn-state-in");
      expect(headers.get("OpenAI-Beta")).toBe("responses_websockets=2026-02-06");
      expect(headers.get("X-OpenAI-Subagent")).toBe("compact");
      expect(headers.get("User-Agent")).toBeNull();
      return new Response(completedSse, {
        headers: { "Content-Type": "text/event-stream", "X-Codex-Turn-State": "turn-state-out" }
      });
    });
    const response = await forwardResponses(new Request("https://example.test/v1/responses", {
      method: "POST",
      headers: {
        "X-Codex-Turn-State": "turn-state-in",
        "OpenAI-Beta": "responses_websockets=2026-02-06",
        "X-OpenAI-Subagent": "compact"
      }
    }), env(), deps(fetchMock), requestContext(), token(), stream(new Uint8Array()));
    expect(response.headers.get("X-Codex-Turn-State")).toBe("turn-state-out");
    await response.text();
  });

  it("routes once through configured egress", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe("https://codex-egress-us-west1-a.trustedtunnel.app/responses?future=%2f");
      const headers = new Headers(init?.headers);
      expect(headers.get("Authorization")).toBe("Bearer codex_access");
      expect(headers.get("X-Codex-Egress-Secret")).toBe("egress-secret");
      return sseResponse(completedSse);
    });
    const response = await forwardResponses(
      new Request("https://example.test/v1/responses?future=%2f", { method: "POST" }),
      env({ CODEX_EGRESS_BASE_URL: "https://codex-egress-us-west1-a.trustedtunnel.app", CODEX_EGRESS_SECRET: "egress-secret" }),
      deps(fetchMock),
      requestContext(),
      token(),
      stream(new Uint8Array())
    );
    await response.text();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

});

function request(): Request {
  return new Request("https://example.test/v1/responses", { method: "POST" });
}

function stream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      if (bytes.byteLength > 0) {
        controller.enqueue(bytes);
      }
      controller.close();
    }
  });
}

function requestContext(): RequestContext {
  return { requestId: "req_test", startedAt: Date.now() };
}

function token(): FreshAccessToken {
  return {
    access_token: "codex_access",
    account_id: "acct_1"
  };
}

function deps(fetchMock: AppDependencies["fetch"]): AppDependencies {
  return { fetch: fetchMock, now: () => new Date("2026-07-12T00:00:00.000Z") };
}

function env(overrides: Partial<Env> = {}): Env {
  return {
    CODEX_EGRESS_BASE_URL: "https://codex-egress-us-west1-a.trustedtunnel.app",
    CODEX_EGRESS_SECRET: "egress-secret",
    CODEX_OAUTH_TOKEN_URL: "https://auth.openai.test/oauth/token",
    CODEX_CLIENT_ID: "client",
    TOKEN_ENCRYPTION_KEY_V1: "secret",
    API_KEY_HASH_PEPPER: "pepper",
    ADMIN_SECRET: "admin",
    ADMIN_DASHBOARD_HOST: "admin.example.test",
    CONSOLE_EMAIL_DOMAIN: "example.com",
    FEISHU_APP_ID: "cli_test",
    FEISHU_APP_SECRET: "test-secret",
    REQUEST_AUDIT_RETENTION_DAYS: "30",
    DB: undefined as unknown as Env["DB"],
    TOKEN_AUTHORITY: undefined as unknown as Env["TOKEN_AUTHORITY"],
    ...overrides
  } as Env;
}

function sseResponse(body: string): Response {
  return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}
