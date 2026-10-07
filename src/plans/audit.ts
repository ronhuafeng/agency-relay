/**
 * Shared attempt-audit field projection for Execution Plans.
 * K3: keep router thin by housing plan audit helpers outside router.ts.
 */
import type { ExecutionPlan } from "./execution-plans";
import type { RouteDecisionAuditFields } from "../db";

export function planAuditFields(
  plan: ExecutionPlan,
  outcome: {
    physicalAccountId?: string | null;
    resolvedModel?: string | null;
  } = {}
): RouteDecisionAuditFields {
  return {
    ingress_profile_id: plan.id,
    ingress_protocol: plan.protocol,
    resolved_model: outcome.resolvedModel ?? null,
    capability_source: capabilitySourceForSlot(plan.credentialSlot),
    subscription_account_id: outcome.physicalAccountId ?? null,
    egress_profile_id: plan.credentialSlot
  };
}

export function subscriptionKindForPlan(plan: ExecutionPlan): "official_chatgpt" | "official_grok" {
  if (plan.credentialSlot.startsWith("chatgpt")) {
    return "official_chatgpt";
  }
  return "official_grok";
}

function capabilitySourceForSlot(slot: string): string {
  if (slot.startsWith("chatgpt")) {
    return "chatgpt";
  }
  return "grok";
}
