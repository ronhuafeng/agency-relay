/**
 * Grok (xai/grok) Execution Plan handlers — opaque forward path.
 */
import { hmacSha256Hex } from "../crypto";
import {
  bindXaiFileOwner,
  createVideoJob,
  deleteXaiFileOwner,
  findXaiFileOwner,
  findVideoJobForUser,
  observeVideoJob,
  recordImageMediaUsage,
  recordUntrackedVideoStart
} from "../db";
import { HttpError } from "../errors";
import type { ExecutionPlan } from "../plans/execution-plans";
import { assertProviderBaseUrl } from "../proxy/origin";
import {
  forwardTransparentProxy,
  forwardTransparentWebSocket,
  ProxyUpstreamError,
  type ProxyForwardOptions,
  type ProxyResponseBodyOutcome,
  type ProxyUpstreamCredentials
} from "../proxy/adapter";
import {
  admitProviderAttempt,
  type AdmittedProviderAttempt,
  type ProviderResult
} from "../auth/provider-attempt";
import type {
  AuthenticatedUser,
  CapturedResponseUsage,
  ExecutionDependencies,
  RequestContext
} from "../types";
import { requireFallbackIdentityVersion } from "../plans/identity-version";

export async function executeGrokPlan(
  request: Request,
  env: Env,
  ctx: Pick<ExecutionContext, "waitUntil">,
  deps: ExecutionDependencies,
  requestContext: RequestContext,
  auth: AuthenticatedUser,
  plan: ExecutionPlan
): Promise<Response> {
  const fallbackIdentityVersion = await requireFallbackIdentityVersion(
    env,
    plan.upstreamClientIdentity,
    request
  );
  if (plan.mode === "video_start") {
    return await executeVideoStartPlan(
      request, env, ctx, deps, requestContext, auth, plan, fallbackIdentityVersion
    );
  }
  if (plan.mode === "video_poll") {
    return await executeVideoPollPlan(
      request, env, ctx, deps, requestContext, auth, plan, fallbackIdentityVersion
    );
  }
  if (plan.mode === "file_upload") {
    return await executeFileUploadPlan(
      request, env, ctx, deps, requestContext, auth, plan, fallbackIdentityVersion
    );
  }
  if (plan.mode === "file_owner") {
    return await executeFileOwnerPlan(
      request, env, ctx, deps, requestContext, auth, plan, fallbackIdentityVersion
    );
  }

  // Transparent Grok: no body parse.
  return await executeTransparentGrokPlan(
    request, env, ctx, deps, requestContext, auth, plan, fallbackIdentityVersion
  );
}

const MAX_PROVIDER_CONTROL_RESPONSE_BYTES = 64 * 1024;
const MAX_IMAGE_METADATA_DEPTH = 64;
const MAX_IMAGE_OUTPUT_FILE_IDS = 64;
const VIDEO_REQUEST_ID = /^[A-Za-z0-9_-]{1,200}$/;
const XAI_FILE_ID = /^file_[A-Za-z0-9_-]{1,200}$/;

async function executeFileUploadPlan(
  request: Request,
  env: Env,
  ctx: Pick<ExecutionContext, "waitUntil">,
  deps: ExecutionDependencies,
  requestContext: RequestContext,
  auth: AuthenticatedUser,
  plan: ExecutionPlan,
  fallbackIdentityVersion: string | null
): Promise<Response> {
  const { attempt, credentials } = await beginGrokProviderAttempt(
    env, ctx, deps, requestContext, auth, plan, fallbackIdentityVersion
  );
  const { upstream, bytes } = await forwardProviderControl(
    request, deps, credentials, attempt, request.body
  );
  if (!isSuccess(upstream.status)) {
    attempt.complete({
      requestStatus: "error",
      providerResult: "rejected",
      upstreamStatus: upstream.status,
      errorCode: null
    });
    return replayProviderControlResponse(upstream, bytes);
  }
  const file = parseXaiFileMetadata(bytes);
  if (!file || !await bindFileId(
    env, file.fileId, auth.user.id, "upload", file.expiresAt, deps.now()
  )) {
    attempt.complete({
      requestStatus: "error",
      providerResult: "accepted",
      upstreamStatus: upstream.status,
      errorCode: "xai_file_binding_failed"
    });
    throw new ProxyUpstreamError(
      502,
      "Provider file could not be bound to the caller",
      "xai_file_binding_failed",
      upstream.status
    );
  }
  attempt.complete({
    requestStatus: "ok",
    providerResult: "accepted",
    upstreamStatus: upstream.status,
    errorCode: null
  });
  return replayProviderControlResponse(upstream, bytes);
}

async function executeFileOwnerPlan(
  request: Request,
  env: Env,
  ctx: Pick<ExecutionContext, "waitUntil">,
  deps: ExecutionDependencies,
  requestContext: RequestContext,
  auth: AuthenticatedUser,
  plan: ExecutionPlan,
  fallbackIdentityVersion: string | null
): Promise<Response> {
  const fileId = xaiFileIdFromPath(request);
  const fileIdHash = await xaiFileIdHash(env, fileId);
  if (!await findXaiFileOwner(env, fileIdHash, auth.user.id)) {
    throw new HttpError(404, "xAI file not found", "invalid_request_error", "xai_file_not_found");
  }
  const { attempt, credentials } = await beginGrokProviderAttempt(
    env, ctx, deps, requestContext, auth, plan, fallbackIdentityVersion
  );
  try {
    const response = await forwardTransparentProxy(request, deps, credentials, request.body, {
      onResponseBodyDone: (outcome) => {
        const ok = outcome.kind === "completed" && isSuccess(outcome.upstreamStatus);
        attempt.complete({
          requestStatus: ok ? "ok" : "error",
          providerResult: providerResultForBodyOutcome(outcome),
          upstreamStatus: outcome.upstreamStatus,
          errorCode: outcome.kind === "cancelled"
            ? "client_request_aborted"
            : outcome.kind === "error" ? "provider_response_read_failed" : null
        });
      }
    });
    if (response.status === 404 || (request.method === "DELETE" && isSuccess(response.status))) {
      ctx.waitUntil(deleteXaiFileOwner(env, fileIdHash, auth.user.id).catch(() => {
        console.error(JSON.stringify({ event: "xai_file_owner_cleanup_failed", plan_id: plan.id }));
      }));
    }
    return response;
  } catch (error) {
    if (error instanceof ProxyUpstreamError && error.attempted) {
      attempt.complete({
        requestStatus: "error",
        providerResult: providerResultForProxyError(error),
        upstreamStatus: error.upstreamStatus,
        errorCode: error.code ?? null
      });
    }
    throw error;
  }
}

async function executeVideoStartPlan(
  request: Request,
  env: Env,
  ctx: Pick<ExecutionContext, "waitUntil">,
  deps: ExecutionDependencies,
  requestContext: RequestContext,
  auth: AuthenticatedUser,
  plan: ExecutionPlan,
  fallbackIdentityVersion: string | null
): Promise<Response> {
  const { attempt, credentials } = await beginGrokProviderAttempt(
    env, ctx, deps, requestContext, auth, plan, fallbackIdentityVersion
  );
  const { upstream, bytes } = await forwardProviderControl(
    request, deps, credentials, attempt, request.body
  );

  if (!isSuccess(upstream.status)) {
    attempt.complete({
      requestStatus: "error",
      providerResult: "rejected",
      upstreamStatus: upstream.status,
      errorCode: null
    });
    return replayProviderControlResponse(upstream, bytes);
  }

  const requestId = parseVideoStartRequestId(bytes);
  if (!requestId) {
    attempt.complete({
      requestStatus: "error",
      providerResult: "accepted",
      upstreamStatus: upstream.status,
      errorCode: "video_start_response_invalid"
    });
    throw new ProxyUpstreamError(
      502,
      "Provider returned an invalid video start response",
      "video_start_response_invalid",
      upstream.status
    );
  }

  const requestIdHash = await videoRequestIdHash(env, requestId);
  if (!plan.mediaCapability) {
    attempt.complete({
      requestStatus: "error",
      providerResult: "accepted",
      upstreamStatus: upstream.status,
      errorCode: "video_capability_missing"
    });
    throw new ProxyUpstreamError(
      500,
      "Video start plan is missing its accounting capability",
      "video_capability_missing",
      upstream.status,
      false
    );
  }
  try {
    await createVideoJob(env, {
      request_id_hash: requestIdHash,
      user_id: auth.user.id,
      route_profile_id: plan.id,
      capability: plan.mediaCapability
    }, deps.now());
  } catch {
    attempt.complete({
      requestStatus: "error",
      providerResult: "accepted",
      upstreamStatus: upstream.status,
      errorCode: "video_job_binding_failed"
    });
    throw new HttpError(
      502,
      "Video job could not be bound to the caller",
      "api_error",
      "video_job_binding_failed"
    );
  }

  attempt.complete({
    requestStatus: "ok",
    providerResult: "accepted",
    upstreamStatus: upstream.status,
    errorCode: null
  });
  return replayProviderControlResponse(upstream, bytes);
}

async function executeVideoPollPlan(
  request: Request,
  env: Env,
  ctx: Pick<ExecutionContext, "waitUntil">,
  deps: ExecutionDependencies,
  requestContext: RequestContext,
  auth: AuthenticatedUser,
  plan: ExecutionPlan,
  fallbackIdentityVersion: string | null
): Promise<Response> {
  const requestId = videoRequestIdFromPath(request);
  const requestIdHash = await videoRequestIdHash(env, requestId);
  const job = await findVideoJobForUser(env, requestIdHash, auth.user.id);
  if (!job) {
    throw new HttpError(404, "Video job not found", "invalid_request_error", "video_job_not_found");
  }

  // Resolve on every poll so silent refresh and reauthorization state remain live.
  const { attempt, credentials } = await beginGrokProviderAttempt(
    env, ctx, deps, requestContext, auth, plan, fallbackIdentityVersion
  );
  const { upstream, bytes } = await forwardProviderControl(
    request, deps, credentials, attempt
  );

  if (!isSuccess(upstream.status)) {
    attempt.complete({
      requestStatus: "error",
      providerResult: "rejected",
      upstreamStatus: upstream.status,
      errorCode: null
    });
    return replayProviderControlResponse(upstream, bytes);
  }

  const observation = parseVideoPollObservation(bytes);
  let fileBindingFailed = false;
  if (observation) {
    try {
      await observeVideoJob(env, {
        request_id_hash: requestIdHash,
        user_id: auth.user.id,
        status: observation.status,
        video_seconds: observation.videoSeconds,
        outputs: observation.outputs,
        provider_cost_usd_ticks: observation.costTicks
      }, deps.now());
    } catch {
      // Observation is retryable on the next owner poll and must not replace a
      // valid provider response with a Mini error.
      console.error(JSON.stringify({
        event: "video_job_observation_failed",
        plan_id: plan.id
      }));
    }
    for (const fileId of observation.fileIds) {
      try {
        const bound = await bindFileId(
          env, fileId, auth.user.id, "video_output", observation.expiresAt, deps.now()
        );
        if (!bound) {
          throw new Error("owner collision");
        }
      } catch {
        fileBindingFailed = true;
        console.error(JSON.stringify({
          event: "xai_file_output_binding_failed",
          plan_id: plan.id,
          source: "video_output"
        }));
      }
    }
  }
  if (fileBindingFailed) {
    attempt.complete({
      requestStatus: "error",
      providerResult: "accepted",
      upstreamStatus: upstream.status,
      errorCode: "xai_file_binding_failed",
      resolvedModel: observation?.model ?? null
    });
    throw new ProxyUpstreamError(
      502,
      "Provider video output could not be bound to the caller",
      "xai_file_binding_failed",
      upstream.status
    );
  }
  attempt.complete({
    requestStatus: "ok",
    providerResult: "accepted",
    upstreamStatus: upstream.status,
    errorCode: null,
    resolvedModel: observation?.model ?? null
  });
  return replayProviderControlResponse(upstream, bytes);
}

async function forwardProviderControl(
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
    if (error instanceof ProxyUpstreamError && error.attempted) {
      attempt.complete({
        requestStatus: "error",
        providerResult: providerResultForProxyError(error),
        upstreamStatus: error.upstreamStatus,
        errorCode: error.code ?? null
      });
    }
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
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function replayProviderControlResponse(upstream: Response, bytes: Uint8Array): Response {
  const body = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(body).set(bytes);
  return new Response(body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: upstream.headers,
    encodeBody: "manual"
  });
}

function parseVideoStartRequestId(bytes: Uint8Array): string | null {
  const value = parseJsonObject(bytes);
  const requestId = value?.request_id;
  return typeof requestId === "string" && VIDEO_REQUEST_ID.test(requestId) ? requestId : null;
}

function parseXaiFileMetadata(bytes: Uint8Array): {
  fileId: string;
  expiresAt: string | null;
} | null {
  const value = parseJsonObject(bytes);
  const fileId = value?.id;
  if (typeof fileId !== "string" || !XAI_FILE_ID.test(fileId)) {
    return null;
  }
  return { fileId, expiresAt: unixSecondsToIso(value?.expires_at) };
}

function parseVideoPollObservation(bytes: Uint8Array): {
  status: "pending" | "done" | "failed" | "expired";
  videoSeconds: number | null;
  outputs: number | null;
  model: string | null;
  fileIds: string[];
  costTicks: number | null;
  expiresAt: string | null;
} | null {
  const value = parseJsonObject(bytes);
  if (!value) {
    return null;
  }
  const status = value.status;
  if (status !== "pending" && status !== "done" && status !== "failed" && status !== "expired") {
    return null;
  }
  const video = isJsonObject(value.video) ? value.video : null;
  const duration = video?.duration;
  const videoSeconds = typeof duration === "number" && Number.isFinite(duration) && duration >= 0
    ? duration
    : null;
  const outputUrl = video?.url;
  const fileOutput = isJsonObject(video?.file_output) ? video.file_output : null;
  const fileId = fileOutput?.file_id;
  const usage = isJsonObject(value.usage) ? value.usage : null;
  const providerCost = usage?.cost_in_usd_ticks;
  return {
    status,
    videoSeconds,
    outputs: status === "done" && typeof outputUrl === "string" && outputUrl.length > 0 ? 1 : null,
    model: typeof value.model === "string" && value.model.length <= 200 ? value.model : null,
    fileIds: typeof fileId === "string" && XAI_FILE_ID.test(fileId) ? [fileId] : [],
    costTicks: typeof providerCost === "number"
      && Number.isSafeInteger(providerCost)
      && providerCost >= 0
      ? providerCost
      : null,
    expiresAt: unixSecondsToIso(fileOutput?.expires_at)
  };
}

function parseJsonObject(bytes: Uint8Array): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return isJsonObject(value) ? value : null;
  } catch {
    return null;
  }
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function videoRequestIdFromPath(request: Request): string {
  const requestId = new URL(request.url).pathname.slice("/v1/videos/".length);
  if (!VIDEO_REQUEST_ID.test(requestId)) {
    throw new HttpError(404, "Video job not found", "invalid_request_error", "video_job_not_found");
  }
  return requestId;
}

async function videoRequestIdHash(env: Env, requestId: string): Promise<string> {
  return await hmacSha256Hex(env.API_KEY_HASH_PEPPER, `video-job:v1:${requestId}`);
}

function xaiFileIdFromPath(request: Request): string {
  const pathname = new URL(request.url).pathname;
  const suffix = pathname.endsWith("/content") ? "/content" : "";
  const fileId = pathname.slice("/v1/files/".length, suffix ? -suffix.length : undefined);
  if (!XAI_FILE_ID.test(fileId)) {
    throw new HttpError(404, "xAI file not found", "invalid_request_error", "xai_file_not_found");
  }
  return fileId;
}

async function xaiFileIdHash(env: Env, fileId: string): Promise<string> {
  return await hmacSha256Hex(env.API_KEY_HASH_PEPPER, `xai-file:v1:${fileId}`);
}

async function bindFileId(
  env: Env,
  fileId: string,
  userId: string,
  source: "upload" | "image_output" | "video_output",
  expiresAt: string | null,
  now: Date
): Promise<boolean> {
  return await bindXaiFileOwner(env, {
    file_id_hash: await xaiFileIdHash(env, fileId),
    user_id: userId,
    source,
    expires_at: expiresAt
  }, now);
}

function isSuccess(status: number): boolean {
  return status >= 200 && status < 300;
}

function unixSecondsToIso(value: unknown): string | null {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    return null;
  }
  const date = new Date(value * 1000);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** Opaque single-pass NPE forward (Grok native surface). */
async function executeTransparentGrokPlan(
  request: Request,
  env: Env,
  ctx: Pick<ExecutionContext, "waitUntil">,
  deps: ExecutionDependencies,
  requestContext: RequestContext,
  auth: AuthenticatedUser,
  plan: ExecutionPlan,
  fallbackIdentityVersion: string | null
): Promise<Response> {
  const { attempt, credentials } = await beginGrokProviderAttempt(
    env, ctx, deps, requestContext, auth, plan, fallbackIdentityVersion
  );
  const imageObserver = isImagePlan(plan)
    ? createImagePlanObserver(env, auth.user.id, plan, deps.now)
    : undefined;
  const videoObserver = plan.protocol === "xai/api" && plan.usageObserver === "video"
    ? createTransparentVideoPlanObserver(env, ctx, auth.user.id, plan, request, deps.now)
    : undefined;
  let response: Response;
  try {
    response = await forwardNpeWithAudit(
      request,
      ctx,
      deps,
      requestContext,
      plan,
      credentials,
      request.body,
      attempt,
      imageObserver ?? videoObserver
    );
  } catch (error) {
    if (isImagePlan(plan) && error instanceof ProxyUpstreamError && error.attempted) {
      ctx.waitUntil(recordImageMediaUsage(env, {
        user_id: auth.user.id,
        route_profile_id: plan.id,
        capability: imageCapability(plan),
        status: "error",
        outputs: null,
        provider_cost_usd_ticks: null
      }, deps.now()).catch(() => {
        console.error(JSON.stringify({ event: "image_media_accounting_failed", plan_id: plan.id }));
      }));
    }
    throw error;
  }
  return response;
}

interface NpeResponseObserver {
  onChunk(chunk: Uint8Array): void;
  onDone(outcome: ProxyResponseBodyOutcome): Promise<void>;
}

function createTransparentVideoPlanObserver(
  env: Env,
  ctx: Pick<ExecutionContext, "waitUntil">,
  userId: string,
  plan: ExecutionPlan,
  request: Request,
  now: () => Date
): NpeResponseObserver {
  const metadata = createBoundedJsonMetadataObserver();
  return {
    onChunk(chunk) {
      metadata.push(chunk);
    },
    onDone(outcome) {
      if (outcome.kind !== "completed" || !isSuccess(outcome.upstreamStatus)) {
        return Promise.resolve();
      }
      const bytes = metadata.finish();
      if (!bytes) {
        if (plan.mediaCapability) {
          ctx.waitUntil(recordUntrackedVideoStart(env, {
            user_id: userId,
            route_profile_id: plan.id,
            capability: plan.mediaCapability
          }, now()).catch(() => {
            console.error(JSON.stringify({ event: "video_start_observation_failed", plan_id: plan.id }));
          }));
        }
        return Promise.resolve();
      }
      ctx.waitUntil(observeTransparentVideoLifecycle(env, userId, plan, request, bytes, now).catch(() => {
        console.error(JSON.stringify({ event: "video_job_observation_failed", plan_id: plan.id }));
      }));
      return Promise.resolve();
    }
  };
}

function createBoundedJsonMetadataObserver(): {
  push(chunk: Uint8Array): void;
  finish(): Uint8Array | null;
} {
  const chunks: Uint8Array[] = [];
  let total = 0;
  let exceeded = false;
  return {
    push(chunk) {
      if (exceeded) {
        return;
      }
      total += chunk.byteLength;
      if (total > MAX_PROVIDER_CONTROL_RESPONSE_BYTES) {
        exceeded = true;
        chunks.length = 0;
        return;
      }
      chunks.push(chunk.slice());
    },
    finish() {
      if (exceeded || total === 0) {
        return null;
      }
      const bytes = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return bytes;
    }
  };
}

async function observeTransparentVideoLifecycle(
  env: Env,
  userId: string,
  plan: ExecutionPlan,
  request: Request,
  bytes: Uint8Array,
  now: () => Date
): Promise<void> {
  if (plan.mediaCapability) {
    const requestId = parseVideoStartRequestId(bytes);
    if (!requestId) {
      await recordUntrackedVideoStart(env, {
        user_id: userId,
        route_profile_id: plan.id,
        capability: plan.mediaCapability
      }, now());
      return;
    }
    await createVideoJob(env, {
      request_id_hash: await videoRequestIdHash(env, requestId),
      user_id: userId,
      route_profile_id: plan.id,
      capability: plan.mediaCapability
    }, now());
    return;
  }

  const requestIdHash = await videoRequestIdHash(env, videoRequestIdFromPath(request));
  if (!await findVideoJobForUser(env, requestIdHash, userId)) {
    return;
  }
  const observation = parseVideoPollObservation(bytes);
  if (!observation) {
    return;
  }
  await observeVideoJob(env, {
    request_id_hash: requestIdHash,
    user_id: userId,
    status: observation.status,
    video_seconds: observation.videoSeconds,
    outputs: observation.outputs,
    provider_cost_usd_ticks: observation.costTicks
  }, now());
}

function createImagePlanObserver(
  env: Env,
  userId: string,
  plan: ExecutionPlan,
  now: () => Date
): NpeResponseObserver {
  const metadata = createImageMetadataStreamObserver();
  return {
    onChunk(chunk) {
      metadata.push(chunk);
    },
    async onDone(outcome) {
      const observation = metadata.finish();
      await finalizeImageObservation(
        env,
        userId,
        plan,
        now,
        outcome,
        observation
      );
    }
  };
}

interface ImageMetadataObservation {
  fileIds: string[];
  outputs: number | null;
  costTicks: number | null;
}

function createImageMetadataStreamObserver(): {
  push(chunk: Uint8Array): void;
  finish(): ImageMetadataObservation;
} {
  const decoder = new TextDecoder();
  const metadata = createImageMetadataJsonObserver();
  const syntax = createStreamingJsonSyntaxValidator();
  let finished = false;
  return {
    push(chunk) {
      if (!finished) {
        const text = decoder.decode(chunk, { stream: true });
        syntax.push(text);
        metadata.push(text);
      }
    },
    finish() {
      if (!finished) {
        finished = true;
        const tail = decoder.decode();
        syntax.push(tail);
        metadata.push(tail);
      }
      const observation = metadata.finish();
      return syntax.finish()
        ? observation
        : { fileIds: [], outputs: null, costTicks: null };
    }
  };
}

type JsonSyntaxFrame = {
  kind: "object";
  state: "first_key_or_end" | "key" | "colon" | "value" | "comma_or_end";
} | {
  kind: "array";
  state: "first_value_or_end" | "value" | "comma_or_end";
};

function createStreamingJsonSyntaxValidator(): {
  push(text: string): void;
  finish(): boolean;
} {
  const frames: JsonSyntaxFrame[] = [];
  let rootState: "value" | "complete" = "value";
  let token: "string" | "number" | "literal" | null = null;
  let escaped = false;
  let unicodeDigits = 0;
  let numberState: "minus" | "zero" | "int" | "dot" | "frac" | "exp" | "exp_sign" | "exp_digits" | null = null;
  let literalRemainder = "";
  let invalid = false;

  const current = () => frames.at(-1);
  const beginValue = () => {
    const frame = current();
    if (!frame) {
      if (rootState !== "value") {
        invalid = true;
        return;
      }
      rootState = "complete";
      return;
    }
    if (frame.kind === "object") {
      if (frame.state !== "value") {
        invalid = true;
        return;
      }
      frame.state = "comma_or_end";
      return;
    }
    if (frame.state !== "first_value_or_end" && frame.state !== "value") {
      invalid = true;
      return;
    }
    frame.state = "comma_or_end";
  };
  const startNumber = (character: string) => {
    token = "number";
    numberState = character === "-" ? "minus" : character === "0" ? "zero" : "int";
  };
  const numberConsumes = (character: string): boolean => {
    const digit = character >= "0" && character <= "9";
    if (digit) {
      if (numberState === "minus") {
        numberState = character === "0" ? "zero" : "int";
        return true;
      }
      if (numberState === "int" || numberState === "frac" || numberState === "exp_digits") {
        return true;
      }
      if (numberState === "dot") {
        numberState = "frac";
        return true;
      }
      if (numberState === "exp" || numberState === "exp_sign") {
        numberState = "exp_digits";
        return true;
      }
      return false;
    }
    if (character === "." && (numberState === "zero" || numberState === "int")) {
      numberState = "dot";
      return true;
    }
    if ((character === "e" || character === "E")
      && (numberState === "zero" || numberState === "int" || numberState === "frac")) {
      numberState = "exp";
      return true;
    }
    if ((character === "+" || character === "-") && numberState === "exp") {
      numberState = "exp_sign";
      return true;
    }
    return false;
  };
  const numberComplete = () => numberState === "zero"
    || numberState === "int"
    || numberState === "frac"
    || numberState === "exp_digits";

  const processStructural = (character: string) => {
    if (/\s/.test(character)) {
      return;
    }
    const frame = current();
    if (!frame) {
      if (rootState === "complete") {
        invalid = true;
        return;
      }
      beginValueCharacter(character);
      return;
    }
    if (frame.kind === "object") {
      if (frame.state === "first_key_or_end" || frame.state === "key") {
        if (frame.state === "first_key_or_end" && character === "}") {
          frames.pop();
        } else if (character === '"') {
          frame.state = "colon";
          token = "string";
          escaped = false;
          unicodeDigits = 0;
        } else {
          invalid = true;
        }
        return;
      }
      if (frame.state === "colon") {
        if (character === ":") {
          frame.state = "value";
        } else {
          invalid = true;
        }
        return;
      }
      if (frame.state === "value") {
        beginValueCharacter(character);
        return;
      }
      if (character === ",") {
        frame.state = "key";
      } else if (character === "}") {
        frames.pop();
      } else {
        invalid = true;
      }
      return;
    }
    if (frame.state === "first_value_or_end" || frame.state === "value") {
      if (frame.state === "first_value_or_end" && character === "]") {
        frames.pop();
      } else {
        beginValueCharacter(character);
      }
      return;
    }
    if (character === ",") {
      frame.state = "value";
    } else if (character === "]") {
      frames.pop();
    } else {
      invalid = true;
    }
  };

  function beginValueCharacter(character: string): void {
    beginValue();
    if (invalid) {
      return;
    }
    if (character === "{") {
      frames.push({ kind: "object", state: "first_key_or_end" });
    } else if (character === "[") {
      frames.push({ kind: "array", state: "first_value_or_end" });
    } else if (character === '"') {
      token = "string";
      escaped = false;
      unicodeDigits = 0;
    } else if (character === "t") {
      token = "literal";
      literalRemainder = "rue";
    } else if (character === "f") {
      token = "literal";
      literalRemainder = "alse";
    } else if (character === "n") {
      token = "literal";
      literalRemainder = "ull";
    } else if (character === "-" || (character >= "0" && character <= "9")) {
      startNumber(character);
    } else {
      invalid = true;
    }
    if (frames.length > MAX_IMAGE_METADATA_DEPTH) {
      invalid = true;
    }
  }

  return {
    push(text) {
      for (const character of text) {
        if (invalid) {
          continue;
        }
        if (token === "string") {
          if (unicodeDigits > 0) {
            if (!/[0-9a-fA-F]/.test(character)) {
              invalid = true;
            } else {
              unicodeDigits -= 1;
            }
          } else if (escaped) {
            escaped = false;
            if (character === "u") {
              unicodeDigits = 4;
            } else if (!'"\\/bfnrt'.includes(character)) {
              invalid = true;
            }
          } else if (character === "\\") {
            escaped = true;
          } else if (character === '"') {
            token = null;
          } else if (character.charCodeAt(0) < 0x20) {
            invalid = true;
          }
          continue;
        }
        if (token === "literal") {
          if (character !== literalRemainder[0]) {
            invalid = true;
          } else {
            literalRemainder = literalRemainder.slice(1);
            if (literalRemainder.length === 0) {
              token = null;
            }
          }
          continue;
        }
        if (token === "number") {
          if (numberConsumes(character)) {
            continue;
          }
          if (!numberComplete()) {
            invalid = true;
            continue;
          }
          token = null;
          numberState = null;
        }
        processStructural(character);
      }
    },
    finish() {
      if (token === "number" && numberComplete()) {
        token = null;
        numberState = null;
      }
      return !invalid && token === null && frames.length === 0 && rootState === "complete";
    }
  };
}

type ImageJsonFrame = {
  kind: "object";
  role: "root" | "usage" | "data_item" | "file_output" | "other";
  key: string | null;
  pendingKey: string | null;
  expectsKey: boolean;
} | {
  kind: "array";
  role: "data" | "other";
};

function createImageMetadataJsonObserver(): {
  push(text: string): void;
  finish(): ImageMetadataObservation;
} {
  const frames: ImageJsonFrame[] = [];
  const fileIds: string[] = [];
  let fileIdLimitExceeded = false;
  let rootSeen = false;
  let dataSeen = false;
  let dataClosed = false;
  let outputs = 0;
  let costTicks: number | null = null;
  let costSeen = false;
  let costInvalid = false;
  let costState: "awaiting" | "digits" | "trailing" | null = null;
  let costBuffer = "";
  let inString = false;
  let escaped = false;
  let stringHasEscape = false;
  let stringOverflow = false;
  let stringBuffer = "";
  let invalid = false;

  const current = () => frames.at(-1);
  const startCost = () => {
    if (costSeen) {
      costInvalid = true;
      return;
    }
    costSeen = true;
    costState = "awaiting";
    costBuffer = "";
  };
  const finishCostDigits = () => {
    const candidate = Number(costBuffer);
    if (!Number.isSafeInteger(candidate) || candidate < 0) {
      costInvalid = true;
      costTicks = null;
      return;
    }
    costTicks = candidate;
  };
  const observeString = () => {
    const frame = current();
    const value = stringHasEscape || stringOverflow ? null : stringBuffer;
    if (!frame) {
      return;
    }
    if (frame.kind === "array") {
      if (frame.role === "data") {
        outputs += 1;
      }
      return;
    }
    if (frame.expectsKey) {
      frame.pendingKey = value;
      return;
    }
    if (
      frame.role === "file_output"
      && frame.key === "file_id"
      && value !== null
      && XAI_FILE_ID.test(value)
      && !fileIds.includes(value)
    ) {
      if (fileIds.length < MAX_IMAGE_OUTPUT_FILE_IDS) {
        fileIds.push(value);
      } else {
        fileIdLimitExceeded = true;
      }
    }
  };

  return {
    push(text) {
      for (const character of text) {
        if (invalid) {
          continue;
        }
        if (inString) {
          if (escaped) {
            escaped = false;
            continue;
          }
          if (character === "\\") {
            escaped = true;
            stringHasEscape = true;
            continue;
          }
          if (character === '"') {
            inString = false;
            observeString();
            continue;
          }
          if (stringBuffer.length < 256) {
            stringBuffer += character;
          } else {
            stringOverflow = true;
          }
          continue;
        }

        if (costState === "awaiting") {
          if (/\s/.test(character)) {
            continue;
          }
          if (character >= "0" && character <= "9") {
            costState = "digits";
            costBuffer = character;
            continue;
          }
          costInvalid = true;
          costState = null;
        } else if (costState === "digits") {
          if (character >= "0" && character <= "9") {
            if (costBuffer.length < 20) {
              costBuffer += character;
            } else {
              costInvalid = true;
            }
            continue;
          }
          finishCostDigits();
          if (/\s/.test(character)) {
            costState = "trailing";
            continue;
          }
          costState = null;
          if (character !== "," && character !== "}") {
            costInvalid = true;
          }
        } else if (costState === "trailing") {
          if (/\s/.test(character)) {
            continue;
          }
          costState = null;
          if (character !== "," && character !== "}") {
            costInvalid = true;
          }
        }

        if (character === '"') {
          const frame = current();
          if (costSeen && costState === null && frame?.kind === "object"
            && frame.role === "usage" && frame.key === "cost_in_usd_ticks") {
            costInvalid = true;
          }
          inString = true;
          escaped = false;
          stringHasEscape = false;
          stringOverflow = false;
          stringBuffer = "";
          continue;
        }
        if (character === "{") {
          const parent = current();
          let role: Extract<ImageJsonFrame, { kind: "object" }>["role"] = "other";
          if (!parent && !rootSeen) {
            rootSeen = true;
            role = "root";
          } else if (parent?.kind === "object" && parent.role === "root" && parent.key === "usage") {
            role = "usage";
          } else if (parent?.kind === "array" && parent.role === "data") {
            outputs += 1;
            role = "data_item";
          } else if (parent?.kind === "object" && parent.role === "data_item" && parent.key === "file_output") {
            role = "file_output";
          }
          frames.push({ kind: "object", role, key: null, pendingKey: null, expectsKey: true });
        } else if (character === "[") {
          const parent = current();
          const isData = parent?.kind === "object" && parent.role === "root" && parent.key === "data";
          if (isData) {
            dataSeen = true;
          } else if (parent?.kind === "array" && parent.role === "data") {
            outputs += 1;
          }
          frames.push({ kind: "array", role: isData ? "data" : "other" });
        } else if (character === ":") {
          const frame = current();
          if (frame?.kind === "object" && frame.expectsKey) {
            frame.key = frame.pendingKey;
            frame.pendingKey = null;
            frame.expectsKey = false;
            if (frame.role === "usage" && frame.key === "cost_in_usd_ticks") {
              startCost();
            }
          }
        } else if (character === ",") {
          const frame = current();
          if (frame?.kind === "object") {
            frame.key = null;
            frame.pendingKey = null;
            frame.expectsKey = true;
          }
        } else if (character === "}") {
          if (current()?.kind !== "object") {
            invalid = true;
          } else {
            frames.pop();
          }
        } else if (character === "]") {
          const frame = current();
          if (frame?.kind !== "array") {
            invalid = true;
          } else {
            if (frame.role === "data") {
              dataClosed = true;
            }
            frames.pop();
          }
        }
        if (frames.length > MAX_IMAGE_METADATA_DEPTH) {
          invalid = true;
        }
      }
    },
    finish() {
      if (costState === "digits") {
        finishCostDigits();
      } else if (costState === "awaiting") {
        costInvalid = true;
      }
      const complete = !invalid && !fileIdLimitExceeded && !inString && frames.length === 0 && rootSeen;
      return {
        fileIds: complete ? fileIds : [],
        outputs: complete && dataSeen && dataClosed ? outputs : null,
        costTicks: complete && costSeen && !costInvalid ? costTicks : null
      };
    }
  };
}

async function finalizeImageObservation(
  env: Env,
  userId: string,
  plan: ExecutionPlan,
  now: () => Date,
  outcome: ProxyResponseBodyOutcome,
  observation: ImageMetadataObservation
): Promise<void> {
  const ok = outcome.kind === "completed" && isSuccess(outcome.upstreamStatus);
  let bindingFailed = false;
  if (ok && plan.protocol !== "xai/api") {
    for (const fileId of observation.fileIds) {
      try {
        const bound = await bindFileId(
          env, fileId, userId, "image_output", null, now()
        );
        if (!bound) {
          throw new Error("owner collision");
        }
      } catch {
        bindingFailed = true;
        console.error(JSON.stringify({
          event: "xai_file_output_binding_failed",
          plan_id: plan.id,
          source: "image_output"
        }));
      }
    }
  }
  try {
    await recordImageMediaUsage(env, {
      user_id: userId,
      route_profile_id: plan.id,
      capability: imageCapability(plan),
      status: ok && !bindingFailed ? "ok" : "error",
      outputs: ok ? observation.outputs : null,
      provider_cost_usd_ticks: ok ? observation.costTicks : null
    }, now());
  } catch {
    console.error(JSON.stringify({ event: "image_media_accounting_failed", plan_id: plan.id }));
  }
  if (bindingFailed) {
    throw new Error("image output ownership could not be committed");
  }
}

/** Shared opaque provider forward with one terminal Provider Attempt outcome. */
async function forwardNpeWithAudit(
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
    const auditOnHeaders = plan.protocol === "xai/api" && plan.usageObserver === "none";
    const forwardOptions: ProxyForwardOptions = auditOnHeaders ? {} : {
      observeUsage: observeResponseUsage,
      completeMissingSseContentType:
        plan.responseHeaderPolicy === "complete_missing_sse_content_type",
      onResponseChunk: responseObserver?.onChunk,
      now: deps.now,
      waitUntil: (p) => ctx.waitUntil(p),
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
        const status: "ok" | "error" = cancelled || readFailed || !accepted
          ? "error"
          : "ok";
        const errorCode = cancelled
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

async function beginGrokProviderAttempt(
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
    authStyle: "bearer",
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

function isImagePlan(plan: ExecutionPlan): boolean {
  return plan.usageObserver === "image";
}

function imageCapability(plan: ExecutionPlan): "image_generation" | "image_edit" {
  return plan.id.endsWith("images_edits") ? "image_edit" : "image_generation";
}

function providerBaseUrl(plan: ExecutionPlan): string {
  if (!plan.providerBaseUrl) {
    throw new ProxyUpstreamError(500, "Plan missing provider base URL", "missing_provider_base_url", null, false);
  }
  return assertProviderBaseUrl(plan.providerBaseUrl);
}

function providerResultForBodyOutcome(outcome: ProxyResponseBodyOutcome): ProviderResult {
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
