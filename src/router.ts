/**
 * Thin request entry: hostname → auth → Execution Plan → codex/grok execute or admin.
 * K3: admin / execute-codex / execute-grok live in separate modules (no plugin registry).
 */
import { authenticateEndUser } from "./auth/authenticate";
import { cleanupRequestAudit, cleanupVideoJobs } from "./db";
import { HttpError, jsonResponse } from "./errors";
import { adoptIdentityVersions, IDENTITY_VERSION_CRON } from "./plans/identity-version";
import { executeCodexPlan } from "./codex/execute";
import { executeGrokPlan } from "./grok/execute";
import {
  matchExecutionPlan,
  plansForHostname,
  type ExecutionPlan
} from "./plans/execution-plans";
import {
  hasReservedCredentialQuery,
  renderPlanError,
  routeProfilePolicyRejection
} from "./proxy/protocol";
import { isAdminSurface, routeAdmin } from "./admin/http";
import type { AppDependencies, ExecutionDependencies, RequestContext } from "./types";

export async function handleRequest(
  request: Request,
  env: Env,
  ctx: Pick<ExecutionContext, "waitUntil">,
  deps: ExecutionDependencies = defaultDependencies()
): Promise<Response> {
  const requestContext: RequestContext = {
    requestId: request.headers.get("X-Client-Request-Id") || crypto.randomUUID(),
    startedAt: deps.now().getTime()
  };
  let plan: ExecutionPlan | undefined;
  let surfaceProbe: ExecutionPlan | undefined;

  try {
    const url = new URL(request.url);

    if (url.pathname === "/healthz" && request.method === "GET") {
      return jsonResponse({ ok: true, service: "mini-proxy-core", kind: "liveness" });
    }

    if (isAdminSurface(request, url, env)) {
      return await routeAdmin(request, env, url, deps, requestContext);
    }

    // Current invariant: host → auth → exact plan match; unknown hosts fail before auth.
    const hostPlans = plansForHostname(url.hostname);
    if (!hostPlans) {
      throw new HttpError(404, "Route not found", "invalid_request_error", "not_found");
    }
    surfaceProbe = hostPlans[0]!;
    const auth = await authenticateEndUser(request, env, ctx, {
      requiredSurfaceGrant: surfaceProbe.surfaceGrant
    }, deps.now());
    requestContext.authCompletedAt = deps.now().getTime();

    const matched = matchExecutionPlan(request, hostPlans);
    if (!matched) {
      const pathKnown = hostPlans.some((p) => {
        const path = typeof p.pathname === "string" ? p.pathname : null;
        return path === url.pathname || (p.pathname instanceof RegExp && p.pathname.test(url.pathname));
      });
      return await routeProfilePolicyRejection(
        request,
        auth,
        { id: surfaceProbe.id, protocol: surfaceProbe.protocol },
        pathKnown ? "method_not_allowed" : "path_not_allowed",
        pathKnown ? 405 : 404,
        pathKnown ? [...new Set(hostPlans.filter((p) => {
          return typeof p.pathname === "string"
            ? p.pathname === url.pathname
            : p.pathname.test(url.pathname);
        }).map((p) => p.method))].join(", ") : undefined
      );
    }
    plan = matched;

    // A2: reserved credential query names rejected on every surface after auth+grant.
    if (hasReservedCredentialQuery(url)) {
      return await routeProfilePolicyRejection(
        request,
        auth,
        { id: plan.id, protocol: plan.protocol },
        "query_credential_not_allowed",
        400
      );
    }

    if (plan.mode === "websocket_426") {
      throw new HttpError(
        426,
        "Responses WebSocket transport is not supported; retry with HTTP Responses",
        "invalid_request_error",
        "responses_websocket_not_supported",
        { headers: new Headers({ Upgrade: "websocket" }) }
      );
    }

    if (plan.protocol === "openai/codex") {
      return await executeCodexPlan(request, env, ctx, deps, requestContext, auth, plan);
    }

    return await executeGrokPlan(request, env, ctx, deps, requestContext, auth, plan);
  } catch (error) {
    const protoSource = plan ?? surfaceProbe;
    return renderPlanError(protoSource?.protocol ?? "openai/codex", error, requestContext.requestId);
  }
}

export function handleScheduled(
  controller: ScheduledController,
  env: Env,
  ctx: Pick<ExecutionContext, "waitUntil">,
  deps: AppDependencies = defaultDependencies()
): void {
  if (controller.cron === IDENTITY_VERSION_CRON) {
    const adoption = adoptIdentityVersions(env, deps.fetch)
      .then((result) => {
        console.log(JSON.stringify({
          trigger: "scheduled_identity_version",
          cron: controller.cron,
          scheduled_time: new Date(controller.scheduledTime).toISOString(),
          ...result
        }));
      })
      .catch((error) => {
        console.error(JSON.stringify({
          trigger: "scheduled_identity_version_failed",
          cron: controller.cron,
          error: error instanceof Error ? error.message : "unknown"
        }));
      });
    ctx.waitUntil(adoption);
    return;
  }
  const cleanup = runRetentionCleanup(env, deps)
    .then((result) => {
      console.log(JSON.stringify({
        trigger: "scheduled_retention_cleanup",
        cron: controller.cron,
        scheduled_time: new Date(controller.scheduledTime).toISOString(),
        request_audit_deleted: result.request_audit_deleted,
        video_jobs_deleted: result.video_jobs_deleted,
        retention_days: result.retention_days,
        cutoff: result.cutoff
      }));
    })
    .catch((error) => {
      console.error(JSON.stringify({
        trigger: "scheduled_retention_cleanup_failed",
        cron: controller.cron,
        error: error instanceof Error ? error.message : "unknown"
      }));
    });
  ctx.waitUntil(cleanup);
}

function defaultDependencies(): ExecutionDependencies {
  return {
    // Bind via wrapper: method-style deps.fetch(...) must not rely on
    // fetching through a detached global fetch reference.
    fetch: (input, init) => globalThis.fetch(input, init),
    now: () => new Date()
  };
}

async function runRetentionCleanup(
  env: Env,
  deps: AppDependencies
): Promise<{
  request_audit_deleted: number;
  video_jobs_deleted: number;
  retention_days: number;
  cutoff: string;
}> {
  const retentionDays = configuredRetentionDays(env);
  const cutoff = new Date(deps.now().getTime() - retentionDays * 24 * 60 * 60 * 1000).toISOString();
  const [requestAuditDeleted, videoJobsDeleted] = await Promise.all([
    cleanupRequestAudit(env, cutoff),
    cleanupVideoJobs(env, cutoff)
  ]);
  return {
    request_audit_deleted: requestAuditDeleted,
    video_jobs_deleted: videoJobsDeleted,
    retention_days: retentionDays,
    cutoff
  };
}

function configuredRetentionDays(env: Env): number {
  const raw = env.REQUEST_AUDIT_RETENTION_DAYS;
  if (!/^[1-9]\d*$/.test(raw)) {
    throw new HttpError(500, "REQUEST_AUDIT_RETENTION_DAYS must be an integer from 1 to 3650", "server_error", "invalid_request_audit_retention_days");
  }
  const parsed = Number(raw);
  if (parsed > 3650) {
    throw new HttpError(500, "REQUEST_AUDIT_RETENTION_DAYS must be an integer from 1 to 3650", "server_error", "invalid_request_audit_retention_days");
  }
  return parsed;
}
