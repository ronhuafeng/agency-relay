/**
 * Codex (openai/codex) Execution Plan handlers.
 */
import egressProtocol from "../../deploy/codex-egress-shim/egress-protocol.json";
import {
  forwardCompact,
  forwardModels,
  forwardResponses,
  type CodexProviderTerminalOutcome
} from "./adapter";
import { HttpError } from "../errors";
import { publicExecutionPlanPath, type ExecutionPlan } from "../plans/execution-plans";
import { assertProviderBaseUrl } from "../proxy/origin";
import {
  forwardTransparentProxy,
  forwardTransparentWebSocket,
  ProxyUpstreamError,
  type ProxyUpstreamCredentials
} from "../proxy/adapter";
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
      request, env, ctx, deps, requestContext, auth, false, plan, fallbackIdentityVersion
    );
  }
  if (plan.id === "codex.responses_compact") {
    return await routeResponses(
      request, env, ctx, deps, requestContext, auth, true, plan, fallbackIdentityVersion
    );
  }
  if (
    plan.providerBaseUrl
    && (plan.mode === "transparent" || plan.mode === "websocket_transparent")
  ) {
    return await routeOpenAiDirect(request, env, ctx, deps, requestContext, auth, plan, fallbackIdentityVersion);
  }
  throw new HttpError(404, "Route not found", "invalid_request_error", "not_found");
}

async function routeOpenAiDirect(
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
  if (!plan.providerBaseUrl) {
    throw new HttpError(500, "Plan missing provider base URL", "server_error", "missing_provider_base_url");
  }
  const credentials: ProxyUpstreamCredentials = {
    baseUrl: assertProviderBaseUrl(plan.providerBaseUrl),
    accessToken: attempt.credential.accessToken,
    authStyle: "bearer",
    upstreamClientIdentity: plan.upstreamClientIdentity,
    fallbackIdentityVersion,
    ...(attempt.credential.accountId
      ? { extraHeaders: [["Chatgpt-Account-Id", attempt.credential.accountId]] }
      : {})
  };
  try {
    const response = plan.mode === "websocket_transparent"
      ? await forwardTransparentWebSocket(request, deps, credentials)
      : await forwardTransparentProxy(request, deps, credentials, request.body);
    const accepted = plan.mode === "websocket_transparent"
      ? response.status === 101
      : response.status >= 200 && response.status < 300;
    const requestStatus = accepted ? "ok" : "error";
    const completion = attempt.complete({
      requestStatus,
      providerResult: accepted ? "accepted" : "rejected",
      upstreamStatus: response.status,
      errorCode: null,
      usage: null
    });
    ctx.waitUntil(completion.then((result) => {
      logOutcome(
        deps,
        requestContext,
        auth,
        attempt.credential.physicalAccountId,
        requestStatus,
        response.status,
        route,
        undefined,
        undefined,
        result.accountingCommitted ? undefined : "request_accounting_failed"
      );
    }));
    return response;
  } catch (error) {
    if (error instanceof ProxyUpstreamError && error.attempted) {
      ctx.waitUntil(attempt.complete({
        requestStatus: "error",
        providerResult: error.upstreamStatus === null ? "transport_error" : "rejected",
        upstreamStatus: error.upstreamStatus,
        errorCode: error.code ?? null,
        usage: null
      }).then(() => undefined));
    }
    throw error;
  }
}


async function routeResponses(
  request: Request,
  env: Env,
  ctx: Pick<ExecutionContext, "waitUntil">,
  deps: ExecutionDependencies,
  requestContext: RequestContext,
  auth: AuthenticatedUser,
  compact: boolean,
  plan: ExecutionPlan,
  fallbackIdentityVersion: string | null
): Promise<Response> {
  requestContext.userId = auth.user.id;
  requestContext.apiKeyId = auth.apiKey.id;
  requestContext.sessionId = request.headers.get(CODEX_SESSION_ID_HEADER) ?? undefined;
  requestContext.threadId = request.headers.get(CODEX_THREAD_ID_HEADER) ?? undefined;
  const route = compact ? "/v1/responses/compact" : "/v1/responses";
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
  return compact
    ? await forwardCompact(request, env, deps, requestContext, freshToken, request.body, forwardOptions)
    : await forwardResponses(request, env, deps, requestContext, freshToken, request.body, forwardOptions);
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
