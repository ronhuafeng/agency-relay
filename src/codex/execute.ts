/**
 * Codex (openai/codex) Execution Plan handlers.
 */
import egressProtocol from "../../deploy/codex-egress-shim/egress-protocol.json";
import {
  forwardCodexChatGptBackend,
  forwardModels,
  forwardResponses,
  type CodexChatGptBackendPath,
  type CodexProviderTerminalOutcome
} from "./adapter";
import { HttpError } from "../errors";
import { publicExecutionPlanPath, type ExecutionPlan } from "../plans/execution-plans";
import { admitProviderAttempt, type AdmittedProviderAttempt } from "../auth/provider-attempt";
import type {
  AuthenticatedUser,
  CodexTransportObservation,
  ExecutionDependencies,
  RequestContext
} from "../types";
import { requireFallbackIdentityVersion } from "../plans/identity-version";

const CODEX_SESSION_ID_HEADER = "session-id";
const CODEX_THREAD_ID_HEADER = "thread-id";

export async function executeCodexPlan(
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
  // The plan selects one ChatGPT Credential Slot. The caller key and Surface select its account.
  if (plan.id === "codex.models") {
    const attempt = await admitProviderAttempt({
      env, ctx, now: deps.now, requestContext, auth, plan
    });
    return await forwardModels(request, env, deps, {
      access_token: attempt.credential.accessToken,
      ...(attempt.credential.accountId ? { account_id: attempt.credential.accountId } : {})
    }, {
      upstreamClientIdentity: plan.upstreamClientIdentity,
      fallbackIdentityVersion,
      onTerminal: (outcome) => completeCodexProviderAttempt(attempt, outcome)
    });
  }
  if (plan.id === "codex.responses") {
    return await routeResponses(
      request, env, ctx, deps, requestContext, auth, plan, fallbackIdentityVersion
    );
  }
  const chatGptBackendPath = chatGptBackendEgressPath(plan.id);
  if (chatGptBackendPath) {
    return await routeChatGptBackend(
      request, env, ctx, deps, requestContext, auth, plan, fallbackIdentityVersion, chatGptBackendPath
    );
  }
  // Codex plans do not select api.openai.com. Unproven public API speech and
  // Realtime/Live WebSocket routes are absent, so they never reach this function.
  throw new HttpError(404, "Route not found", "invalid_request_error", "not_found");
}

const CHATGPT_BACKEND_EGRESS = {
  "codex.audio_transcriptions": "/transcribe",
  "codex.realtime_calls": "/realtime/calls",
  "codex.live": "/live"
} as const satisfies Record<string, CodexChatGptBackendPath>;

function chatGptBackendEgressPath(planId: string): CodexChatGptBackendPath | null {
  return CHATGPT_BACKEND_EGRESS[planId as keyof typeof CHATGPT_BACKEND_EGRESS] ?? null;
}

async function routeChatGptBackend(
  request: Request,
  env: Env,
  ctx: Pick<ExecutionContext, "waitUntil">,
  deps: ExecutionDependencies,
  requestContext: RequestContext,
  auth: AuthenticatedUser,
  plan: ExecutionPlan,
  fallbackIdentityVersion: string | null,
  path: CodexChatGptBackendPath
): Promise<Response> {
  requestContext.userId = auth.user.id;
  requestContext.apiKeyId = auth.apiKey.id;
  requestContext.sessionId = request.headers.get(CODEX_SESSION_ID_HEADER) ?? undefined;
  requestContext.threadId = request.headers.get(CODEX_THREAD_ID_HEADER) ?? undefined;
  const attempt = await admitProviderAttempt({
    env, ctx, now: deps.now, requestContext, auth, plan
  });
  return await forwardCodexChatGptBackend(request, env, deps, requestContext, {
    access_token: attempt.credential.accessToken,
    ...(attempt.credential.accountId ? { account_id: attempt.credential.accountId } : {})
  }, path, request.body, {
    upstreamClientIdentity: plan.upstreamClientIdentity,
    fallbackIdentityVersion,
    onTerminal: (outcome) => {
      if (!outcome.attempted) {
        return;
      }
      const completion = completeCodexProviderAttempt(attempt, outcome);
      ctx.waitUntil(completion.then((result) => {
        logOutcome(
          deps,
          requestContext,
          auth,
          attempt.credential.physicalAccountId,
          outcome.requestStatus,
          outcome.upstreamStatus,
          publicExecutionPlanPath(plan),
          undefined,
          undefined,
          result.accountingCommitted ? undefined : "request_accounting_failed"
        );
      }));
    }
  });
}

async function routeResponses(
  request: Request,
  env: Env,
  ctx: Pick<ExecutionContext, "waitUntil">,
  deps: ExecutionDependencies,
  requestContext: RequestContext,
  auth: AuthenticatedUser,
  plan: ExecutionPlan,
  fallbackIdentityVersion: string | null
): Promise<Response> {
  requestContext.userId = auth.user.id;
  requestContext.apiKeyId = auth.apiKey.id;
  requestContext.sessionId = request.headers.get(CODEX_SESSION_ID_HEADER) ?? undefined;
  requestContext.threadId = request.headers.get(CODEX_THREAD_ID_HEADER) ?? undefined;
  const route = publicExecutionPlanPath(plan);
  const attempt = await admitProviderAttempt({
    env, ctx, now: deps.now, requestContext, auth, plan
  });
  const onTerminal = (outcome: CodexProviderTerminalOutcome) => {
    if (!outcome.attempted) {
      return;
    }
    const completion = completeCodexProviderAttempt(attempt, outcome);
    ctx.waitUntil(completion.then((result) => {
      logOutcome(
        deps,
        requestContext,
        auth,
        attempt.credential.physicalAccountId,
        outcome.requestStatus,
        outcome.upstreamStatus,
        route,
        outcome.errorCode ?? undefined,
        outcome.observation,
        result.accountingCommitted ? undefined : "request_accounting_failed"
      );
    }));
  };

  const freshToken = {
    access_token: attempt.credential.accessToken,
    ...(attempt.credential.accountId ? { account_id: attempt.credential.accountId } : {})
  };
  const forwardOptions = {
    onTerminal,
    upstreamClientIdentity: plan.upstreamClientIdentity,
    fallbackIdentityVersion,
    waitUntil: (promise: Promise<void>) => ctx.waitUntil(promise)
  };
  return await forwardResponses(request, env, deps, requestContext, freshToken, request.body, forwardOptions);
}

function completeCodexProviderAttempt(
  attempt: AdmittedProviderAttempt,
  outcome: CodexProviderTerminalOutcome
) {
  return attempt.complete({
    requestStatus: outcome.requestStatus,
    providerResult: outcome.providerResult,
    upstreamStatus: outcome.upstreamStatus,
    errorCode: outcome.errorCode,
    usage: outcome.usage
  });
}

function logOutcome(
  deps: ExecutionDependencies,
  requestContext: RequestContext,
  auth: AuthenticatedUser,
  canonicalCodexAuthId: string | null,
  status: "ok" | "error",
  upstreamStatus: number | null,
  route: string,
  errorCode?: string,
  observation?: CodexTransportObservation,
  accountingErrorCode?: "request_accounting_failed"
): void {
  const latencyMs = deps.now().getTime() - requestContext.startedAt;
  const observationStatus = accountingErrorCode
    ? "error"
    : observation?.observation_status ?? "skipped";
  const observationErrorCode = accountingErrorCode
    ?? observation?.observation_error_code
    ?? null;
  const observationStage = accountingErrorCode
    ? "request_accounting"
    : observation?.observation_stage ?? "upstream_fetch";
  const contentEncoding = observation?.content_encoding ?? null;

  const outcome = {
    event: egressProtocol.transportTrace.events.workerOutcome,
    schema_version: egressProtocol.transportTrace.schemaVersion,
    request_id: requestContext.requestId,
    route,
    user_id: auth.user.id,
    key_id: auth.apiKey.id,
    codex_auth_id: canonicalCodexAuthId,
    status,
    upstream_status: upstreamStatus,
    error_code: errorCode ?? null,
    session_id: requestContext.sessionId ?? null,
    thread_id: requestContext.threadId ?? null,
    latency_ms: latencyMs,
    usage_captured: observation?.usage_captured ?? false,
    ...(observation ?? {}),
    observation_status: observationStatus,
    observation_error_code: observationErrorCode,
    observation_stage: observationStage,
    content_encoding: contentEncoding
  };
  const allowlistedOutcome = Object.fromEntries(
    egressProtocol.transportTrace.eventFields.workerOutcome
      .filter((field) => Object.hasOwn(outcome, field))
      .map((field) => [field, outcome[field as keyof typeof outcome]])
  );
  console.log(JSON.stringify(allowlistedOutcome));
}
