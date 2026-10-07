/**
 * Deep Module for Provider Attempt admission and terminal completion.
 * Callers receive one provider credential and report one terminal outcome;
 * this Module owns gate order, account identity, persistence order,
 * exactly-once scheduling, failure isolation, and Subscription Account stamps.
 */
import { generateId } from "../crypto";
import { resolveCredentialSlot } from "./slots";
import { commitProviderAttemptAccounting } from "../db";
import { publicExecutionPlanPath, type ExecutionPlan } from "../plans/execution-plans";
import { planAuditFields } from "../plans/audit";
import { stampSubscriptionProviderAttempt } from "./subscription-accounts";
import { consumeExecutionPlanCredits } from "./credits";
import type { AuthenticatedUser, CapturedResponseUsage, RequestContext } from "../types";

export type ProviderResult = "accepted" | "rejected" | "transport_error";

export interface ProviderAttemptOutcome {
  requestStatus: "ok" | "error";
  providerResult: ProviderResult;
  upstreamStatus: number | null;
  errorCode: string | null;
  resolvedModel?: string | null;
  usage?: CapturedResponseUsage | null;
}

export interface ProviderAttemptCommitResult {
  accountingCommitted: boolean;
  subscriptionStamped: boolean | null;
}

export interface AdmittedProviderAttempt {
  readonly credential: {
    readonly accessToken: string;
    readonly accountId?: string;
    /** Metadata identity only. Never send this Mini-owned id upstream. */
    readonly physicalAccountId: string;
  };
  readonly timing: ProviderAttemptAdmissionTiming;
  complete(outcome: ProviderAttemptOutcome): Promise<ProviderAttemptCommitResult>;
}

export interface ProviderAttemptAdmissionTiming {
  readonly auth_ms: number | null;
  readonly credential_slot_ms: number;
  readonly credit_admission_ms: number;
  readonly request_to_admission_ms: number;
}

/**
 * Resolve the Execution Plan Credential Slot, atomically admit its Surface
 * Credit charge, and bind the resulting physical account to one terminal
 * Provider Attempt lifecycle. No provider request can precede this gate.
 */
export async function admitProviderAttempt(input: {
  env: Env;
  ctx: Pick<ExecutionContext, "waitUntil">;
  now: () => Date;
  requestContext: RequestContext;
  auth: AuthenticatedUser;
  plan: ExecutionPlan;
}): Promise<AdmittedProviderAttempt> {
  const credentialStartedAt = input.now().getTime();
  const slot = await resolveCredentialSlot(input.env, input.plan.credentialSlot, {
    apiKeyId: input.auth.apiKey.id,
    surfaceGrant: input.plan.surfaceGrant
  });
  const credentialCompletedAt = input.now().getTime();
  await consumeExecutionPlanCredits(
    input.env,
    input.auth.user.id,
    input.plan,
    new Date(input.requestContext.startedAt)
  );
  const admittedAt = input.now().getTime();

  const lifecycle = createProviderAttemptLifecycle({
    ...input,
    physicalAccountId: slot.physicalAccountId
  });
  return {
    credential: {
      accessToken: slot.accessToken,
      ...(slot.accountId ? { accountId: slot.accountId } : {}),
      physicalAccountId: slot.physicalAccountId
    },
    timing: {
      auth_ms: input.requestContext.authCompletedAt === undefined
        ? null
        : elapsedMs(input.requestContext.authCompletedAt, input.requestContext.startedAt),
      credential_slot_ms: elapsedMs(credentialCompletedAt, credentialStartedAt),
      credit_admission_ms: elapsedMs(admittedAt, credentialCompletedAt),
      request_to_admission_ms: elapsedMs(admittedAt, input.requestContext.startedAt)
    },
    complete: lifecycle.complete
  };
}

function elapsedMs(completedAt: number, startedAt: number): number {
  return Math.max(0, completedAt - startedAt);
}

function createProviderAttemptLifecycle(input: {
  env: Env;
  ctx: Pick<ExecutionContext, "waitUntil">;
  now: () => Date;
  requestContext: RequestContext;
  auth: AuthenticatedUser;
  plan: ExecutionPlan;
  physicalAccountId?: string | null;
}): Pick<AdmittedProviderAttempt, "complete"> {
  let completion: Promise<ProviderAttemptCommitResult> | undefined;
  let terminalFingerprint: string | undefined;

  return {
    complete(outcome) {
      const fingerprint = JSON.stringify(outcome);
      if (completion) {
        if (fingerprint !== terminalFingerprint) {
          console.error(JSON.stringify({
            event: "provider_attempt_conflict",
            plan_id: input.plan.id
          }));
        }
        return completion;
      }

      terminalFingerprint = fingerprint;
      completion = commitTerminalOutcome(input, outcome);
      input.ctx.waitUntil(completion);
      return completion;
    }
  };
}

async function commitTerminalOutcome(
  input: {
    env: Env;
    now: () => Date;
    requestContext: RequestContext;
    auth: AuthenticatedUser;
    plan: ExecutionPlan;
    physicalAccountId?: string | null;
  },
  outcome: ProviderAttemptOutcome
): Promise<ProviderAttemptCommitResult> {
  const completedAt = input.now();
  const accountingAt = new Date(input.requestContext.startedAt);
  const codexAuthId = input.plan.credentialSlot.startsWith("chatgpt")
    ? input.physicalAccountId ?? null
    : null;
  const usage = input.plan.usageObserver === "responses"
    ? outcome.usage ?? null
    : null;

  let accountingCommitted = true;
  try {
    await commitProviderAttemptAccounting(input.env, {
      audit_id: generateId("audit"),
      request_id: input.requestContext.requestId,
      route_profile_id: input.plan.id,
      route: publicExecutionPlanPath(input.plan),
      user_id: input.auth.user.id,
      key_id: input.auth.apiKey.id,
      codex_auth_id: codexAuthId,
      status: outcome.requestStatus,
      upstream_status: outcome.upstreamStatus,
      error_code: outcome.errorCode,
      session_id: input.requestContext.sessionId ?? null,
      thread_id: input.requestContext.threadId ?? null,
      latency_ms: Math.max(0, completedAt.getTime() - input.requestContext.startedAt),
      usage_observer: input.plan.usageObserver,
      usage_capture: usage,
      ...planAuditFields(input.plan, {
        physicalAccountId: input.physicalAccountId,
        resolvedModel: outcome.resolvedModel ?? usage?.model ?? null
      })
    }, accountingAt);
  } catch {
    accountingCommitted = false;
    console.error(JSON.stringify({
      event: "request_accounting_failed",
      plan_id: input.plan.id
    }));
  }

  const accountId = input.physicalAccountId;
  if (!accountId || input.plan.credentialSlot.startsWith("chatgpt")) {
    return { accountingCommitted, subscriptionStamped: null };
  }

  let subscriptionStamped = true;
  try {
    await stampSubscriptionProviderAttempt(
      input.env,
      accountId,
      outcome.providerResult === "accepted" ? "success" : "failure",
      completedAt
    );
  } catch {
    subscriptionStamped = false;
    console.error(JSON.stringify({
      event: "subscription_attempt_metadata_failed",
      plan_id: input.plan.id
    }));
  }
  return { accountingCommitted, subscriptionStamped };
}
