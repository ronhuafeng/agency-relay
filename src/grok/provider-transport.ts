import { asRecord } from "../records";
import { type ExecutionPlan } from "../plans/execution-plans";
import { copyBytes } from "../proxy/byte-stream";
import { assertProviderBaseUrl } from "../proxy/origin";
import { forwardTransparentProxy, forwardTransparentWebSocket, ProxyUpstreamError, type ProxyForwardOptions, type ProxyResponseBodyOutcome, type ProxyUpstreamCredentials } from "../proxy/adapter";
import { admitProviderAttempt, type AdmittedProviderAttempt, type ProviderResult } from "../auth/provider-attempt";
import { type AuthenticatedUser } from "../auth/types";
import { type CapturedResponseUsage } from "../usage/types";
import { type ExecutionDependencies, type RequestContext } from "../types";

export const MAX_PROVIDER_CONTROL_RESPONSE_BYTES = 64 * 1024;

export async function forwardProviderControl(
  request: Request,
  deps: ExecutionDependencies,
  credentials: ProxyUpstreamCredentials,
  attempt: AdmittedProviderAttempt,
  body?: BodyInit | null
): Promise<{ upstream: Response; bytes: Uint8Array }> {
  let upstream: Response;
  try {
    upstream = await forwardTransparentProxy(request, deps, credentials, body);
  } catch (error) {
    failAttemptedProxy(attempt, error);
    throw error;
  }
  try {
    return {
      upstream,
      bytes: await readProviderControlResponse(upstream, request.signal)
    };
  } catch (error) {
    attempt.complete({
      requestStatus: "error",
      providerResult: "transport_error",
      upstreamStatus: upstream.status,
      errorCode: error instanceof ProxyUpstreamError
        ? error.code ?? null
        : "provider_control_response_read_failed"
    });
    throw error;
  }
}

async function readProviderControlResponse(
  response: Response,
  requestSignal: AbortSignal
): Promise<Uint8Array> {
  if (!response.body) {
    return new Uint8Array();
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) {
        break;
      }
      total += next.value.byteLength;
      if (total > MAX_PROVIDER_CONTROL_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new ProxyUpstreamError(
          502,
          "Provider control response exceeded the supported bound",
          "provider_control_response_too_large",
          response.status
        );
      }
      chunks.push(next.value);
    }
  } catch (error) {
    if (error instanceof ProxyUpstreamError) {
      throw error;
    }
    if (requestSignal.aborted) {
      throw new ProxyUpstreamError(
        499,
        "Client aborted request",
        "client_request_aborted",
        response.status
      );
    }
    throw new ProxyUpstreamError(
      502,
      "Provider control response could not be read",
      "provider_control_response_read_failed",
      response.status
    );
  } finally {
    reader.releaseLock();
  }
  return copyBytes(chunks, total);
}

export function replayProviderControlResponse(upstream: Response, bytes: Uint8Array): Response {
  const body = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(body).set(bytes);
  return new Response(body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: upstream.headers,
    encodeBody: "manual"
  });
}

export function rejectAcceptedControl(attempt: AdmittedProviderAttempt, upstream: Response, code: string, message: string): never {
  attempt.complete({
    requestStatus: "error",
    providerResult: "accepted",
    upstreamStatus: upstream.status,
    errorCode: code
  });
  throw new ProxyUpstreamError(502, message, code, upstream.status);
}

export function acceptControlResponse(attempt: AdmittedProviderAttempt, upstream: Response, bytes: Uint8Array): Response {
  attempt.complete({
    requestStatus: "ok",
    providerResult: "accepted",
    upstreamStatus: upstream.status,
    errorCode: null
  });
  return replayProviderControlResponse(upstream, bytes);
}

export function rejectedControlResponse(
  attempt: { complete(outcome: {
    requestStatus: "error";
    providerResult: "rejected";
    upstreamStatus: number;
    errorCode: null;
  }): void },
  upstream: Response,
  bytes: Uint8Array
): Response | null {
  if (isSuccess(upstream.status)) return null;
  attempt.complete({
    requestStatus: "error",
    providerResult: "rejected",
    upstreamStatus: upstream.status,
    errorCode: null
  });
  return replayProviderControlResponse(upstream, bytes);
}

export function failAttemptedProxy(attempt: AdmittedProviderAttempt, error: unknown): void {
  if (error instanceof ProxyUpstreamError && error.attempted) {
    attempt.complete({
      requestStatus: "error",
      providerResult: providerResultForProxyError(error),
      upstreamStatus: error.upstreamStatus,
      errorCode: error.code ?? null
    });
  }
}

export function isSuccess(status: number): boolean {
  return status >= 200 && status < 300;
}

export function parseJsonObject(bytes: Uint8Array): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return asRecord(value);
  } catch {
    return null;
  }
}

export function unixSecondsToIso(value: unknown): string | null {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    return null;
  }
  const date = new Date(value * 1000);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export interface NpeResponseObserver {
  onChunk(chunk: Uint8Array): void;
  beforeClose?(outcome: ProxyResponseBodyOutcome): Promise<void>;
  onDone(outcome: ProxyResponseBodyOutcome): Promise<void>;
}

export async function forwardNpeWithAudit(
  request: Request,
  ctx: Pick<ExecutionContext, "waitUntil">,
  deps: ExecutionDependencies,
  requestContext: RequestContext,
  plan: ExecutionPlan,
  credentials: ProxyUpstreamCredentials,
  body: BodyInit | null | undefined,
  attempt: AdmittedProviderAttempt,
  responseObserver?: NpeResponseObserver
): Promise<Response> {
  const observeResponseUsage = plan.usageObserver === "responses";
  const upstreamStartedAt = deps.now().getTime();
  let upstreamHeadersAt: number | null = null;
  let timingLogged = false;
  const logTiming = (
    upstreamStatus: number | null,
    outcome: ProxyResponseBodyOutcome["kind"] | "headers" | "transport_error",
    observation?: ProxyResponseBodyOutcome["observation"]
  ) => {
    if (timingLogged) {
      return;
    }
    timingLogged = true;
    const requestToHeadersMs = upstreamHeadersAt === null
      ? null
      : Math.max(0, upstreamHeadersAt - requestContext.startedAt);
    const firstEventAfterHeadersMs = observation?.first_sse_event_ms ?? null;
    console.log(JSON.stringify({
      event: "provider_attempt_timing",
      request_id: requestContext.requestId,
      plan_id: plan.id,
      outcome,
      upstream_status: upstreamStatus,
      auth_ms: attempt.timing.auth_ms,
      credential_slot_ms: attempt.timing.credential_slot_ms,
      credit_admission_ms: attempt.timing.credit_admission_ms,
      request_to_admission_ms: attempt.timing.request_to_admission_ms,
      provider_headers_ms: upstreamHeadersAt === null
        ? null
        : Math.max(0, upstreamHeadersAt - upstreamStartedAt),
      request_to_upstream_headers_ms: requestToHeadersMs,
      upstream_headers_to_first_sse_event_ms: firstEventAfterHeadersMs,
      request_to_first_sse_event_ms: requestToHeadersMs === null || firstEventAfterHeadersMs === null
        ? null
        : requestToHeadersMs + firstEventAfterHeadersMs,
      stream_duration_ms: observation?.stream_duration_ms ?? null,
      stream_bytes: observation?.stream_bytes ?? null,
      stream_chunks: observation?.stream_chunks ?? null
    }));
  };
  const scheduleAccountingOutcome = (outcome: {
    requestStatus: "ok" | "error";
    providerResult: ProviderResult;
    upstreamStatus: number | null;
    errorCode: string | null;
    usage?: CapturedResponseUsage | null;
  }) => {
    attempt.complete({
      requestStatus: outcome.requestStatus,
      providerResult: outcome.providerResult,
      upstreamStatus: outcome.upstreamStatus,
      errorCode: outcome.errorCode,
      usage: outcome.usage
    });
  };
  try {
    let closeRejected = false;
    const auditOnHeaders = plan.protocol === "xai/api" && plan.usageObserver === "none";
    const forwardOptions: ProxyForwardOptions = auditOnHeaders ? {} : {
      observeUsage: observeResponseUsage,
      completeMissingSseContentType:
        plan.responseHeaderPolicy === "complete_missing_sse_content_type",
      onResponseChunk: responseObserver?.onChunk,
      now: deps.now,
      waitUntil: (p) => ctx.waitUntil(p),
      beforeResponseClose: responseObserver?.beforeClose ? async (outcome) => {
        try {
          await responseObserver.beforeClose?.(outcome);
        } catch (error) {
          closeRejected = true;
          throw error;
        }
      } : undefined,
      onResponseBodyDone: async (outcome) => {
        logTiming(outcome.upstreamStatus, outcome.kind, outcome.observation);
        try {
          await responseObserver?.onDone(outcome);
        } catch (error) {
          scheduleAccountingOutcome({
            requestStatus: "error",
            providerResult: providerResultForBodyOutcome(outcome),
            upstreamStatus: outcome.upstreamStatus,
            errorCode: "xai_file_binding_failed",
            usage: outcome.usage
          });
          throw error;
        }
        const cancelled = outcome.kind === "cancelled";
        const readFailed = outcome.kind === "error";
        const accepted = plan.mode === "websocket_transparent"
          ? outcome.upstreamStatus === 101
          : isSuccess(outcome.upstreamStatus);
        const status: "ok" | "error" = closeRejected || cancelled || readFailed || !accepted
          ? "error"
          : "ok";
        const errorCode = closeRejected ? "xai_file_binding_failed" : cancelled
          ? "client_request_aborted"
          : readFailed
            ? "provider_response_read_failed"
            : null;
        scheduleAccountingOutcome({
          requestStatus: status,
          providerResult: providerResultForBodyOutcome(outcome),
          upstreamStatus: outcome.upstreamStatus,
          errorCode,
          usage: outcome.usage
        });
      }
    };
    const response = plan.mode === "websocket_transparent"
      ? await forwardTransparentWebSocket(request, deps, credentials, forwardOptions)
      : await forwardTransparentProxy(request, deps, credentials, body, forwardOptions);
    upstreamHeadersAt = deps.now().getTime();
    if (auditOnHeaders) {
      const accepted = plan.mode === "websocket_transparent"
        ? response.status === 101
        : isSuccess(response.status);
      scheduleAccountingOutcome({
        requestStatus: accepted ? "ok" : "error",
        providerResult: accepted ? "accepted" : "rejected",
        upstreamStatus: response.status,
        errorCode: null
      });
      logTiming(response.status, "headers");
    } else if (!response.body) {
      logTiming(response.status, "headers");
    }
    return response;
  } catch (error) {
    logTiming(
      error instanceof ProxyUpstreamError ? error.upstreamStatus : null,
      "transport_error"
    );
    if (error instanceof ProxyUpstreamError && error.attempted) {
      scheduleAccountingOutcome({
        requestStatus: "error",
        providerResult: providerResultForProxyError(error),
        upstreamStatus: error.upstreamStatus,
        errorCode: error.code ?? null
      });
    }
    throw error;
  }
}

export async function beginGrokProviderAttempt(
  env: Env,
  ctx: Pick<ExecutionContext, "waitUntil">,
  deps: ExecutionDependencies,
  requestContext: RequestContext,
  auth: AuthenticatedUser,
  plan: ExecutionPlan,
  fallbackIdentityVersion: string | null
): Promise<{ attempt: AdmittedProviderAttempt; credentials: ProxyUpstreamCredentials }> {
  const attempt = await admitProviderAttempt({
    env, ctx, now: deps.now, requestContext, auth, plan
  });
  return {
    attempt,
    credentials: npeTransparentCredentials(plan, attempt.credential.accessToken, fallbackIdentityVersion)
  };
}

function npeTransparentCredentials(
  plan: ExecutionPlan,
  accessToken: string,
  fallbackIdentityVersion: string | null
): ProxyUpstreamCredentials {
  const credentials: ProxyUpstreamCredentials = {
    baseUrl: providerBaseUrl(plan),
    accessToken,
    upstreamClientIdentity: plan.upstreamClientIdentity,
    fallbackIdentityVersion
  };
  if (plan.upstreamClientIdentity === "grok_build") {
    credentials.extraHeaders = [
      ["x-xai-token-auth", "xai-grok-cli"],
      ["x-authenticateresponse", "authenticate-response"]
    ];
  } else if (
    plan.usageObserver === "image"
    || plan.usageObserver === "video"
    || plan.mode === "file_upload"
  ) {
    // Control responses must stay bounded and directly JSON-observable while
    // the original bytes are replayed unchanged to the caller.
    credentials.extraHeaders = [["Accept-Encoding", "identity"]];
  }
  return credentials;
}

function providerBaseUrl(plan: ExecutionPlan): string {
  if (!plan.providerBaseUrl) {
    throw new ProxyUpstreamError(500, "Plan missing provider base URL", "missing_provider_base_url", null, false);
  }
  return assertProviderBaseUrl(plan.providerBaseUrl);
}

export function providerResultForBodyOutcome(outcome: ProxyResponseBodyOutcome): ProviderResult {
  if (outcome.kind !== "completed") {
    return "transport_error";
  }
  return isSuccess(outcome.upstreamStatus) ? "accepted" : "rejected";
}

function providerResultForProxyError(error: ProxyUpstreamError): ProviderResult {
  return error.upstreamStatus !== null
    && error.upstreamStatus >= 300
    && error.upstreamStatus < 400
    ? "rejected"
    : "transport_error";
}
