import egressProtocol from "../../deploy/codex-egress-shim/egress-protocol.json";
import { HttpError } from "../errors";
import { assertCodexEgressBaseUrl } from "../proxy/origin";
import {
  MAX_RESPONSE_OBSERVATION_LAG_BYTES,
  observeCodexResponse,
  ResponseObservationError
} from "../proxy/observation";
import type { UpstreamClientIdentity } from "../plans/execution-plans";
import type { ProviderResult } from "../auth/provider-attempt";
import type { AppDependencies, CapturedResponseUsage, CodexTransportObservation, FreshAccessToken, RequestContext } from "../types";
import { projectRequiredUpstreamClientIdentity } from "../plans/identity-version";

interface ForwardOptions {
  onTerminal?: (outcome: CodexProviderTerminalOutcome) => void;
  upstreamClientIdentity?: UpstreamClientIdentity;
  /** Null when the bundle is native or the plan selects none. Chosen before credit admission. */
  fallbackIdentityVersion?: string | null;
  waitUntil?: (promise: Promise<void>) => void;
}

export interface CodexProviderTerminalOutcome {
  attempted: boolean;
  requestStatus: "ok" | "error";
  providerResult: ProviderResult;
  upstreamStatus: number | null;
  errorCode: string | null;
  usage: CapturedResponseUsage | null;
  observation: CodexTransportObservation;
}

export type CodexAccountEgressPath =
  | "/account/usage"
  | "/account/profile"
  | "/account/rate-limit-reset-credits";

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade"
]);

const BACKEND_REQUEST_HEADER_DENYLIST = new Set([
  ...HOP_BY_HOP_HEADERS,
  "authorization",
  "chatgpt-account-id",
  "content-length",
  "cookie",
  "forwarded",
  "host",
  "true-client-ip",
  "via",
  egressProtocol.secretHeader,
  egressProtocol.manifestHeader,
  egressProtocol.transportTrace.header,
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-real-ip"
]);

const BACKEND_RESPONSE_HEADER_DENYLIST = new Set([
  ...HOP_BY_HOP_HEADERS,
  "authorization",
  "chatgpt-account-id",
  "content-length",
  "cookie",
  "set-cookie",
  egressProtocol.secretHeader,
  egressProtocol.manifestHeader,
  egressProtocol.transportTrace.header
]);

export async function forwardModels(
  request: Request,
  env: Env,
  deps: AppDependencies,
  freshToken: FreshAccessToken,
  options: ForwardOptions = {}
): Promise<Response> {
  const projected = projectRequiredUpstreamClientIdentity(
    options.upstreamClientIdentity ?? "none",
    request,
    backendRequestHeaders(request.headers, freshToken),
    options.fallbackIdentityVersion ?? null
  );
  const target = codexTarget(env, "/models", projected.search);
  const headers = egressRequestHeaders(projected.headers, env);
  const observation = createTransportObservation();
  let terminalReported = false;
  const reportTerminal = (errorCode: string | null) => {
    if (terminalReported) {
      return;
    }
    terminalReported = true;
    const providerResult = providerResultForStatus(observation.upstream_status);
    try {
      options.onTerminal?.({
        attempted: true,
        requestStatus: providerResult === "accepted" ? "ok" : "error",
        providerResult,
        upstreamStatus: observation.upstream_status,
        errorCode,
        usage: null,
        observation: { ...observation }
      });
    } catch {
      console.error(JSON.stringify({ event: "provider_attempt_terminal_callback_failed" }));
    }
  };

  let upstream: Response;
  try {
    upstream = await deps.fetch(target, {
      method: "GET",
      headers,
      redirect: "manual",
      signal: request.signal
    });
  } catch (error) {
    const projected = upstreamTransportError(request, error);
    reportTerminal(projected.code ?? null);
    throw projected;
  }
  observation.upstream_status = upstream.status;
  observation.transport = responseTransport(
    upstream.headers.get("content-type"),
    request.headers.get("accept")
  );
  observation.content_encoding = observedContentEncoding(
    upstream.headers.get("content-encoding")
  );
  try {
    upstream = await rejectCodexRedirect(upstream);
  } catch (error) {
    reportTerminal(error instanceof HttpError ? error.code ?? null : null);
    throw error;
  }

  reportTerminal(null);
  return transparentUpstream(upstream);
}

export async function fetchCodexAccountResource(
  env: Env,
  deps: AppDependencies,
  freshToken: FreshAccessToken,
  path: CodexAccountEgressPath,
  signal?: AbortSignal
): Promise<Response> {
  const target = codexTarget(env, path);
  const headers = egressRequestHeaders(
    backendRequestHeaders(new Headers({ Accept: "application/json" }), freshToken),
    env
  );
  return rejectCodexRedirect(await deps.fetch(target, {
    method: "GET",
    headers,
    redirect: "manual",
    signal
  }));
}

export async function forwardResponses(
  request: Request,
  env: Env,
  deps: AppDependencies,
  requestContext: RequestContext,
  freshToken: FreshAccessToken,
  body: ReadableStream<Uint8Array> | null,
  options: ForwardOptions = {}
): Promise<Response> {
  return forwardResponseRoute(request, env, deps, requestContext, freshToken, "/responses", body, options);
}

export async function forwardCompact(
  request: Request,
  env: Env,
  deps: AppDependencies,
  requestContext: RequestContext,
  freshToken: FreshAccessToken,
  body: ReadableStream<Uint8Array> | null,
  options: ForwardOptions = {}
): Promise<Response> {
  return forwardResponseRoute(request, env, deps, requestContext, freshToken, "/responses/compact", body, options);
}

async function forwardResponseRoute(
  request: Request,
  env: Env,
  deps: AppDependencies,
  requestContext: RequestContext,
  freshToken: FreshAccessToken,
  path: "/responses" | "/responses/compact",
  body: ReadableStream<Uint8Array> | null,
  options: ForwardOptions
): Promise<Response> {
  const observation = createTransportObservation();
  let providerAttempted = false;
  let terminalReported = false;
  const reportTerminal = (usage: CapturedResponseUsage | null, errorCode: string | null = null) => {
    if (terminalReported) {
      return;
    }
    terminalReported = true;
    const providerResult = providerResultForStatus(observation.upstream_status);
    try {
      options.onTerminal?.({
        attempted: providerAttempted,
        requestStatus: providerResult === "accepted" ? "ok" : "error",
        providerResult,
        upstreamStatus: observation.upstream_status,
        errorCode,
        usage,
        observation: { ...observation }
      });
    } catch {
      // Provider Attempt persistence must never change client transport.
      console.error(JSON.stringify({ event: "provider_attempt_terminal_callback_failed" }));
    }
  };
  const upstream = await withFailedObservation(
    () => fetchCodex(
      request,
      env,
      deps,
      requestContext,
      freshToken,
      path,
      body,
      observation,
      options.upstreamClientIdentity ?? "none",
      options.fallbackIdentityVersion ?? null,
      () => {
      providerAttempted = true;
      }
    ),
    request,
    deps,
    requestContext,
    observation,
    reportTerminal
  );
  if (observation.transport === "http_other") {
    reportTerminal(null);
    return transparentUpstream(upstream);
  }
  if (!upstream.body) {
    observation.observation_status = "error";
    observation.observation_error_code = "response_observation_premature_eof";
    reportTerminal(null);
    return transparentUpstream(upstream);
  }

  const observerController = new AbortController();
  const observationTap = new ResponseObservationTap();
  const task = finishResponseObservation(
    observationTap.stream,
    observation,
    deps,
    requestContext,
    observerController.signal,
    reportTerminal
  );
  return transparentUpstream(upstream, observedClientBody(
    upstream.body,
    observerController,
    observationTap,
    () => options.waitUntil?.(task)
  ), observation.transport);
}

async function finishResponseObservation(
  body: ReadableStream<Uint8Array>,
  observation: CodexTransportObservation,
  deps: AppDependencies,
  requestContext: RequestContext,
  signal: AbortSignal,
  reportTerminal: (usage: CapturedResponseUsage | null, errorCode?: string | null) => void
): Promise<void> {
  let usageCapture: CapturedResponseUsage | null = null;
  try {
    usageCapture = await observeCodexResponse(body, observation, deps.now, requestContext.startedAt, signal);
    observation.usage_captured = usageCapture?.usage !== null && usageCapture?.usage !== undefined;
    observation.observation_status = "ok";
    observation.observation_error_code = null;
  } catch (error) {
    observation.observation_status = "error";
    if (error instanceof ResponseObservationError) {
      observation.observation_error_code = error.code;
      observation.observation_stage = error.stage;
    } else {
      observation.observation_error_code = "response_observation_parse_failed";
      observation.observation_stage = "response_parse";
    }
  } finally {
    await body.cancel().catch(() => undefined);
    observation.client_aborted = signal.aborted;
    observation.stream_duration_ms = elapsedMs(deps, requestContext);
    reportTerminal(usageCapture);
  }
}

async function fetchCodex(
  request: Request,
  env: Env,
  deps: AppDependencies,
  requestContext: RequestContext,
  freshToken: FreshAccessToken,
  path: "/responses" | "/responses/compact",
  body: ReadableStream<Uint8Array> | null,
  observation: CodexTransportObservation,
  upstreamClientIdentity: UpstreamClientIdentity,
  fallbackIdentityVersion: string | null,
  onUpstreamAttempt?: () => void
): Promise<Response> {
  const projected = projectRequiredUpstreamClientIdentity(
    upstreamClientIdentity,
    request,
    backendRequestHeaders(request.headers, freshToken),
    fallbackIdentityVersion
  );
  const target = codexTarget(env, path, projected.search);
  const headers = egressRequestHeaders(projected.headers, env, observation.transport_trace_id);

  let response: Response;
  try {
    onUpstreamAttempt?.();
    response = await deps.fetch(target, {
      method: "POST",
      headers,
      body,
      redirect: "manual",
      signal: request.signal
    });
  } catch (error) {
    throw upstreamTransportError(request, error);
  }

  observation.upstream_headers_ms = elapsedMs(deps, requestContext);
  observation.upstream_status = response.status;
  observation.transport = responseTransport(
    response.headers.get("content-type"),
    path === "/responses" ? request.headers.get("accept") : null
  );
  observation.content_encoding = observedContentEncoding(response.headers.get("content-encoding"));
  return rejectCodexRedirect(response);
}

function createTransportObservation(): CodexTransportObservation {
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
    upstream_status: null,
    transport: "http_other",
    observation_status: "skipped",
    observation_error_code: "response_observation_skipped",
    observation_stage: "response_body",
    content_encoding: null
  };
}

function responseTransport(
  contentType: string | null,
  accept: string | null
): CodexTransportObservation["transport"] {
  // openai/codex@9e552e9d15ba52bed7077d5357f3e18e330f8f38 sends this exact
  // Accept value for HTTP Responses streams; live Backend responses may omit Content-Type.
  if (contentType === null && accept?.trim().toLowerCase() === "text/event-stream") {
    return "http_sse";
  }
  const mediaType = contentType?.split(";", 1)[0]?.trim().toLowerCase();
  if (mediaType === "text/event-stream") {
    return "http_sse";
  }
  if (mediaType === "application/json" || mediaType?.endsWith("+json")) {
    return "http_json";
  }
  return "http_other";
}

function providerResultForStatus(status: number | null): ProviderResult {
  if (status === null) {
    return "transport_error";
  }
  return status >= 200 && status < 300 ? "accepted" : "rejected";
}

function observedContentEncoding(value: string | null): CodexTransportObservation["content_encoding"] {
  if (value === null || value.trim() === "") {
    return null;
  }
  const encodings = value.split(",").map((encoding) => encoding.trim().toLowerCase());
  if (encodings.length !== 1) {
    return "multiple";
  }
  switch (encodings[0]) {
    case "br":
    case "deflate":
    case "gzip":
    case "identity":
      return encodings[0];
    default:
      return "unsupported";
  }
}

function finishFailedObservation(
  request: Request,
  deps: AppDependencies,
  requestContext: RequestContext,
  observation: CodexTransportObservation,
  error: unknown,
  reportTerminal: (usage: CapturedResponseUsage | null, errorCode?: string | null) => void
): void {
  observation.client_aborted = request.signal.aborted;
  observation.stream_duration_ms = elapsedMs(deps, requestContext);
  const redirectRejected = observation.upstream_status !== null
    && observation.upstream_status >= 300
    && observation.upstream_status < 400;
  observation.observation_status = redirectRejected ? "skipped" : "error";
  observation.observation_error_code = request.signal.aborted
    ? "client_request_aborted"
    : redirectRejected
      ? "response_observation_skipped"
      : "upstream_transport_failed";
  observation.observation_stage = "upstream_fetch";
  reportTerminal(null, error instanceof HttpError ? error.code : "codex_upstream_transport_error");
}

async function withFailedObservation<T>(
  operation: () => Promise<T>,
  request: Request,
  deps: AppDependencies,
  requestContext: RequestContext,
  observation: CodexTransportObservation,
  reportTerminal: (usage: CapturedResponseUsage | null, errorCode?: string | null) => void
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    finishFailedObservation(request, deps, requestContext, observation, error, reportTerminal);
    throw error;
  }
}

function transparentUpstream(
  upstream: Response,
  body: ReadableStream<Uint8Array> | null = upstream.body,
  transport: CodexTransportObservation["transport"] | null = null
): Response {
  const headers = backendResponseHeaders(upstream.headers);
  if (upstream.status === 200 && transport === "http_sse" && !headers.has("content-type")) {
    headers.set("content-type", "text/event-stream");
  }
  return new Response(body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers,
    encodeBody: "manual"
  });
}

function observedClientBody(
  body: ReadableStream<Uint8Array>,
  observerController: AbortController,
  observationTap: ResponseObservationTap,
  registerObservationWaitUntil: () => void
): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  let observationWaitRegistered = false;
  const registerWaitUntilOnce = () => {
    if (observationWaitRegistered) {
      return;
    }
    observationWaitRegistered = true;
    try {
      registerObservationWaitUntil();
    } catch {
      // Observation lifecycle failures must never change client transport.
    }
  };
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const result = await reader.read();
        if (result.done) {
          observationTap.end();
          registerWaitUntilOnce();
          controller.close();
        } else {
          observationTap.push(result.value);
          controller.enqueue(result.value);
        }
      } catch (error) {
        observationTap.fail(error);
        registerWaitUntilOnce();
        controller.error(error);
      }
    },
    async cancel(reason) {
      observerController.abort(reason);
      observationTap.stop();
      registerWaitUntilOnce();
      await reader.cancel(reason);
    }
  });
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
    if (this.stopped || !this.controller) {
      return;
    }
    if ((this.controller.desiredSize ?? 0) < chunk.byteLength) {
      this.fail(new ResponseObservationError("response_observation_limit", "response_body"));
      return;
    }
    this.controller.enqueue(chunk);
  }

  end(): void {
    if (this.stopped || !this.controller) {
      return;
    }
    this.stopped = true;
    this.controller.close();
  }

  stop(): void {
    if (this.stopped || !this.controller) {
      return;
    }
    this.stopped = true;
    this.controller.close();
  }

  fail(error: unknown): void {
    if (this.stopped || !this.controller) {
      return;
    }
    this.stopped = true;
    this.controller.error(error);
  }
}

function upstreamTransportError(request: Request, error: unknown): HttpError {
  if (request.signal.aborted) {
    return new HttpError(499, "Client aborted request", "invalid_request_error", "client_request_aborted");
  }
  // Metadata only — never log headers, tokens, secrets, or bodies.
  const err = error instanceof Error ? error : null;
  const cause = err && "cause" in err && err.cause instanceof Error ? err.cause : null;
  console.error(JSON.stringify({
    event: "codex_upstream_transport_error",
    error_name: err?.name ?? "unknown",
    error_message: sanitizeTransportErrorMessage(err?.message),
    cause_name: cause?.name ?? null,
    cause_message: sanitizeTransportErrorMessage(cause?.message)
  }));
  return new HttpError(
    502,
    "Codex upstream request failed",
    "upstream_error",
    "codex_upstream_transport_error"
  );
}

/** Keep log lines short and free of credential-shaped substrings. */
function sanitizeTransportErrorMessage(message: string | undefined): string | null {
  if (!message) {
    return null;
  }
  const collapsed = message.replace(/\s+/g, " ").trim().slice(0, 200);
  // Drop anything that looks like a bearer/token fragment if present.
  return collapsed.replace(/Bearer\s+\S+/gi, "Bearer [redacted]");
}

async function rejectCodexRedirect(response: Response): Promise<Response> {
  if (response.status < 300 || response.status >= 400) {
    return response;
  }
  await response.body?.cancel().catch(() => undefined);
  throw new HttpError(
    502,
    "Codex upstream redirect was rejected",
    "upstream_error",
    "upstream_redirect_rejected"
  );
}

function elapsedMs(deps: AppDependencies, requestContext: RequestContext): number {
  return Math.max(0, deps.now().getTime() - requestContext.startedAt);
}

function codexTarget(
  env: Env,
  path: "/models" | "/responses" | "/responses/compact" | CodexAccountEgressPath,
  search = ""
): string {
  // Validate origin before any bearer, account id, egress secret, or manifest is attached.
  const baseUrl = assertCodexEgressBaseUrl(env.CODEX_EGRESS_BASE_URL);
  return `${baseUrl}${path}${search}`;
}

function backendRequestHeaders(incoming: Headers, freshToken: FreshAccessToken): Headers {
  const headers = new Headers();
  const connectionOwnedNames = connectionHeaderNames(incoming.get("connection"));
  incoming.forEach((value, name) => {
    const lowerName = name.toLowerCase();
    if (!BACKEND_REQUEST_HEADER_DENYLIST.has(lowerName) && !connectionOwnedNames.has(lowerName) && !lowerName.startsWith("cf-")) {
      headers.set(name, value);
    }
  });
  headers.set("Authorization", `Bearer ${freshToken.access_token}`);
  if (freshToken.account_id) {
    headers.set("Chatgpt-Account-Id", freshToken.account_id);
  }
  return headers;
}

function egressRequestHeaders(
  projected: Headers,
  env: Env,
  transportTraceId: string = crypto.randomUUID()
): Headers {
  if (!env.CODEX_EGRESS_SECRET) {
    throw new HttpError(500, "CODEX_EGRESS_SECRET is required", "server_error", "missing_codex_egress_secret");
  }
  const headers = new Headers(projected);
  const manifest = [...headers.keys()].map((name) => name.toLowerCase()).sort();
  headers.set(egressProtocol.manifestHeader, JSON.stringify(manifest));
  headers.set(egressProtocol.secretHeader, env.CODEX_EGRESS_SECRET);
  headers.set(egressProtocol.transportTrace.header, transportTraceId);
  return headers;
}

function backendResponseHeaders(upstream: Headers): Headers {
  const headers = new Headers();
  const connectionOwnedNames = connectionHeaderNames(upstream.get("connection"));
  upstream.forEach((value, name) => {
    const lowerName = name.toLowerCase();
    if (!BACKEND_RESPONSE_HEADER_DENYLIST.has(lowerName) && !connectionOwnedNames.has(lowerName)) {
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
