import { forwardNpeWithAudit, beginGrokProviderAttempt } from "./provider-transport";
import { executeFileUploadPlan, executeFileOwnerPlan } from "./file-control";
import { executeVideoStartPlan, executeVideoPollPlan, createTransparentVideoPlanObserver } from "./video-control";
import { createImagePlanObserver, isImagePlan, imageCapability } from "./image-observation";
import { recordImageMediaUsage } from "./media-store";
import { type ExecutionPlan } from "../plans/execution-plans";
import { ProxyUpstreamError } from "../proxy/adapter";
import { type AuthenticatedUser } from "../auth/types";
import { type ExecutionDependencies, type RequestContext } from "../types";
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
