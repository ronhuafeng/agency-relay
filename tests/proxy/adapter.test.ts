import { Buffer } from "node:buffer";
import { describe, expect, it, vi } from "vitest";
import {
  forwardTransparentProxy,
  forwardTransparentWebSocket,
  type ProxyUpstreamCredentials
} from "../../src/proxy/adapter";
import type { AppDependencies } from "../../src/types";
import { TEST_IDENTITY_VERSION } from "../support/identity-version";

const credentials: ProxyUpstreamCredentials = {
  baseUrl: "https://cli-chat-proxy.grok.com",
  accessToken: "provider-grok-secret",
  authStyle: "bearer",
  upstreamClientIdentity: "none",
  fallbackIdentityVersion: null
};

describe("Native Provider Execution adapter", () => {
  it("projects one Grok fallback bundle after caller credential isolation", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      expect(headers.get("Authorization")).toBe("Bearer provider-grok-secret");
      expect(headers.get("x-grok-client-version")).toBe(TEST_IDENTITY_VERSION);
      expect(headers.get("x-grok-client-identifier")).toBe("grok-shell");
      expect(headers.get("x-grok-client-mode")).toBe("headless");
      expect(headers.get("User-Agent")).toBe(`grok-shell/${TEST_IDENTITY_VERSION} (linux; x86_64)`);
      expect(headers.get("x-xai-token-auth")).toBe("xai-grok-cli");
      return new Response("ok");
    });
    const body = new Uint8Array([1]);
    await forwardTransparentProxy(
      new Request("https://grok.trustedtunnel.app/v1/responses", {
        method: "POST",
        headers: {
          Authorization: "Bearer caller-secret",
          "x-grok-client-version": "1.0.11",
          "x-grok-client-identifier": "partial",
          "User-Agent": "third-party/9.0.0"
        },
        body
      }),
      dependencies(fetchMock),
      {
        ...credentials,
        upstreamClientIdentity: "grok_build",
        fallbackIdentityVersion: TEST_IDENTITY_VERSION,
        extraHeaders: [["x-xai-token-auth", "xai-grok-cli"]]
      },
      bodyStream(body)
    );
  });

  it("relays WebSocket frames opaquely while replacing handshake credentials", async () => {
    const controller = new AbortController();
    const upstreamSocket = new FakeWebSocket();
    const downstreamClient = new FakeWebSocket();
    const downstreamServer = new FakeWebSocket();
    const completion = vi.fn();
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe("https://cli-chat-proxy.grok.com/v1/realtime?model=grok-voice");
      expect(init?.method).toBe("GET");
      expect(init?.redirect).toBe("manual");
      const headers = new Headers(init?.headers);
      expect(headers.get("Authorization")).toBe("Bearer provider-grok-secret");
      expect(headers.get("Upgrade")).toBe("websocket");
      expect(headers.get("x-safe-client-header")).toBe("preserve");
      for (const removed of [
        "x-api-key",
        "x-xai-token-auth",
        "cookie",
        "sec-websocket-key",
        "sec-websocket-version",
        "sec-websocket-extensions",
        "sec-websocket-protocol"
      ]) {
        expect(headers.get(removed)).toBeNull();
      }
      return {
        status: 101,
        statusText: "Switching Protocols",
        headers: new Headers({
          "Sec-WebSocket-Accept": "upstream-key-specific-value",
          "Sec-WebSocket-Extensions": "permessage-deflate",
          "Sec-WebSocket-Protocol": "upstream-protocol",
          "x-provider-request-id": "preserve"
        }),
        body: null,
        webSocket: upstreamSocket
      } as unknown as Response;
    });
    const clientResponse = Object.assign(new Response(null), {
      webSocket: downstreamClient
    });

    const response = await forwardTransparentWebSocket(
      new Request("https://xai.trustedtunnel.app/v1/realtime?model=grok-voice", {
        headers: {
          Authorization: "Bearer caller-secret",
          Upgrade: "websocket",
          Connection: "Upgrade",
          Cookie: "caller-cookie",
          "x-api-key": "caller-secret",
          "x-xai-token-auth": "caller-secret",
          "Sec-WebSocket-Key": "caller-key",
          "Sec-WebSocket-Version": "13",
          "Sec-WebSocket-Extensions": "permessage-deflate",
          "Sec-WebSocket-Protocol": "xai-client-secret.caller-secret",
          "x-safe-client-header": "preserve"
        },
        signal: controller.signal
      }),
      dependencies(fetchMock),
      credentials,
      {
        runtime: {
          createPair: () => ({
            0: downstreamClient as unknown as WebSocket,
            1: downstreamServer as unknown as WebSocket
          }),
          createResponse: (_client, headers) => {
            expect(headers.get("Sec-WebSocket-Accept")).toBeNull();
            expect(headers.get("Sec-WebSocket-Extensions")).toBeNull();
            expect(headers.get("Sec-WebSocket-Protocol")).toBeNull();
            expect(headers.get("x-provider-request-id")).toBe("preserve");
            return clientResponse;
          }
        },
        onResponseBodyDone: completion
      }
    );

    expect(response).toBe(clientResponse);
    expect(upstreamSocket.acceptOptions).toEqual({ allowHalfOpen: true });
    expect(downstreamServer.acceptOptions).toEqual({ allowHalfOpen: true });
    expect(completion).toHaveBeenCalledWith({ kind: "completed", upstreamStatus: 101 });

    downstreamServer.emitMessage("client-frame");
    upstreamSocket.emitMessage(new Uint8Array([1, 2, 3]));
    expect(upstreamSocket.sent).toEqual(["client-frame"]);
    expect(downstreamServer.sent).toEqual([new Uint8Array([1, 2, 3])]);

    controller.abort();
    expect(upstreamSocket.closes[0]).toEqual([1001, "Client request aborted"]);
    expect(downstreamServer.closes[0]).toEqual([1001, "Client request aborted"]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects WebSocket redirects before creating a relay", async () => {
    const fetchMock = vi.fn(async () => new Response(null, {
      status: 307,
      headers: { Location: "https://attacker.example/socket" }
    }));
    await expect(forwardTransparentWebSocket(
      new Request("https://xai.trustedtunnel.app/v1/responses", {
        headers: { Upgrade: "websocket" }
      }),
      dependencies(fetchMock),
      credentials
    )).rejects.toMatchObject({
      status: 502,
      code: "upstream_redirect_rejected",
      upstreamStatus: 307
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("preserves raw URL, request bytes, and safe future headers while replacing all credentials", async () => {
    const body = new Uint8Array([0x7b, 0x20, 0xff, 0x00, 0x7d]);
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe(
        "https://cli-chat-proxy.grok.com/v1/responses?beta=a&beta=b&raw=%2f%2F+"
      );
      expect(init?.method).toBe("POST");
      expect(init?.redirect).toBe("manual");
      expect(init?.signal).toBeDefined();
      await expect(new Response(init?.body).arrayBuffer())
        .resolves.toEqual(body.buffer);
      const headers = new Headers(init?.headers);
      expect(headers.get("Authorization")).toBe("Bearer provider-grok-secret");
      expect(headers.get("CF-Access-Client-Id")).toBeNull();
      expect(headers.get("CF-Access-Client-Secret")).toBeNull();
      for (const removed of [
        "x-api-key",
        "api-key",
        "x-goog-api-key",
        "proxy-authorization",
        "x-subscription-token",
        "x-xai-token-auth",
        "cookie",
        "host",
        "content-length",
        "keep-alive",
        "proxy-connection",
        "proxy-authenticate",
        "te",
        "trailer",
        "transfer-encoding",
        "upgrade",
        "x-hop",
        "cf-connecting-ip",
        "forwarded",
        "x-forwarded-for",
        "x-real-ip",
        "true-client-ip",
        "via",
        "x-mini-route-policy-trace-id",
        "x-codex-egress-secret",
        "chatgpt-account-id"
      ]) {
        expect(headers.get(removed)).toBeNull();
      }
      expect(headers.get("x-custom-future")).toBe("preserve");
      expect(headers.get("x-grok-client")).toBe("preserve");
      return new Response("ok");
    });

    const response = await forwardTransparentProxy(new Request(
      "https://grok.trustedtunnel.app/v1/responses?beta=a&beta=b&raw=%2f%2F+",
      {
        method: "POST",
        headers: {
          Authorization: "Bearer caller-secret",
          "x-api-key": "caller-secret",
          "api-key": "other-secret",
          "x-goog-api-key": "other-secret",
          "Proxy-Authorization": "Basic secret",
          "x-subscription-token": "other-secret",
          "x-xai-token-auth": "other-secret",
          Cookie: "secret=value",
          Host: "forged.example",
          "Content-Length": "999",
          Connection: "keep-alive, X-Hop",
          "Keep-Alive": "timeout=5",
          "Proxy-Connection": "keep-alive",
          "Proxy-Authenticate": "Basic secret",
          TE: "trailers",
          Trailer: "X-Checksum",
          "Transfer-Encoding": "chunked",
          Upgrade: "websocket",
          "X-Hop": "hop-secret",
          "CF-Connecting-IP": "192.0.2.1",
          Forwarded: "for=192.0.2.1",
          "X-Forwarded-For": "192.0.2.1",
          "X-Real-IP": "192.0.2.1",
          "True-Client-IP": "192.0.2.1",
          Via: "proxy",
          "X-Mini-Route-Policy-Trace-Id": "forged",
          "X-Codex-Egress-Secret": "forged",
          "Chatgpt-Account-Id": "forged",
          "x-client-version": "future-version",
          "x-client-beta": "future-beta",
          "x-grok-client": "preserve",
          "x-openai-client": "preserve",
          "x-custom-future": "preserve"
        },
        body
      }
    ), dependencies(fetchMock), credentials, bodyStream(body));

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("preserves accepted response status, bytes, and open headers", async () => {
    const encoded = new Uint8Array([0x1f, 0x8b, 0x08, 0x00, 0xff]);
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const requestHeaders = new Headers(init?.headers);
      expect(requestHeaders.get("x-client-version")).toBeNull();
      expect(requestHeaders.get("x-client-beta")).toBeNull();
      return new Response(bodyStream(encoded), {
      status: 529,
      statusText: "Overloaded",
      headers: {
        "Content-Type": "application/json",
        "Content-Encoding": "gzip",
        "request-id": "upstream-request-id",
        "Retry-After": "3",
        "X-Future-Grok": "preserve",
        Authorization: "secret",
        "Proxy-Authenticate": "Basic secret",
        "Set-Cookie": "secret=value",
        "Content-Length": "999",
        "CF-Ray": "secret-internal",
        "CF-Access-Client-Id": "secret-internal",
        "CF-Access-Client-Secret": "secret-internal",
        "X-Mini-Future": "secret-internal",
        "X-Mini-Header-Manifest": "[\"secret\"]",
        "X-Mini-Transport-Trace-Id": "secret-internal",
        "X-Codex-Egress-Secret": "secret-internal",
        "Chatgpt-Account-Id": "secret-internal",
        Via: "secret-internal",
        Connection: "keep-alive, X-Hop",
        "X-Hop": "secret-internal"
      }
      });
    });

    const response = await forwardTransparentProxy(
      new Request("https://grok.trustedtunnel.app/v1/models"),
      dependencies(fetchMock),
      credentials
    );

    expect(response.status).toBe(529);
    expect(response.statusText).toBe("Overloaded");
    expect(response.headers.get("Content-Encoding")).toBe("gzip");
    expect(response.headers.get("request-id")).toBe("upstream-request-id");
    expect(response.headers.get("Retry-After")).toBe("3");
    expect(response.headers.get("X-Future-Grok")).toBe("preserve");
    expect(response.headers.get("Authorization")).toBeNull();
    expect(response.headers.get("Proxy-Authenticate")).toBeNull();
    expect(response.headers.get("Set-Cookie")).toBeNull();
    expect(response.headers.get("Content-Length")).toBeNull();
    expect(response.headers.get("CF-Ray")).toBeNull();
    expect(response.headers.get("CF-Access-Client-Id")).toBeNull();
    expect(response.headers.get("CF-Access-Client-Secret")).toBeNull();
    expect(response.headers.get("X-Mini-Future")).toBeNull();
    expect(response.headers.get("X-Mini-Header-Manifest")).toBeNull();
    expect(response.headers.get("X-Mini-Transport-Trace-Id")).toBeNull();
    expect(response.headers.get("X-Codex-Egress-Secret")).toBeNull();
    expect(response.headers.get("Chatgpt-Account-Id")).toBeNull();
    expect(response.headers.get("Via")).toBeNull();
    expect(response.headers.get("X-Hop")).toBeNull();
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(encoded);
  });

  it("completes a missing SSE Content-Type only for an opted-in successful response", async () => {
    const bytes = new TextEncoder().encode(
      "event: response.completed\n"
      + "data: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_sse\",\"model\":\"grok-4.5\",\"usage\":{\"input_tokens\":2,\"output_tokens\":3,\"total_tokens\":5}}}\n\n"
    );
    const outcomes: import("../../src/proxy/adapter").ProxyResponseBodyOutcome[] = [];
    const fetchMock = vi.fn(async () => new Response(bodyStream(bytes), { status: 200 }));
    const response = await forwardTransparentProxy(
      new Request("https://grok.trustedtunnel.app/v1/responses", {
        method: "POST",
        headers: { Accept: "text/event-stream" },
        body: "{}"
      }),
      dependencies(fetchMock),
      credentials,
      bodyStream(new TextEncoder().encode("{}")),
      {
        completeMissingSseContentType: true,
        observeUsage: true,
        onResponseBodyDone: (outcome) => { outcomes.push(outcome); }
      }
    );

    expect(response.headers.get("Content-Type")).toBe("text/event-stream");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
    await vi.waitFor(() => {
      expect(outcomes).toEqual([expect.objectContaining({
        kind: "completed",
        usage: expect.objectContaining({ model: "grok-4.5" }),
        observation: expect.objectContaining({ transport: "http_sse", usage_captured: true })
      })]);
    });
  });

  it.each([
    { name: "policy absent", status: 200, accept: "text/event-stream", enabled: false },
    { name: "provider rejection", status: 422, accept: "text/event-stream", enabled: true },
    { name: "non-exact Accept", status: 200, accept: "text/event-stream, application/json", enabled: true }
  ])("does not complete Content-Type when $name", async ({ status, accept, enabled }) => {
    const fetchMock = vi.fn(async () => new Response(bodyStream(new Uint8Array([1])), { status }));
    const response = await forwardTransparentProxy(
      new Request("https://grok.trustedtunnel.app/v1/responses", {
        method: "POST",
        headers: { Accept: accept },
        body: "{}"
      }),
      dependencies(fetchMock),
      credentials,
      bodyStream(new TextEncoder().encode("{}")),
      enabled ? { completeMissingSseContentType: true } : {}
    );

    expect(response.headers.get("Content-Type")).toBeNull();
    await response.arrayBuffer();
  });

  it("preserves an existing Provider Content-Type when SSE completion is enabled", async () => {
    const fetchMock = vi.fn(async () => new Response(bodyStream(new Uint8Array([1])), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    }));
    const response = await forwardTransparentProxy(
      new Request("https://xai.trustedtunnel.app/v1/responses", {
        method: "POST",
        headers: { Accept: "text/event-stream" },
        body: "{}"
      }),
      dependencies(fetchMock),
      credentials,
      bodyStream(new TextEncoder().encode("{}")),
      { completeMissingSseContentType: true }
    );

    expect(response.headers.get("Content-Type")).toBe("application/json");
    await response.arrayBuffer();
  });

  it.each([
    { name: "same-host", status: 307, location: "https://cli-chat-proxy.grok.com/other" },
    { name: "cross-host", status: 301, location: "https://attacker.example/steal" }
  ])("rejects $name redirects without exposing their target or body", async ({ status, location }) => {
    let bodyCancelled = false;
    const redirectBody = new ReadableStream<Uint8Array>({
      cancel() {
        bodyCancelled = true;
      }
    });
    const fetchMock = vi.fn(async () => new Response(redirectBody, {
      status,
      headers: { Location: location }
    }));

    await expect(forwardTransparentProxy(
      new Request("https://grok.trustedtunnel.app/v1/models"),
      dependencies(fetchMock),
      credentials
    )).rejects.toMatchObject({
      status: 502,
      code: "upstream_redirect_rejected",
      upstreamStatus: status
    });
    expect(bodyCancelled).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    "not-a-url",
    "http://provider.example.test",
    "https://user:password@provider.example.test",
    "https://provider.example.test/base",
    "https://provider.example.test?secret=query"
  ])("classifies malformed base URL %s as configuration failure before fetch", async (baseUrl) => {
    const fetchMock = vi.fn();

    await expect(forwardTransparentProxy(
      new Request("https://grok.trustedtunnel.app/v1/models"),
      dependencies(fetchMock),
      { ...credentials, baseUrl }
    )).rejects.toMatchObject({
      status: 500,
      code: "invalid_provider_base_url",
      attempted: false
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("stays lazy and classifies response-body cancellation after headers", async () => {
    const chunk = new TextEncoder().encode("event: message_start\n\n");
    let upstreamPulls = 0;
    let upstreamCancelled = false;
    const outcomes: Array<{ kind: string; upstreamStatus: number }> = [];
    const upstreamBody = new ReadableStream<Uint8Array>({
      pull(controller) {
        upstreamPulls += 1;
        controller.enqueue(chunk);
      },
      cancel() {
        upstreamCancelled = true;
      }
    }, { highWaterMark: 0 });
    const fetchMock = vi.fn(async () => new Response(upstreamBody, { status: 200 }));

    const response = await forwardTransparentProxy(
      new Request("https://grok.trustedtunnel.app/v1/responses", {
        method: "POST",
        body: "{}"
      }),
      dependencies(fetchMock),
      credentials,
      bodyStream(new TextEncoder().encode("{}")),
      { onResponseBodyDone: (outcome) => { outcomes.push(outcome); } }
    );

    expect(upstreamPulls).toBe(0);
    const reader = response.body!.getReader();
    const first = await reader.read();
    expect(first.value).toEqual(chunk);
    expect(upstreamPulls).toBe(1);
    expect(outcomes).toHaveLength(0);

    await reader.cancel("downstream disconnected");
    expect(upstreamCancelled).toBe(true);
    expect(outcomes).toEqual([{ kind: "cancelled", upstreamStatus: 200 }]);
  });

  it("propagates client cancellation to the only upstream attempt", async () => {
    const controller = new AbortController();
    let upstreamSignal: AbortSignal | null = null;
    const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      upstreamSignal = init?.signal ?? null;
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
        if (init?.signal?.aborted) reject(init.signal.reason);
      });
    });
    const pending = forwardTransparentProxy(
      new Request("https://grok.trustedtunnel.app/v1/responses", {
        method: "POST",
        signal: controller.signal,
        body: "{}"
      }),
      dependencies(fetchMock),
      credentials,
      bodyStream(new TextEncoder().encode("{}"))
    );

    controller.abort(new Error("client disconnected"));

    await expect(pending).rejects.toMatchObject({
      code: "client_request_aborted",
      upstreamStatus: null
    });
    expect(upstreamSignal).not.toBeNull();
    expect((upstreamSignal as unknown as AbortSignal).aborted).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects provider redirects with upstream_redirect_rejected", async () => {
    const fetchMock = vi.fn(async () => new Response(null, {
      status: 302,
      headers: { Location: "https://evil.example/x" }
    }));
    await expect(forwardTransparentProxy(
      new Request("https://grok.trustedtunnel.app/v1/responses", { method: "POST", body: "{}" }),
      dependencies(fetchMock),
      credentials,
      bodyStream(new TextEncoder().encode("{}"))
    )).rejects.toMatchObject({
      status: 502,
      code: "upstream_redirect_rejected"
    });
  });

  it("observes synthetic JSON usage without altering client body bytes", async () => {
    const payload = JSON.stringify({
      id: "resp_test",
      object: "response",
      status: "completed",
      model: "grok-4.5",
      usage: {
        input_tokens: 3,
        output_tokens: 5,
        total_tokens: 8,
        input_tokens_details: { cached_tokens: 1 },
        output_tokens_details: { reasoning_tokens: 2 },
        cost_in_usd_ticks: 11344000
      }
    });
    const fetchMock = vi.fn(async () => new Response(payload, {
      status: 200,
      headers: { "Content-Type": "application/json" }
    }));
    let outcomeResolve!: (o: import("../../src/proxy/adapter").ProxyResponseBodyOutcome) => void;
    const outcomePromise = new Promise<import("../../src/proxy/adapter").ProxyResponseBodyOutcome>((resolve) => {
      outcomeResolve = resolve;
    });
    const response = await forwardTransparentProxy(
      new Request("https://grok.trustedtunnel.app/v1/responses", { method: "POST", body: "{}" }),
      dependencies(fetchMock),
      credentials,
      bodyStream(new TextEncoder().encode("{}")),
      {
        observeUsage: true,
        onResponseBodyDone: (o) => {
          outcomeResolve(o);
        }
      }
    );
    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe(payload);
    const outcome = await outcomePromise;
    expect(outcome.usage?.model).toBe("grok-4.5");
    expect(outcome.usage?.usage?.total_tokens).toBe(8);
    expect(outcome.usage?.usage?.provider_cost_usd_ticks).toBe(11344000);
  });

  it("reads upstream only when the client reads, even when usage observation is enabled", async () => {
    const chunk = new TextEncoder().encode("{\"ok\":true}");
    let pulls = 0;
    const upstream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        controller.enqueue(chunk);
        controller.close();
      }
    }, { highWaterMark: 0 });
    const fetchMock = vi.fn(async () => new Response(upstream, {
      status: 200,
      headers: { "Content-Type": "application/json" }
    }));
    const response = await forwardTransparentProxy(
      new Request("https://grok.trustedtunnel.app/v1/responses", { method: "POST", body: "{}" }),
      dependencies(fetchMock),
      credentials,
      bodyStream(new TextEncoder().encode("{}")),
      { observeUsage: true }
    );

    expect(pulls).toBe(0);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(chunk);
    expect(pulls).toBe(1);
  });

  it("does not pull upstream when the client never reads an observed response", async () => {
    let pulls = 0;
    const upstream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        controller.enqueue(new Uint8Array([1]));
      }
    }, { highWaterMark: 0 });
    const fetchMock = vi.fn(async () => new Response(upstream, { status: 200 }));
    await forwardTransparentProxy(
      new Request("https://grok.trustedtunnel.app/v1/responses", { method: "POST", body: "{}" }),
      dependencies(fetchMock),
      credentials,
      bodyStream(new TextEncoder().encode("{}")),
      { observeUsage: true }
    );
    await Promise.resolve();
    expect(pulls).toBe(0);
  });

  it("closes the client before a slow usage callback finishes", async () => {
    let release: (() => void) | undefined;
    let markEntered: (() => void) | undefined;
    const entered = new Promise<void>((resolve) => { markEntered = resolve; });
    const payload = new TextEncoder().encode("{\"usage\":{\"input_tokens\":1,\"output_tokens\":1,\"total_tokens\":2}}");
    const fetchMock = vi.fn(async () => new Response(payload, {
      status: 200,
      headers: { "Content-Type": "application/json" }
    }));
    const response = await forwardTransparentProxy(
      new Request("https://grok.trustedtunnel.app/v1/responses", { method: "POST", body: "{}" }),
      dependencies(fetchMock),
      credentials,
      bodyStream(new TextEncoder().encode("{}")),
      {
        observeUsage: true,
        onResponseBodyDone: () => {
          markEntered?.();
          return new Promise<void>((resolve) => { release = resolve; });
        }
      }
    );
    await expect(response.text()).resolves.toBe(new TextDecoder().decode(payload));
    await entered;
    release?.();
  });

  it("cancels upstream before a slow usage callback finishes", async () => {
    let upstreamCancelled = false;
    let release: (() => void) | undefined;
    const upstream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array([7]));
      },
      cancel() {
        upstreamCancelled = true;
      }
    }, { highWaterMark: 0 });
    const fetchMock = vi.fn(async () => new Response(upstream, { status: 200 }));
    const response = await forwardTransparentProxy(
      new Request("https://grok.trustedtunnel.app/v1/responses", { method: "POST", body: "{}" }),
      dependencies(fetchMock),
      credentials,
      bodyStream(new TextEncoder().encode("{}")),
      {
        observeUsage: true,
        onResponseBodyDone: () => new Promise<void>((resolve) => { release = resolve; })
      }
    );
    await response.body!.cancel("client closed");
    expect(upstreamCancelled).toBe(true);
    release?.();
  });

  it("keeps client bytes when observation exceeds its buffer", async () => {
    const chunk = new Uint8Array(1024 * 1024 + 1);
    const outcomes: Array<{ usage: unknown; code: string | null | undefined }> = [];
    const fetchMock = vi.fn(async () => new Response(chunk, {
      status: 200,
      headers: { "Content-Type": "application/json" }
    }));
    const response = await forwardTransparentProxy(
      new Request("https://grok.trustedtunnel.app/v1/responses", { method: "POST", body: "{}" }),
      dependencies(fetchMock),
      credentials,
      bodyStream(new TextEncoder().encode("{}")),
      {
        observeUsage: true,
        onResponseBodyDone: (outcome) => {
          outcomes.push({ usage: outcome.usage, code: outcome.observation?.observation_error_code });
        }
      }
    );
    expect(Buffer.from(await response.arrayBuffer()).equals(chunk)).toBe(true);
    await vi.waitFor(() => {
      expect(outcomes).toEqual([{ usage: null, code: "response_observation_limit" }]);
    });
  });
});

function dependencies(fetchImpl: typeof fetch): AppDependencies {
  return {
    fetch: fetchImpl,
    now: () => new Date("2026-07-23T00:00:00.000Z")
  };
}

function bodyStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    }
  });
}

class FakeWebSocket extends EventTarget {
  binaryType: "blob" | "arraybuffer" = "blob";
  readyState = 1;
  acceptOptions: WebSocketAcceptOptions | null = null;
  sent: Array<ArrayBuffer | ArrayBufferView | string> = [];
  closes: Array<[number | undefined, string | undefined]> = [];

  accept(options?: WebSocketAcceptOptions): void {
    this.acceptOptions = options ?? {};
  }

  send(message: ArrayBuffer | ArrayBufferView | string): void {
    this.sent.push(message);
  }

  close(code?: number, reason?: string): void {
    if (this.readyState === 3) {
      return;
    }
    this.closes.push([code, reason]);
    this.readyState = 3;
    const event = new Event("close");
    Object.defineProperties(event, {
      code: { value: code ?? 1000 },
      reason: { value: reason ?? "" }
    });
    this.dispatchEvent(event);
  }

  emitMessage(data: ArrayBuffer | ArrayBufferView | string): void {
    this.dispatchEvent(new MessageEvent("message", { data }));
  }
}
