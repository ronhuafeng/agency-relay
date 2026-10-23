import { DurableObject } from "cloudflare:workers";
import { decryptJson, encryptJson, nowIso, parseIsoMillis, secureJitterMillis } from "../crypto";
import {
  markCodexAuthReauthRequiredIfMutable,
  projectCodexRefreshIfMutable,
  readCodexAuthStatus,
  updateCodexAuthAfterRefresh
} from "../db";
import { errorMessage, HttpError } from "../errors";
import { nonNegativeIntegerOrNull } from "../records";
import { refreshCodexToken } from "../codex/oauth";
import {
  driverFor,
  markSubscriptionReauthRequiredIfMutable,
  projectSubscriptionRefreshIfMutable,
  readSubscriptionAccountStatus,
  updateSubscriptionAccountMetadata,
  type CapabilitySource,
  type FreshSubscriptionCredential,
  type SubscriptionCredential
} from "./subscription-accounts";
import type { AppDependencies, CodexAuthRefreshResult, CodexToken, FreshAccessToken, TokenCiphertext } from "../types";
import { tokenResultFromThrown, type TokenResult } from "./token-result";
import { notifyCredentialChange } from "../admin/credential-notifications";

const TOKEN_STORAGE_KEY = "token";
const SUBSCRIPTION_STORAGE_KEY = "subscription_credential";
const LIFECYCLE_GENERATION_KEY = "lifecycle_generation";
const REFRESH_LEAD_MS = 10 * 60 * 1000;
const MIN_ALARM_DELAY_MS = 60 * 1000;
const ALARM_JITTER_MS = 60 * 1000;

interface CodexSnapshot {
  token: CodexToken;
  generation: number;
}

interface SubscriptionSnapshot {
  credential: SubscriptionCredential;
  generation: number;
}

export class TokenAuthority extends DurableObject<Env> {
  private readonly deps: AppDependencies;
  private codexRefresh?: { generation: number; promise: Promise<CodexToken> };
  private subscriptionRefresh?: { generation: number; promise: Promise<SubscriptionCredential> };

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.deps = {
      fetch: (input, init) => fetch(input, init),
      now: () => new Date()
    };
  }

  async saveToken(token: CodexToken): Promise<TokenResult<null>> {
    return this.asResult(async () => {
      const normalized = normalizeToken(token, this.deps.now());
      const ciphertext = await encryptJson(this.env.TOKEN_ENCRYPTION_KEY_V1, normalized);
      await this.replaceSecret(TOKEN_STORAGE_KEY, ciphertext);
      await this.syncD1(normalized);
      await this.scheduleRefresh(normalized);
      return null;
    });
  }

  async getFreshAccessToken(): Promise<TokenResult<FreshAccessToken>> {
    return this.asResult(async () => {
      const snapshot = await this.loadCodexSnapshot();
      this.assertUsable(snapshot.token);
      const fresh = await this.ensureFreshSharedToken(snapshot);
      return {
        access_token: fresh.access_token,
        account_id: fresh.account_id
      };
    });
  }

  async refreshNow(): Promise<TokenResult<CodexAuthRefreshResult>> {
    return this.asResult(async () => {
      const snapshot = await this.loadCodexSnapshot();
      this.assertUsable(snapshot.token);
      const refreshed = await this.refreshOnceShared(snapshot);
      return {
        auth_id: refreshed.auth_id,
        refresh_available: Boolean(refreshed.refresh_token)
      };
    });
  }

  async revoke(): Promise<void> {
    const token = await this.loadToken().catch(() => undefined);
    const ciphertext = token
      ? await encryptJson(this.env.TOKEN_ENCRYPTION_KEY_V1, { ...token, status: "revoked" })
      : undefined;
    await this.ctx.storage.transaction(async (txn) => {
      if (ciphertext) await txn.put(TOKEN_STORAGE_KEY, ciphertext);
      await bumpLifecycleGeneration(txn);
    });
    await this.ctx.storage.deleteAlarm();
    this.notifyChange();
  }

  /** Phase 1: import/save Mini-owned Subscription Account credential (encrypted). */
  async saveSubscriptionCredential(credential: SubscriptionCredential): Promise<TokenResult<null>> {
    return this.asResult(async () => {
      const normalized = normalizeSubscriptionCredential(credential, this.deps.now());
      const ciphertext = await encryptJson(this.env.TOKEN_ENCRYPTION_KEY_V1, normalized);
      await this.replaceSecret(SUBSCRIPTION_STORAGE_KEY, ciphertext);
      await this.syncSubscriptionD1(normalized);
      await this.scheduleRefresh(normalized);
      return null;
    });
  }

  async getFreshSubscriptionCredential(): Promise<TokenResult<FreshSubscriptionCredential>> {
    return this.asResult(async () => {
      const snapshot = await this.loadSubscriptionSnapshot();
      this.assertSubscriptionUsable(snapshot.credential);
      const fresh = await this.ensureFreshSubscriptionCredential(snapshot);
      return {
        access_token: fresh.access_token,
        ...(fresh.account_ref ? { account_ref: fresh.account_ref } : {})
      };
    });
  }

  async refreshSubscriptionNow(): Promise<TokenResult<{ account_id: string; refresh_available: boolean }>> {
    return this.asResult(async () => {
      const snapshot = await this.loadSubscriptionSnapshot();
      this.assertSubscriptionUsable(snapshot.credential);
      const refreshed = await this.refreshSubscriptionOnceShared(snapshot);
      return {
        account_id: refreshed.account_id,
        refresh_available: Boolean(refreshed.refresh_token)
      };
    });
  }

  async revokeSubscription(): Promise<void> {
    const credential = await this.loadSubscriptionCredential().catch(() => undefined);
    if (credential) {
      try {
        await updateSubscriptionAccountMetadata(
          this.env,
          credential.account_id,
          { status: "revoked" },
          this.deps.now()
        );
      } catch {
        // D1 row may already be purged; still clear DO storage below.
      }
    }
    await this.clearSubscriptionStorage();
  }

  /** Delete subscription credential ciphertext + alarm (idempotent; no D1 required). */
  async clearSubscriptionStorage(): Promise<{ cleared: boolean }> {
    let cleared = false;
    await this.ctx.storage.transaction(async (txn) => {
      cleared = (await txn.get(SUBSCRIPTION_STORAGE_KEY)) !== undefined;
      await txn.delete(SUBSCRIPTION_STORAGE_KEY);
      await bumpLifecycleGeneration(txn);
    });
    await this.ctx.storage.deleteAlarm();
    this.notifyChange();
    return { cleared };
  }

  async alarm(): Promise<void> {
    const subscription = await this.loadSubscriptionSnapshot().catch(() => undefined);
    if (subscription) {
      await this.alarmSubscription(subscription);
      return;
    }

    const snapshot = await this.loadCodexSnapshot().catch(() => undefined);
    if (!snapshot || snapshot.token.status !== "active") {
      await this.ctx.storage.deleteAlarm();
      return;
    }

    try {
      await this.ensureFreshSharedToken(snapshot);
    } catch (error) {
      if (isSettledRefresh(error)) return;
      throw error;
    }
  }

  private async asResult<T>(run: () => Promise<T>): Promise<TokenResult<T>> {
    try {
      return { ok: true, value: await run() };
    } catch (error) {
      const expected = tokenResultFromThrown(error);
      if (!expected) throw error;
      return { ok: false, error: expected };
    }
  }

  private async alarmSubscription(snapshot: SubscriptionSnapshot): Promise<void> {
    if (snapshot.credential.status !== "active" && snapshot.credential.status !== "degraded") {
      await this.ctx.storage.deleteAlarm();
      return;
    }
    try {
      await this.ensureFreshSubscriptionCredential(snapshot);
    } catch (error) {
      if (isSettledRefresh(error)) return;
      throw error;
    }
  }

  /**
   * Centralized expiry policy for ChatGPT shared tokens.
   * Expired/near-expiry without refresh → reauth_required and local fail.
   */
  private async ensureFreshSharedToken(snapshot: CodexSnapshot): Promise<CodexToken> {
    if (!this.expiresWithinRefreshLead(snapshot.token.expires_at)) return snapshot.token;
    if (!snapshot.token.refresh_token) {
      if (!await this.commitCodexReauth(snapshot)) throw lifecycleChanged();
      throw new HttpError(401, "Codex auth expired and has no refresh token", "authentication_error", "reauth_required");
    }
    return this.refreshOnceShared(snapshot);
  }

  private async ensureFreshSubscriptionCredential(snapshot: SubscriptionSnapshot): Promise<SubscriptionCredential> {
    if (!this.expiresWithinRefreshLead(snapshot.credential.expires_at)) return snapshot.credential;
    if (!snapshot.credential.refresh_token) {
      if (!await this.commitSubscriptionReauth(snapshot)) throw lifecycleChanged();
      throw new HttpError(
        401,
        "Subscription credential expired and has no refresh token",
        "authentication_error",
        "reauth_required"
      );
    }
    return this.refreshSubscriptionOnceShared(snapshot);
  }

  private refreshOnceShared(snapshot: CodexSnapshot): Promise<CodexToken> {
    return this.singleFlight(
      () => this.codexRefresh,
      (slot) => { this.codexRefresh = slot; },
      snapshot.generation,
      () => this.refreshOnce(snapshot)
    );
  }

  private async refreshOnce(snapshot: CodexSnapshot): Promise<CodexToken> {
    try {
      const refreshed = await refreshCodexToken(this.env, this.deps, snapshot.token, this.deps.now());
      if (!await this.commitCodexCandidate(snapshot.generation, refreshed)) throw lifecycleChanged();
      return refreshed;
    } catch (error) {
      if (error instanceof HttpError && error.code === "credential_lifecycle_changed") throw error;
      if (!isPermanentOAuthFailure(error)) throw error;
      if (!await this.commitCodexReauth(snapshot)) throw lifecycleChanged();
      throw codexReauthRequired();
    }
  }

  private refreshSubscriptionOnceShared(snapshot: SubscriptionSnapshot): Promise<SubscriptionCredential> {
    return this.singleFlight(
      () => this.subscriptionRefresh,
      (slot) => { this.subscriptionRefresh = slot; },
      snapshot.generation,
      () => this.refreshSubscriptionOnce(snapshot)
    );
  }

  private singleFlight<T>(
    read: () => { generation: number; promise: Promise<T> } | undefined,
    write: (slot: { generation: number; promise: Promise<T> } | undefined) => void,
    generation: number,
    run: () => Promise<T>
  ): Promise<T> {
    const current = read();
    if (current?.generation === generation) return current.promise;
    const promise = run().finally(() => {
      if (read()?.promise === promise) write(undefined);
    });
    write({ generation, promise });
    return promise;
  }

  private async refreshSubscriptionOnce(snapshot: SubscriptionSnapshot): Promise<SubscriptionCredential> {
    const driver = driverFor(snapshot.credential.capability_source);
    try {
      const refreshed = await driver.refresh(this.env, this.deps, snapshot.credential, this.deps.now());
      if (!await this.commitSubscriptionCandidate(snapshot.generation, refreshed)) throw lifecycleChanged();
      return refreshed;
    } catch (error) {
      if (error instanceof HttpError && error.code === "credential_lifecycle_changed") throw error;
      const classified = driver.classifyRefreshFailure(error);
      const permanent = classified.permanent || isPermanentOAuthFailure(error);
      if (permanent) {
        const marked = await this.commitSubscriptionReauth(snapshot);
        console.error(JSON.stringify({
          event: "subscription_refresh_failed",
          account_id: snapshot.credential.account_id,
          failure_code: marked ? "reauth_required" : "credential_lifecycle_changed",
          permanent: true
        }));
        if (!marked) throw lifecycleChanged();
        throw subscriptionReauthRequired();
      }
      console.error(JSON.stringify({
        event: "subscription_refresh_failed",
        account_id: snapshot.credential.account_id,
        failure_code: classified.code,
        permanent: false
      }));
      throw error;
    }
  }

  private async commitCodexCandidate(generation: number, refreshed: CodexToken): Promise<boolean> {
    if (await this.currentGeneration() !== generation || await this.terminalCodex(refreshed.auth_id)) return false;
    const ciphertext = await encryptJson(this.env.TOKEN_ENCRYPTION_KEY_V1, refreshed);
    if (!await this.storeIfCurrent(TOKEN_STORAGE_KEY, generation, ciphertext)) return false;
    let projected = false;
    try {
      projected = await projectCodexRefreshIfMutable(this.env, refreshed.auth_id, {
        account_id: refreshed.account_id,
        email: refreshed.email,
        expires_at: refreshed.expires_at,
        last_refresh_at: refreshed.last_refresh_at,
        status: refreshed.status
      }, this.deps.now());
    } catch (projectionError) {
      console.error(JSON.stringify({
        event: "token_authority_d1_projection_failed",
        auth_id: refreshed.auth_id,
        error: errorMessage(projectionError)
      }));
      projected = !await this.terminalCodex(refreshed.auth_id);
    }
    if (!projected || await this.currentGeneration() !== generation || await this.terminalCodex(refreshed.auth_id)) {
      await this.revokeCodexIfCurrent(generation, refreshed);
      return false;
    }
    this.notifyChange();
    try {
      await this.scheduleRefresh(refreshed);
    } catch {
      // Alarm bookkeeping is best-effort after commit.
    }
    return true;
  }

  private async commitSubscriptionCandidate(
    generation: number,
    refreshed: SubscriptionCredential
  ): Promise<boolean> {
    if (await this.currentGeneration() !== generation || await this.terminalSubscription(refreshed.account_id)) {
      return false;
    }
    const ciphertext = await encryptJson(this.env.TOKEN_ENCRYPTION_KEY_V1, refreshed);
    if (!await this.storeIfCurrent(SUBSCRIPTION_STORAGE_KEY, generation, ciphertext)) return false;
    let projected = false;
    try {
      projected = await projectSubscriptionRefreshIfMutable(this.env, refreshed.account_id, {
        status: refreshed.status,
        provider_account_ref: refreshed.account_ref ?? null,
        expires_at: refreshed.expires_at ?? null,
        refresh_available: Boolean(refreshed.refresh_token),
        last_refresh_at: refreshed.last_refresh_at ?? null,
        reauth_required_at: refreshed.status === "reauth_required" ? nowIso(this.deps.now()) : null
      }, this.deps.now());
    } catch (projectionError) {
      console.error(JSON.stringify({
        event: "subscription_d1_projection_failed",
        account_id: refreshed.account_id,
        error: errorMessage(projectionError)
      }));
      projected = !await this.terminalSubscription(refreshed.account_id);
    }
    if (!projected || await this.currentGeneration() !== generation || await this.terminalSubscription(refreshed.account_id)) {
      await this.revokeSubscriptionIfCurrent(generation, refreshed);
      return false;
    }
    this.notifyChange();
    try {
      await this.scheduleRefresh(refreshed);
    } catch {
      // best-effort
    }
    return true;
  }

  private async commitCodexReauth(snapshot: CodexSnapshot): Promise<boolean> {
    if (await this.currentGeneration() !== snapshot.generation || await this.terminalCodex(snapshot.token.auth_id)) {
      return false;
    }
    const next: CodexToken = { ...snapshot.token, status: "reauth_required" };
    const ciphertext = await encryptJson(this.env.TOKEN_ENCRYPTION_KEY_V1, next);
    if (!await this.storeIfCurrent(TOKEN_STORAGE_KEY, snapshot.generation, ciphertext)) return false;
    const marked = await markCodexAuthReauthRequiredIfMutable(this.env, snapshot.token.auth_id, this.deps.now());
    if (!marked || await this.terminalCodex(snapshot.token.auth_id)) {
      await this.revokeCodexIfCurrent(snapshot.generation, snapshot.token);
      return false;
    }
    this.notifyChange();
    await this.ctx.storage.deleteAlarm();
    return true;
  }

  private async commitSubscriptionReauth(snapshot: SubscriptionSnapshot): Promise<boolean> {
    if (
      await this.currentGeneration() !== snapshot.generation
      || await this.terminalSubscription(snapshot.credential.account_id)
    ) return false;
    const next: SubscriptionCredential = { ...snapshot.credential, status: "reauth_required" };
    const ciphertext = await encryptJson(this.env.TOKEN_ENCRYPTION_KEY_V1, next);
    if (!await this.storeIfCurrent(SUBSCRIPTION_STORAGE_KEY, snapshot.generation, ciphertext)) return false;
    const marked = await markSubscriptionReauthRequiredIfMutable(
      this.env,
      snapshot.credential.account_id,
      this.deps.now()
    );
    if (!marked || await this.terminalSubscription(snapshot.credential.account_id)) {
      await this.revokeSubscriptionIfCurrent(snapshot.generation, snapshot.credential);
      return false;
    }
    this.notifyChange();
    await this.ctx.storage.deleteAlarm();
    return true;
  }

  private async revokeCodexIfCurrent(generation: number, token: CodexToken): Promise<void> {
    await this.revokeIfCurrent(TOKEN_STORAGE_KEY, generation, { ...token, status: "revoked" });
  }

  private async revokeSubscriptionIfCurrent(generation: number, credential: SubscriptionCredential): Promise<void> {
    await this.revokeIfCurrent(SUBSCRIPTION_STORAGE_KEY, generation, { ...credential, status: "revoked" });
  }

  private async revokeIfCurrent(key: string, generation: number, value: unknown): Promise<void> {
    const ciphertext = await encryptJson(this.env.TOKEN_ENCRYPTION_KEY_V1, value);
    if (await this.storeIfCurrent(key, generation, ciphertext)) await this.ctx.storage.deleteAlarm();
  }

  private async loadCodexSnapshot(): Promise<CodexSnapshot> {
    const { encrypted, generation } = await this.readV1Snapshot(TOKEN_STORAGE_KEY, new HttpError(401, "Codex auth is not configured", "authentication_error", "missing_codex_auth"));
    return { token: await decryptJson<CodexToken>(this.env.TOKEN_ENCRYPTION_KEY_V1, encrypted), generation };
  }

  private async loadSubscriptionSnapshot(): Promise<SubscriptionSnapshot> {
    const { encrypted, generation } = await this.readV1Snapshot(SUBSCRIPTION_STORAGE_KEY, new HttpError(401, "Subscription credential is not configured", "authentication_error", "missing_subscription_credential"));
    return { credential: await decryptJson<SubscriptionCredential>(this.env.TOKEN_ENCRYPTION_KEY_V1, encrypted), generation };
  }

  private async readV1Snapshot(key: string, missing: HttpError): Promise<{ encrypted: TokenCiphertext; generation: number }> {
    let encrypted: TokenCiphertext | undefined;
    let generation = 0;
    await this.ctx.storage.transaction(async (txn) => {
      encrypted = await txn.get<TokenCiphertext>(key);
      generation = generationValue(await txn.get<number>(LIFECYCLE_GENERATION_KEY));
    });
    if (!encrypted) throw missing;
    if (encrypted.kid !== "v1") {
      throw new HttpError(500, "Unsupported token encryption key version", "server_error", "unsupported_token_kid");
    }
    return { encrypted, generation };
  }

  private async loadToken(): Promise<CodexToken> {
    return (await this.loadCodexSnapshot()).token;
  }

  private async loadSubscriptionCredential(): Promise<SubscriptionCredential> {
    return (await this.loadSubscriptionSnapshot()).credential;
  }

  private async replaceSecret(key: string, ciphertext: TokenCiphertext): Promise<void> {
    await this.ctx.storage.transaction(async (txn) => {
      await txn.put(key, ciphertext);
      await bumpLifecycleGeneration(txn);
    });
  }

  private async storeIfCurrent(key: string, generation: number, ciphertext: TokenCiphertext): Promise<boolean> {
    let stored = false;
    await this.ctx.storage.transaction(async (txn) => {
      if (generationValue(await txn.get<number>(LIFECYCLE_GENERATION_KEY)) !== generation) return;
      await txn.put(key, ciphertext);
      stored = true;
    });
    return stored;
  }

  private async currentGeneration(): Promise<number> {
    return generationValue(await this.ctx.storage.get<number>(LIFECYCLE_GENERATION_KEY));
  }

  private async terminalCodex(authId: string): Promise<boolean> {
    return isAdministrativeTerminal(await readCodexAuthStatus(this.env, authId));
  }

  private async terminalSubscription(accountId: string): Promise<boolean> {
    return isAdministrativeTerminal(await readSubscriptionAccountStatus(this.env, accountId));
  }

  private async syncD1(token: CodexToken): Promise<void> {
    await updateCodexAuthAfterRefresh(this.env, token.auth_id, {
      account_id: token.account_id,
      email: token.email,
      expires_at: token.expires_at,
      last_refresh_at: token.last_refresh_at,
      status: token.status
    }, this.deps.now());
    this.notifyChange();
  }

  private async syncSubscriptionD1(credential: SubscriptionCredential): Promise<void> {
    await updateSubscriptionAccountMetadata(this.env, credential.account_id, {
      status: credential.status,
      provider_account_ref: credential.account_ref ?? null,
      expires_at: credential.expires_at ?? null,
      refresh_available: Boolean(credential.refresh_token),
      last_refresh_at: credential.last_refresh_at ?? null,
      reauth_required_at: credential.status === "reauth_required" ? nowIso(this.deps.now()) : null
    }, this.deps.now());
    this.notifyChange();
  }

  private notifyChange(): void {
    if (this.env.CREDENTIAL_EVENTS) this.ctx.waitUntil(notifyCredentialChange(this.env));
  }

  private assertUsable(token: CodexToken): void {
    if (token.status === "reauth_required") {
      throw codexReauthRequired();
    }
    if (token.status !== "active") {
      throw new HttpError(401, "Codex auth is not active", "authentication_error", "codex_auth_inactive");
    }
    if (!token.access_token) {
      throw new HttpError(401, "Codex auth does not have an access token", "authentication_error", "missing_access_token");
    }
  }

  private assertSubscriptionUsable(credential: SubscriptionCredential): void {
    if (credential.status === "reauth_required") {
      throw subscriptionReauthRequired();
    }
    if (credential.status !== "active" && credential.status !== "degraded") {
      throw new HttpError(401, "Subscription account is not active", "authentication_error", "subscription_inactive");
    }
    if (!credential.access_token) {
      throw new HttpError(401, "Subscription credential is missing an access token", "authentication_error", "missing_access_token");
    }
  }

  private expiresWithinRefreshLead(expiresAt?: string | null): boolean {
    const expires = parseIsoMillis(expiresAt);
    return expires !== undefined && expires - this.deps.now().getTime() <= REFRESH_LEAD_MS;
  }

  private async scheduleRefresh(credential: { refresh_token?: string; status: string; expires_at?: string }): Promise<void> {
    if (!credential.refresh_token || credential.status !== "active") {
      await this.ctx.storage.deleteAlarm();
      return;
    }
    const expiresAt = parseIsoMillis(credential.expires_at);
    if (expiresAt === undefined) {
      await this.ctx.storage.deleteAlarm();
      return;
    }
    const alarmAt = Math.max(this.deps.now().getTime() + MIN_ALARM_DELAY_MS, expiresAt - REFRESH_LEAD_MS + secureJitterMillis(ALARM_JITTER_MS));
    await this.ctx.storage.setAlarm(alarmAt);
  }
}

async function bumpLifecycleGeneration(txn: { get<T>(key: string): Promise<T | undefined>; put(key: string, value: number): Promise<void> }): Promise<void> {
  await txn.put(LIFECYCLE_GENERATION_KEY, generationValue(await txn.get<number>(LIFECYCLE_GENERATION_KEY)) + 1);
}

function codexReauthRequired(): HttpError {
  return new HttpError(401, "Codex auth requires reauthorization", "authentication_error", "reauth_required");
}

function subscriptionReauthRequired(): HttpError {
  return new HttpError(401, "Subscription requires reauthorization", "authentication_error", "reauth_required");
}

function generationValue(value: unknown): number {
  return nonNegativeIntegerOrNull(value) ?? 0;
}

function isAdministrativeTerminal(status: string | null): boolean {
  return status === "revoked" || status === "disabled" || status === "retiring";
}

function lifecycleChanged(): HttpError {
  return new HttpError(409, "Credential changed during refresh", "authentication_error", "credential_lifecycle_changed");
}

function isSettledRefresh(error: unknown): boolean {
  return error instanceof HttpError
    && (error.code === "reauth_required" || error.code === "credential_lifecycle_changed");
}

function missingAccessToken(): HttpError {
  return new HttpError(400, "access_token is required", "invalid_request_error", "missing_access_token");
}

function normalizeToken(token: CodexToken, now = new Date()): CodexToken {
  if (!token.auth_id) {
    throw new HttpError(400, "auth_id is required", "invalid_request_error", "missing_auth_id");
  }
  if (!token.access_token) {
    throw missingAccessToken();
  }
  return {
    ...token,
    last_refresh_at: token.last_refresh_at ?? nowIso(now)
  };
}

function normalizeSubscriptionCredential(
  credential: SubscriptionCredential,
  now = new Date()
): SubscriptionCredential {
  if (!credential.account_id) {
    throw new HttpError(400, "account_id is required", "invalid_request_error", "missing_account_id");
  }
  if (!credential.access_token) {
    throw missingAccessToken();
  }
  const source = credential.capability_source as CapabilitySource;
  if (source !== "chatgpt" && source !== "grok") {
    throw new HttpError(400, "capability_source is invalid", "invalid_request_error", "invalid_capability_source");
  }
  return {
    ...credential,
    status: credential.status || "active",
    last_refresh_at: credential.last_refresh_at ?? nowIso(now)
  };
}

/** Permanent OAuth failures that require operator reauthorization. */
function isPermanentOAuthFailure(error: unknown): boolean {
  if (error instanceof HttpError) {
    if (error.code === "reauth_required" || error.code === "invalid_grant") return true;
    const message = error.message.toLowerCase();
    if (message.includes("invalid_grant") || message.includes("refresh_token_reused")) return true;
  }
  if (error instanceof Error) {
    const message = error.message.toLowerCase();
    if (message.includes("invalid_grant") || message.includes("refresh_token_reused")) return true;
  }
  return false;
}
