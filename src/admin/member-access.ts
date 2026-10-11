import { listMemberKeys, type PublicApiKey } from "../auth/api-keys";
import { keyIsLive } from "../auth/key-state";
import { listSurfaceCreditStates, type SurfaceCreditState } from "../auth/credits";
import { replacementCredentialMetadataUsable, defaultCredentialMetadataUsable, type OrganizationSurface } from "../auth/credential-defaults";
import { assertSlotAccountMetadata, type SlotAccountMetadata } from "../auth/slots";
import { listExecutionPlans } from "../plans/execution-plans";
import { queryClientVerification, type KeyClientVerificationRow } from "../db";

export type ReadFact<T> = { known: true; value: T } | { known: false };
export type MemberSurface = "codex" | "grok" | "xai";
export type Entitlement = "eligible" | "zero" | "disabled" | "unconfigured" | "unknown";
export type DefaultCondition = "configured" | "missing" | "unavailable" | "unknown";
export interface MemberSurfaceFact {
  id: MemberSurface;
  quota: ReadFact<SurfaceCreditState>;
  entitlement: Entitlement;
  default: DefaultCondition;
  existing: ReadFact<{ total: number; live: number; metadataReady: number; metadataUnknown: number }>;
  reason: "unknown" | "unconfigured" | "disabled" | "zero" | "exhausted" | "no-key" | "default-unavailable" | "default-unknown" | "expired" | "binding-unavailable" | "binding-unknown" | "metadata-ready";
}
export interface MemberKeyFact {
  key: PublicApiKey;
  bindings: Array<{ surface: MemberSurface; state: "ready" | "missing" | "unavailable" | "unknown" }>;
  replacement: { allowed: boolean | null; reason: "revoked" | "scope" | "policy" | "binding" | "family" | "unknown" | null };
  family: { id: string | null; liveSecrets: number; relatives: Array<{ id: string; prefix: string; state: string }> };
  tasks: ReadFact<KeyClientVerificationRow[]>;
}
export interface MemberAccessModel {
  keys: ReadFact<MemberKeyFact[]>;
  surfaces: MemberSurfaceFact[];
  liveFamilies: number | null;
  canCreate: boolean;
  asOf: string;
}
interface BindingRow { api_key_id: string; surface_grant: string; codex_auth_id: string | null; subscription_account_id: string | null }
interface DefaultRow { surface_grant: string; codex_auth_id: string | null; subscription_account_id: string | null }
interface AccountMetadata extends SlotAccountMetadata { kind?: string }
const surfaces: MemberSurface[] = ["codex", "grok", "xai"];
const grant = (surface: MemberSurface): OrganizationSurface => `surface:${surface}:production`;
const surfaceOf = (scope: string): MemberSurface | null => surfaces.find(surface => scope === grant(surface)) ?? null;
const unknown = { known: false } as const;
async function read<T>(operation: () => Promise<T>): Promise<ReadFact<T>> {
  try { return { known: true, value: await operation() }; } catch { return unknown; }
}
function entitlement(state: SurfaceCreditState | undefined): Entitlement {
  if (!state) return "unknown";
  if (state.source === "unconfigured") return "unconfigured";
  if (state.mode === "disabled") return "disabled";
  return state.mode === "unlimited" || (state.monthly_allowance ?? 0) > 0 ? "eligible" : "zero";
}

/** No provider requests or token refreshes. Each independent read owns its failure. */
export async function readMemberAccess(env: Env, userId: string, now: Date): Promise<MemberAccessModel> {
  const [inventory, quotas, defaults, bindings] = await Promise.all([
    read(() => listMemberKeys(env, userId, now)),
    read(() => listSurfaceCreditStates(env, now, userId)),
    read(async () => (await env.DB.prepare("SELECT surface_grant, codex_auth_id, subscription_account_id FROM organization_surface_credential_defaults").all<DefaultRow>()).results),
    read(async () => (await env.DB.prepare(`SELECT b.api_key_id, b.surface_grant, b.codex_auth_id, b.subscription_account_id
      FROM api_key_surface_credentials AS b JOIN api_keys AS k ON k.id = b.api_key_id WHERE k.user_id = ?`).bind(userId).all<BindingRow>()).results)
  ]);
  // Cache account metadata by physical identity across old bindings and defaults.
  // A failed Codex read cannot erase a known Grok key or its revoke/rename controls.
  const accounts = new Map<string, Promise<ReadFact<AccountMetadata | null>>>();
  const account = (surface: MemberSurface, id: string) => {
    const kind = surface === "codex" ? "codex" : "grok";
    const key = `${kind}:${id}`;
    let pending = accounts.get(key);
    if (!pending) {
      pending = read(() => env.DB.prepare(kind === "codex"
        ? "SELECT status, kind, environment, admission_state FROM codex_auths WHERE id = ?"
        : "SELECT status, capability_source, environment FROM subscription_accounts WHERE id = ?").bind(id).first<AccountMetadata>());
      accounts.set(key, pending);
    }
    return pending;
  };
  const identity = (surface: MemberSurface, row: DefaultRow | BindingRow) => surface === "codex" ? row.codex_auth_id : row.subscription_account_id;
  const metadataAllows = (surface: MemberSurface, value: AccountMetadata | null): boolean => {
    try { assertSlotAccountMetadata(surface === "codex" ? "chatgpt_production" : "grok_production", value); return true; } catch { return false; }
  };
  const serviceFacts: MemberSurfaceFact[] = await Promise.all(surfaces.map(async id => {
    const state = quotas.known ? quotas.value.find(value => value.surface_grant === grant(id)) : undefined;
    const row = defaults.known ? defaults.value.find(value => value.surface_grant === grant(id)) : undefined;
    let condition: DefaultCondition = defaults.known ? "missing" : "unknown";
    const accountId = row ? identity(id, row) : null;
    if (accountId) {
      const metadata = await account(id, accountId);
      condition = !metadata.known ? "unknown" : metadata.value && defaultCredentialMetadataUsable(metadata.value.status)
        && metadata.value.environment === "production"
        && (id === "codex" ? metadata.value.kind === "shared" && metadata.value.admission_state !== "paused" : metadata.value.capability_source === "grok") ? "configured" : "unavailable";
    }
    return { id, quota: state ? { known: true, value: state } : unknown, entitlement: entitlement(state), default: condition,
      existing: unknown, reason: "unknown" };
  }));
  const keys = inventory.known ? inventory.value : [];
  const live = keys.filter(key => keyIsLive(key, now.getTime()));
  const liveFamilies = inventory.known ? new Set(live.map(key => key.family_id).filter(Boolean)).size : null;
  const observations = inventory.known && keys.length ? await read(() => queryClientVerification(env, undefined, userId)) : { known: true, value: [] } as const;
  const projected: MemberKeyFact[] = await Promise.all(keys.map(async key => {
    const keySurfaces = key.scopes.map(surfaceOf);
    const conditions = await Promise.all(keySurfaces.filter((surface): surface is MemberSurface => surface !== null).map(async surface => {
      if (!bindings.known) return { surface, state: "unknown" as const, selectable: null };
      const row = bindings.value.find(binding => binding.api_key_id === key.id && binding.surface_grant === grant(surface));
      const accountId = row ? identity(surface, row) : null;
      if (!accountId) return { surface, state: "missing" as const, selectable: false };
      const metadata = await account(surface, accountId);
      if (!metadata.known) return { surface, state: "unknown" as const, selectable: null };
      return { surface, state: metadataAllows(surface, metadata.value) ? "ready" as const : "unavailable" as const,
        selectable: replacementCredentialMetadataUsable(grant(surface), metadata.value) };
    }));
    const relatives = keys.filter(other => key.family_id !== null && other.family_id === key.family_id);
    const liveSecrets = relatives.filter(other => keyIsLive(other, now.getTime())).length;
    let reason: MemberKeyFact["replacement"]["reason"] = null;
    if (key.status !== "active") reason = "revoked";
    else if (!key.scopes.length || keySurfaces.some(surface => surface === null)) reason = "scope";
    else if (keySurfaces.some(surface => serviceFacts.find(fact => fact.id === surface)?.entitlement === "unknown")) reason = "unknown";
    else if (keySurfaces.some(surface => serviceFacts.find(fact => fact.id === surface)?.entitlement !== "eligible")) reason = "policy";
    else if (conditions.some(condition => condition.selectable === null) || key.family_id === null) reason = "unknown";
    else if (conditions.some(condition => !condition.selectable)) reason = "binding";
    else if (liveSecrets >= 2 || (!liveSecrets && (liveFamilies ?? 5) >= 5)) reason = "family";
    return { key, bindings: conditions.map(({ surface, state }) => ({ surface, state })), replacement: { allowed: reason === "unknown" ? null : reason === null, reason },
      family: { id: key.family_id, liveSecrets, relatives: relatives.filter(other => other.id !== key.id).map(other => ({ id: other.id, prefix: other.key_prefix, state: other.lifecycle.state })) },
      tasks: observations.known ? { known: true, value: observations.value.filter(row => row.key_id === key.id && row.user_id === userId) } : unknown };
  }));
  for (const fact of serviceFacts) {
    const relevant = projected.filter(item => item.key.scopes.includes(grant(fact.id)));
    const active = relevant.filter(item => item.key.lifecycle.state === "active");
    const ready = active.filter(item => item.bindings.find(binding => binding.surface === fact.id)?.state === "ready").length;
    const unobserved = active.filter(item => item.bindings.find(binding => binding.surface === fact.id)?.state === "unknown").length;
    fact.existing = inventory.known ? { known: true, value: { total: relevant.length, live: active.length, metadataReady: ready, metadataUnknown: unobserved } } : unknown;
    fact.reason = fact.entitlement === "unknown" ? "unknown" : fact.entitlement === "unconfigured" ? "unconfigured" : fact.entitlement === "disabled" ? "disabled" : fact.entitlement === "zero" ? "zero"
      : fact.quota.known && fact.quota.value.mode === "limited" && (fact.quota.value.remaining_credits ?? 0) <= 0 ? "exhausted"
      : !inventory.known ? "unknown" : !active.length ? (fact.default === "configured" ? (relevant.length ? "expired" : "no-key") : fact.default === "unknown" ? "default-unknown" : "default-unavailable") : ready ? "metadata-ready" : unobserved ? "binding-unknown" : "binding-unavailable";
  }
  return { keys: inventory.known ? { known: true, value: projected } : unknown, surfaces: serviceFacts, liveFamilies,
    canCreate: liveFamilies !== null && liveFamilies < 5 && serviceFacts.some(fact => fact.entitlement === "eligible" && fact.default === "configured"), asOf: now.toISOString() };
}

export function verificationSurface(planId: string): MemberSurface | null {
  const plan = listExecutionPlans().find(value => value.id === planId);
  return plan ? surfaceOf(plan.surfaceGrant) : null;
}
