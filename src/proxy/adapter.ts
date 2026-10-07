import { HttpError } from "../errors";
import type { UpstreamClientIdentity } from "../plans/execution-plans";
import { assertProviderBaseUrl } from "./origin";
import {
  MAX_RESPONSE_OBSERVATION_LAG_BYTES,
  observeCodexResponse,
  ResponseObservationError
} from "./observation";
import type { AppDependencies, CapturedResponseUsage, CodexTransportObservation } from "../types";
import { projectRequiredUpstreamClientIdentity } from "../plans/identity-version";

/** Mini-owned provider credentials (Grok opaque path). */
export interface ProxyUpstreamCredentials {
  baseUrl: string;
  accessToken: string;
  /** How to attach the access token on the provider request (Grok uses bearer). */
  authStyle: "bearer";
  /** Plan-selected Provider client identity; never used as authority. */
  upstreamClientIdentity: UpstreamClientIdentity;
  /** Null when the bundle is native or the plan selects none. Chosen before credit admission. */
  fallbackIdentityVersion: string | null;
  /** Mini-owned provider headers applied after the security denylist. */
  extraHeaders?: ReadonlyArray<readonly [string, string]>;
}

export interface ProxyResponseBodyOutcome {
  kind: "completed" | "cancelled" | "error";
  upstreamStatus: number;
  usage?: CapturedResponseUsage | null;
  observation?: CodexTransportObservation;
}

export interface ProxyForwardOptions {
  onResponseBodyDone?: (outcome: ProxyResponseBodyOutcome) => void | Promise<void>;
  /** Synchronous metadata observation on the client stream; must not retain chunks. */
  onResponseChunk?: (chunk: Uint8Array) => void;
  /** When true, non-interfering response observation runs. */
  observeUsage?: boolean;
  /** Complete only a missing Content-Type on a caller-declared successful SSE response. */
  completeMissingSseContentType?: boolean;
  now?: () => Date;
  waitUntil?: (promise: Promise<void>) => void;
}

interface ProxyWebSocketRuntime {
  createPair(): { 0: WebSocket; 1: WebSocket };
  createResponse(client: WebSocket, headers: Headers): Response;
}

export interface ProxyWebSocketForwardOptions extends ProxyForwardOptions {
  /** Test seam only; production uses the Workers WebSocketPair/101 response. */
  runtime?: ProxyWebSocketRuntime;
}

export class ProxyUpstreamError extends HttpError {
  readonly upstreamStatus: number | null;
  readonly attempted: boolean;

  constructor(
    status: number,
    message: string,
    code: string,
    upstreamStatus: number | null = null,
    attempted = true
  ) {
    super(status, message, "api_error", code);
    this.upstreamStatus = upstreamStatus;
    this.attempted = attempted;
  }
}

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-connection",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade"
]);

const REQUEST_HEADER_DENYLIST = new Set([
  ...HOP_BY_HOP_HEADERS,
  "authorization",
  "x-api-key",
  "api-key",
  "x-goog-api-key",
  "x-subscription-token",
  "x-xai-token-auth",
  "x-authenticateresponse",
  "x-grok-client-version",
  "x-grok-client-mode",
  "x-grok-client-identifier",
  "x-grok-deployment-id",
  "x-grok-user-id",
  "cookie",
  "host",
  "content-length",
  "forwarded",
  "x-real-ip",
  "true-client-ip",
  "via",
  "x-codex-egress-secret",
  "chatgpt-account-id",
  "cf-access-client-id",
  "cf-access-client-secret"
]);

const RESPONSE_HEADER_DENYLIST = new Set([
  ...HOP_BY_HOP_HEADERS,
  "authorization",
  "cookie",
  "set-cookie",
  "content-length",
  "via",
  "x-codex-egress-secret",
  "chatgpt-account-id",
  "cf-access-client-id",
  "cf-access-client-secret"
]);

const WEBSOCKET_REQUEST_HEADER_DENYLIST = new Set([
  ...REQUEST_HEADER_DENYLIST,
  "sec-websocket-key",
  "sec-websocket-version",
  "sec-websocket-extensions",
  // May carry an xAI ephemeral credential. Mini authenticates upstream with
  // its own slot bearer, so caller-provided subprotocol credentials are never
  // forwarded.
  "sec-websocket-protocol"
]);

const WEBSOCKET_RESPONSE_HEADER_DENYLIST = new Set([
  ...RESPONSE_HEADER_DENYLIST,
  // The Worker→provider and client→Worker handshakes have different keys and
  // negotiation state. Workers owns these fields on the returned 101.
  "sec-websocket-accept",
  "sec-websocket-extensions",
  "sec-websocket-protocol"
]);

/**
 * Opaque single-pass forward to a Mini-owned provider origin (Grok).
 */
export async function forwardTransparentProxy(
  request: Request,
  deps: AppDependencies,
  credentials: ProxyUpstreamCredentials,
  body?: BodyInit | null,
  options: ProxyForwardOptions = {}
): Promise<Response> {
  validateCredentials(credentials);
  const projected = requestProjection(request, credentials, REQUEST_HEADER_DENYLIST);
  const upstreamUrl = targetUrl(request, credentials.baseUrl, projected.search);
  let upstream: Response;
  try {
    upstream = await deps.fetch(upstreamUrl, {
      method: request.method,
      headers: projected.headers,
      ...(body === undefined ? {} : { body }),
      redirect: "manual",
      signal: request.signal
    });
  } catch (error) {
    throw classifyUpstreamFetchError(request, error);
  }

  if (upstream.status >= 300 && upstream.status < 400) {
    await upstream.body?.cancel().catch(() => undefined);
    throw new ProxyUpstreamError(
      502,
      "Provider redirect was rejected",
      "upstream_redirect_rejected",
      upstream.status
    );
  }

  return transparentResponse(upstream, request, options, deps);
}

/**
 * Opaque xAI WebSocket proxy: authenticate the upstream handshake with the
 * Mini-owned bearer, then relay frames without inspecting their contents.
 */
export async function forwardTransparentWebSocket(
  request: Request,
  deps: AppDependencies,
  credentials: ProxyUpstreamCredentials,
  options: ProxyWebSocketForwardOptions = {}
): Promise<Response> {
  validateCredentials(credentials);
  const projected = requestProjection(request, credentials, WEBSOCKET_REQUEST_HEADER_DENYLIST);
  projected.headers.set("Upgrade", "websocket");
  const upstreamUrl = targetUrl(request, credentials.baseUrl, projected.search);
  let upstream: Response;
  try {
    upstream = await deps.fetch(upstreamUrl, {
      method: request.method,
      headers: projected.headers,
      redirect: "manual",
      signal: request.signal
    });
  } catch (error) {
    throw classifyUpstreamFetchError(request, error);
  }

  if (upstream.status >= 300 && upstream.status < 400) {
    await upstream.body?.cancel().catch(() => undefined);
    throw new ProxyUpstreamError(
      502,
      "Provider redirect was rejected",
      "upstream_redirect_rejected",
      upstream.status
    );
  }

  if (!upstream.webSocket) {
    if (upstream.status === 101) {
      throw new ProxyUpstreamError(
        502,
        "Provider returned an invalid WebSocket handshake",
        "provider_websocket_handshake_invalid",
        upstream.status
      );
    }
    return transparentResponse(upstream, request, options, deps);
  }
  if (upstream.status !== 101) {
    upstream.webSocket.close(1011, "Invalid upstream handshake");
    throw new ProxyUpstreamError(
      502,
      "Provider returned an invalid WebSocket handshake",
      "provider_websocket_handshake_invalid",
      upstream.status
    );
  }

  const runtime = options.runtime ?? workersWebSocketRuntime();
  const pair = runtime.createPair();
  const client = pair[0];
  const server = pair[1];
  connectWebSockets(server, upstream.webSocket, request.signal);
  const completion = options.onResponseBodyDone?.({
    kind: "completed",
    upstreamStatus: upstream.status
  });
  if (completion instanceof Promise) {
    options.waitUntil?.(completion);
  }
  return runtime.createResponse(
    client,
    filteredHeaders(upstream.headers, WEBSOCKET_RESPONSE_HEADER_DENYLIST, false)
  );
}

function validateCredentials(credentials: ProxyUpstreamCredentials): void {
  assertProviderBaseUrl(credentials.baseUrl);
  if (!credentials.accessToken) {
    throw new ProxyUpstreamError(500, "Provider credential is required", "missing_provider_credential", null, false);
  }
}

function targetUrl(request: Request, baseUrl: string, search?: string): string {
  const incoming = new URL(request.url);
  return `${baseUrl.trim().replace(/\/+$/, "")}${incoming.pathname}${search ?? incoming.search}`;
}

function requestProjection(
  request: Request,
  credentials: ProxyUpstreamCredentials,
  denylist: ReadonlySet<string>
): { headers: Headers; search: string } {
  const sanitized = filteredHeaders(request.headers, denylist, true);
  const projected = projectRequiredUpstreamClientIdentity(
    credentials.upstreamClientIdentity,
    request,
    sanitized,
    credentials.fallbackIdentityVersion
  );
  const headers = projected.headers;
  headers.set("Authorization", `Bearer ${credentials.accessToken}`);
  for (const [name, value] of credentials.extraHeaders ?? []) {
    headers.set(name, value);
  }
  return { headers, search: projected.search };
}

function classifyUpstreamFetchError(request: Request, error: unknown): ProxyUpstreamError {
  if (request.signal.aborted) {
    return new ProxyUpstreamError(499, "Client aborted request", "client_request_aborted");
  }
  const err = error instanceof Error ? error : null;
  const cause = err && "cause" in err && err.cause instanceof Error ? err.cause : null;
  console.error(JSON.stringify({
    event: "provider_upstream_transport_error",
    error_name: err?.name ?? "unknown",
    error_message: err?.message?.replace(/\s+/g, " ").trim().slice(0, 200).replace(/Bearer\s+\S+/gi, "Bearer [redacted]") ?? null,
    cause_name: cause?.name ?? null,
    cause_message: cause?.message?.replace(/\s+/g, " ").trim().slice(0, 200) ?? null
  }));
  return new ProxyUpstreamError(502, "Provider upstream request failed", "provider_upstream_transport_error");
}

function workersWebSocketRuntime(): ProxyWebSocketRuntime {
  return {
    createPair: () => new WebSocketPair(),
    createResponse: (client, headers) => new Response(null, {
      status: 101,
      headers,
      webSocket: client
    })
  };
}

function connectWebSockets(
  downstream: WebSocket,
  upstream: WebSocket,
  signal: AbortSignal
): void {
  downstream.binaryType = "arraybuffer";
  upstream.binaryType = "arraybuffer";
  downstream.accept({ allowHalfOpen: true });
  upstream.accept({ allowHalfOpen: true });

  let downstreamClosed = false;
  let upstreamClosed = false;
  const cleanupAbort = () => {
    if (downstreamClosed && upstreamClosed) {
      signal.removeEventListener("abort", abortBoth);
    }
  };
  const closeOpen = (socket: WebSocket, code: number, reason: string) => {
    if (socket.readyState === 1) {
      socket.close(closeCode(code), reason.slice(0, 123));
    }
  };
  const abortBoth = () => {
    closeOpen(downstream, 1001, "Client request aborted");
    closeOpen(upstream, 1001, "Client request aborted");
  };
  const failBoth = () => {
    closeOpen(downstream, 1011, "WebSocket relay failed");
    closeOpen(upstream, 1011, "WebSocket relay failed");
  };
  const relay = (source: WebSocket, target: WebSocket) => {
    source.addEventListener("message", (event: MessageEvent<ArrayBuffer | ArrayBufferView | string>) => {
      if (target.readyState === 1) {
        try {
          target.send(event.data);
        } catch {
          failBoth();
        }
      }
    });
  };

  relay(downstream, upstream);
  relay(upstream, downstream);
  downstream.addEventListener("close", (event: CloseEvent) => {
    downstreamClosed = true;
    closeOpen(upstream, event.code, event.reason);
    cleanupAbort();
  });
  upstream.addEventListener("close", (event: CloseEvent) => {
    upstreamClosed = true;
    closeOpen(downstream, event.code, event.reason);
    cleanupAbort();
  });
  downstream.addEventListener("error", failBoth);
  upstream.addEventListener("error", failBoth);
  signal.addEventListener("abort", abortBoth, { once: true });
  if (signal.aborted) {
    abortBoth();
  }
}

function closeCode(code: number): number {
  return code >= 1000 && code <= 4999 && code !== 1005 && code !== 1006 && code !== 1015
    ? code
    : 1000;
}

function transparentResponse(
  upstream: Response,
  request: Request,
  options: ProxyForwardOptions,
  deps: AppDependencies
): Response {
  const headers = filteredHeaders(upstream.headers, RESPONSE_HEADER_DENYLIST, false);
  const completedSseContentType =
    options.completeMissingSseContentType === true
    && upstream.status === 200
    && request.headers.get("accept")?.trim().toLowerCase() === "text/event-stream"
    && !headers.has("content-type");
  if (completedSseContentType) {
    headers.set("content-type", "text/event-stream");
  }
  return new Response(observeResponseBody(
    upstream,
    request.signal,
    options,
    deps,
    completedSseContentType ? "http_sse" : null
  ), {
    status: upstream.status,
    statusText: upstream.statusText,
    headers
  });
}

function observeResponseBody(
  upstream: Response,
  requestSignal: AbortSignal,
  options: ProxyForwardOptions,
  deps: AppDependencies,
  transportOverride: CodexTransportObservation["transport"] | null = null
): ReadableStream<Uint8Array> | null {
  const body = upstream.body;
  if (!options.onResponseBodyDone && !options.onResponseChunk && !options.observeUsage) {
    return body;
  }
  if (!body) {
    const completion = options.onResponseBodyDone?.({
      kind: "completed",
      upstreamStatus: upstream.status
    });
    if (completion instanceof Promise) {
      options.waitUntil?.(completion);
    }
    return null;
  }

  if (!options.observeUsage) {
    return teeCompletionOnly(body, requestSignal, upstream.status, options);
  }

  const observation = createProviderObservation(upstream, transportOverride);
  const startedAt = (options.now ?? deps.now)().getTime();
  const observerController = new AbortController();
  const tap = new ResponseObservationTap();
  const task = observeUsageTap(tap.stream, observation, options, deps, startedAt, observerController.signal);
  const reader = body.getReader();
  let finalized = false;
  const finish = (kind: ProxyResponseBodyOutcome["kind"]) => {
    if (finalized) return;
    finalized = true;
    if (kind === "completed") tap.end();
    else {
      observerController.abort();
      tap.stop();
    }
    const completion = task
      .catch(() => ({ usage: null as CapturedResponseUsage | null, observation: { ...observation } }))
      .then((result) => options.onResponseBodyDone?.({
        kind,
        upstreamStatus: upstream.status,
        usage: result.usage,
        observation: result.observation
      }));
    try {
      options.waitUntil?.(Promise.resolve(completion).then(() => undefined));
    } catch {
      // Accounting registration must not change client transport.
    }
  };

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await reader.read();
        if (next.done) {
          finish("completed");
          controller.close();
          return;
        }
        tap.push(next.value);
        safelyObserveChunk(options, next.value);
        controller.enqueue(next.value);
      } catch (error) {
        finish(requestSignal.aborted ? "cancelled" : "error");
        controller.error(error);
      }
    },
    async cancel(reason) {
      finish("cancelled");
      await reader.cancel(reason);
    }
  }, { highWaterMark: 0 });
}

function observeUsageTap(
  stream: ReadableStream<Uint8Array>,
  observation: CodexTransportObservation,
  options: ProxyForwardOptions,
  deps: AppDependencies,
  startedAt: number,
  signal: AbortSignal
): Promise<{ usage: CapturedResponseUsage | null; observation: CodexTransportObservation }> {
  return (async () => {
    let usage: CapturedResponseUsage | null = null;
    try {
      if (observation.transport !== "http_other") {
        usage = await observeCodexResponse(stream, observation, options.now ?? deps.now, startedAt, signal);
        observation.usage_captured = usage?.usage !== null && usage?.usage !== undefined;
        observation.observation_status = "ok";
        observation.observation_error_code = null;
      } else {
        await stream.cancel().catch(() => undefined);
        observation.observation_status = "skipped";
      }
    } catch (error) {
      observation.observation_status = "error";
      if (error instanceof ResponseObservationError) {
        observation.observation_error_code = error.code;
        observation.observation_stage = error.stage;
      } else {
        observation.observation_error_code = "response_observation_parse_failed";
        observation.observation_stage = "response_parse";
      }
      await stream.cancel().catch(() => undefined);
    }
    return { usage, observation: { ...observation } };
  })();
}

class ResponseObservationTap {
  readonly stream: ReadableStream<Uint8Array>;
  private controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  private stopped = false;

  constructor() {
    this.stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        this.controller = controller;
      },
      cancel: () => {
        this.stopped = true;
      }
    }, new ByteLengthQueuingStrategy({ highWaterMark: MAX_RESPONSE_OBSERVATION_LAG_BYTES }));
  }

  push(chunk: Uint8Array): void {
    if (this.stopped || !this.controller) return;
    if ((this.controller.desiredSize ?? 0) < chunk.byteLength) {
      this.fail(new ResponseObservationError("response_observation_limit", "response_body"));
      return;
    }
    this.controller.enqueue(chunk);
  }

  end(): void {
    if (this.stopped || !this.controller) return;
    this.stopped = true;
    this.controller.close();
  }

  stop(): void {
    if (this.stopped || !this.controller) return;
    this.stopped = true;
    this.controller.close();
  }

  fail(error: unknown): void {
    if (this.stopped || !this.controller) return;
    this.stopped = true;
    this.controller.error(error);
  }
}

function teeCompletionOnly(
  body: ReadableStream<Uint8Array>,
  requestSignal: AbortSignal,
  upstreamStatus: number,
  options: ProxyForwardOptions
): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  let finalized = false;
  const finalize = async (kind: ProxyResponseBodyOutcome["kind"]) => {
    if (finalized) {
      return;
    }
    finalized = true;
    await options.onResponseBodyDone?.({ kind, upstreamStatus });
  };

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await reader.read();
        if (next.done) {
          await finalize("completed");
          controller.close();
          return;
        }
        safelyObserveChunk(options, next.value);
        controller.enqueue(next.value);
      } catch (error) {
        await finalize(requestSignal.aborted ? "cancelled" : "error");
        controller.error(error);
      }
    },
    async cancel(reason) {
      try {
        await reader.cancel(reason);
      } finally {
        await finalize("cancelled");
      }
    }
  }, { highWaterMark: 0 });
}

function safelyObserveChunk(options: ProxyForwardOptions, chunk: Uint8Array): void {
  try {
    options.onResponseChunk?.(chunk);
  } catch {
    console.error(JSON.stringify({ event: "provider_response_chunk_observation_failed" }));
  }
}

function createProviderObservation(
  upstream: Response,
  transportOverride: CodexTransportObservation["transport"] | null = null
): CodexTransportObservation {
  const contentType = upstream.headers.get("content-type")?.toLowerCase() ?? "";
  const encodingHeader = upstream.headers.get("content-encoding");
  let content_encoding: CodexTransportObservation["content_encoding"] = null;
  if (encodingHeader) {
    const parts = encodingHeader.split(",").map((p) => p.trim().toLowerCase()).filter(Boolean);
    if (parts.length > 1) {
      content_encoding = "multiple";
    } else if (parts[0] === "gzip" || parts[0] === "deflate" || parts[0] === "br") {
      content_encoding = parts[0];
    } else if (parts[0]) {
      content_encoding = "unsupported";
    }
  }
  let transport: CodexTransportObservation["transport"] = transportOverride ?? "http_other";
  if (transportOverride === null && contentType.includes("text/event-stream")) {
    transport = "http_sse";
  } else if (
    transportOverride === null
    && (contentType.includes("application/json") || contentType === "")
  ) {
    transport = "http_json";
  }
  return {
    transport_trace_id: crypto.randomUUID(),
    upstream_headers_ms: null,
    first_sse_chunk_ms: null,
    first_sse_event_ms: null,
    stream_duration_ms: null,
    stream_bytes: 0,
    stream_chunks: 0,
    terminal_event: null,
    usage_captured: false,
    client_aborted: false,
    upstream_status: upstream.status,
    transport,
    observation_status: "skipped",
    observation_error_code: null,
    observation_stage: "response_body",
    content_encoding
  };
}

function filteredHeaders(incoming: Headers, denylist: ReadonlySet<string>, requestSide: boolean): Headers {
  const headers = new Headers();
  const connectionOwnedNames = connectionHeaderNames(incoming.get("connection"));
  incoming.forEach((value, name) => {
    const lowerName = name.toLowerCase();
    const prefixDenied = lowerName.startsWith("cf-")
      || lowerName.startsWith("x-mini-")
      || (requestSide && lowerName.startsWith("x-forwarded-"));
    if (!denylist.has(lowerName) && !connectionOwnedNames.has(lowerName) && !prefixDenied) {
      headers.set(name, value);
    }
  });
  return headers;
}

function connectionHeaderNames(value: string | null): Set<string> {
  return new Set(
    (value ?? "")
      .split(",")
      .map((name) => name.trim().toLowerCase())
      .filter(Boolean)
  );
}
