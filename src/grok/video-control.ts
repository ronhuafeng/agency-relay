import { MAX_PROVIDER_CONTROL_RESPONSE_BYTES, forwardProviderControl, replayProviderControlResponse, rejectAcceptedControl, acceptControlResponse, rejectedControlResponse, isSuccess, parseJsonObject, unixSecondsToIso, type NpeResponseObserver, beginGrokProviderAttempt } from "./provider-transport";
import { XAI_FILE_ID, bindFileId } from "./file-ownership";
import { hmacSha256Hex } from "../crypto";
import { asRecord, nonNegativeIntegerOrNull } from "../records";
import { createVideoJob, findVideoJobForUser, observeVideoJob, recordUntrackedVideoStart } from "./media-store";
import { HttpError } from "../errors";
import { XAI_OBJECT_ID, type ExecutionPlan } from "../plans/execution-plans";
import { copyBytes } from "../proxy/byte-stream";
import { ProxyUpstreamError } from "../proxy/adapter";
import { type AuthenticatedUser } from "../auth/types";
import { type ExecutionDependencies, type RequestContext } from "../types";

const VIDEO_REQUEST_ID = new RegExp(`^${XAI_OBJECT_ID}$`);

export async function executeVideoStartPlan(
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

  const rejected = rejectedControlResponse(attempt, upstream, bytes);
  if (rejected) return rejected;

  const requestId = parseVideoStartRequestId(bytes);
  if (!requestId) {
    rejectAcceptedControl(attempt, upstream, "video_start_response_invalid", "Provider returned an invalid video start response");
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

  return acceptControlResponse(attempt, upstream, bytes);
}

export async function executeVideoPollPlan(
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
    throw videoJobNotFound();
  }

  // Resolve on every poll so silent refresh and reauthorization state remain live.
  const { attempt, credentials } = await beginGrokProviderAttempt(
    env, ctx, deps, requestContext, auth, plan, fallbackIdentityVersion
  );
  const { upstream, bytes } = await forwardProviderControl(
    request, deps, credentials, attempt
  );

  const rejected = rejectedControlResponse(attempt, upstream, bytes);
  if (rejected) return rejected;

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

function parseVideoStartRequestId(bytes: Uint8Array): string | null {
  const value = parseJsonObject(bytes);
  const requestId = value?.request_id;
  return typeof requestId === "string" && VIDEO_REQUEST_ID.test(requestId) ? requestId : null;
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
  const video = asRecord(value.video);
  const duration = video?.duration;
  const videoSeconds = typeof duration === "number" && Number.isFinite(duration) && duration >= 0
    ? duration
    : null;
  const outputUrl = video?.url;
  const fileOutput = asRecord(video?.file_output);
  const fileId = fileOutput?.file_id;
  const usage = asRecord(value.usage);
  const providerCost = usage?.cost_in_usd_ticks;
  return {
    status,
    videoSeconds,
    outputs: status === "done" && typeof outputUrl === "string" && outputUrl.length > 0 ? 1 : null,
    model: typeof value.model === "string" && value.model.length <= 200 ? value.model : null,
    fileIds: typeof fileId === "string" && XAI_FILE_ID.test(fileId) ? [fileId] : [],
    costTicks: nonNegativeIntegerOrNull(providerCost),
    expiresAt: unixSecondsToIso(fileOutput?.expires_at)
  };
}

function videoJobNotFound(): HttpError {
  return new HttpError(404, "Video job not found", "invalid_request_error", "video_job_not_found");
}

function videoRequestIdFromPath(request: Request): string {
  const requestId = new URL(request.url).pathname.slice("/v1/videos/".length);
  if (!VIDEO_REQUEST_ID.test(requestId)) {
    throw videoJobNotFound();
  }
  return requestId;
}

async function videoRequestIdHash(env: Env, requestId: string): Promise<string> {
  return await hmacSha256Hex(env.API_KEY_HASH_PEPPER, `video-job:v1:${requestId}`);
}

export function createTransparentVideoPlanObserver(
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
      return copyBytes(chunks, total);
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
