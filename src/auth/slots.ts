/**
 * Current Credential Slot resolution.
 * Slot is a code-owned plan reference — not a D1 table or pool.
 * Model traffic never bootstraps from Worker Secrets.
 */
import { credentialAccountId, getApiKeySurfaceCredential } from "./bindings";
import { getCodexAuth } from "../db";
import { HttpError } from "../errors";
import {
  getSubscriptionAccount,
  type CapabilitySource
} from "./subscription-accounts";
import type { TokenAuthority } from "./token-authority";
import { readTokenResult } from "./token-result";
import {
  slotSourceEnvironment,
  type CredentialSlotId
} from "../plans/execution-plans";

export interface SlotAccountMetadata {
  status: string;
  capability_source?: string;
  environment?: string;
}

/** The same pre-token metadata boundary is used by admission and member reads. */
export function assertSlotAccountMetadata(slot: CredentialSlotId, account: SlotAccountMetadata | null): asserts account is SlotAccountMetadata {
  const { source, environment } = slotSourceEnvironment(slot);
  if (!account) throw new HttpError(503, source === "chatgpt" ? "Bound ChatGPT Credential Account does not exist" : "Bound Subscription Account does not exist", "server_error", "missing_credential_account");
  if (source !== "chatgpt" && (account.capability_source !== source || account.environment !== environment)) {
    throw new HttpError(500, "Bound Subscription Account is incompatible", "server_error", "invalid_credential_binding");
  }
  if (account.status === "reauth_required") throw new HttpError(401, source === "chatgpt" ? "ChatGPT credential requires reauthorization" : "Subscription requires reauthorization", "authentication_error", "reauth_required");
  if (source === "chatgpt" ? account.status !== "active" : ["revoked", "disabled", "pending_credential"].includes(account.status)) {
    throw new HttpError(401, source === "chatgpt" ? "ChatGPT Credential Account is not active" : "Subscription account is not active", "authentication_error", source === "chatgpt" ? "credential_inactive" : "subscription_inactive");
  }
}

export interface ResolvedSlotCredential {
  accessToken: string;
  accountId?: string;
  /** Bound physical ChatGPT or Grok Credential Account id. */
  physicalAccountId: string;
  credentialSlot: CredentialSlotId;
  source: CapabilitySource;
  environment: "staging" | "production";
}

export async function resolveCredentialSlot(
  env: Env,
  slot: CredentialSlotId,
  input: { apiKeyId: string; surfaceGrant: string }
): Promise<ResolvedSlotCredential> {
  const { source, environment } = slotSourceEnvironment(slot);
  const binding = await getApiKeySurfaceCredential(env, input.apiKeyId, input.surfaceGrant);
  if (!binding) {
    throw new HttpError(
      503,
      "API key has no Credential Account binding for this Surface",
      "server_error",
      "missing_credential_binding"
    );
  }
  const physicalAccountId = credentialAccountId(binding, slot);

  if (source === "chatgpt") {
    const account = await getCodexAuth(env, physicalAccountId);
    assertSlotAccountMetadata(slot, account);
    const fresh = readTokenResult(await env.TOKEN_AUTHORITY
      .get(env.TOKEN_AUTHORITY.idFromName(physicalAccountId))
      .getFreshAccessToken());
    return {
      accessToken: fresh.access_token,
      ...(fresh.account_id ? { accountId: fresh.account_id } : {}),
      physicalAccountId,
      credentialSlot: slot,
      source,
      environment
    };
  }

  const account = await getSubscriptionAccount(env, physicalAccountId).catch(() => null);
  assertSlotAccountMetadata(slot, account);

  try {
    const fresh = readTokenResult(await subscriptionTokenAuthority(env, account.id).getFreshSubscriptionCredential());
    return {
      accessToken: fresh.access_token,
      physicalAccountId,
      credentialSlot: slot,
      source,
      environment,
      ...(fresh.account_ref ? { accountId: fresh.account_ref } : {})
    };
  } catch (error) {
    if (error instanceof HttpError && error.code === "missing_subscription_credential") {
      throw new HttpError(
        503,
        "Credential Slot has no encrypted token; import via admin",
        "server_error",
        "missing_subscription_credential"
      );
    }
    throw error;
  }
}

function subscriptionTokenAuthority(env: Env, accountId: string): DurableObjectStub<TokenAuthority> {
  return env.TOKEN_AUTHORITY.get(env.TOKEN_AUTHORITY.idFromName(`subscription:${accountId}`));
}
