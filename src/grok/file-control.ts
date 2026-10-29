import { forwardProviderControl, rejectAcceptedControl, acceptControlResponse, rejectedControlResponse, failAttemptedProxy, isSuccess, beginGrokProviderAttempt, providerResultForBodyOutcome } from "./provider-transport";
import { xaiFileNotFound, xaiFileIdFromPath, xaiFileIdHash, bindFileId, parseXaiFileMetadata } from "./file-ownership";
import { deleteXaiFileOwner, findXaiFileOwner } from "./media-store";
import { type ExecutionPlan } from "../plans/execution-plans";
import { forwardTransparentProxy } from "../proxy/adapter";
import { type AuthenticatedUser } from "../auth/types";
import { type ExecutionDependencies, type RequestContext } from "../types";

export async function executeFileUploadPlan(
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
  const file = parseXaiFileMetadata(bytes);
  if (!file || !await bindFileId(
    env, file.fileId, auth.user.id, "upload", file.expiresAt, deps.now()
  )) {
    rejectAcceptedControl(attempt, upstream, "xai_file_binding_failed", "Provider file could not be bound to the caller");
  }
  return acceptControlResponse(attempt, upstream, bytes);
}

export async function executeFileOwnerPlan(
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
    throw xaiFileNotFound();
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
    failAttemptedProxy(attempt, error);
    throw error;
  }
}
