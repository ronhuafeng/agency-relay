import type { DatabaseSync } from "node:sqlite";
import { describe, expect, it, onTestFinished } from "vitest";
import { commitIssuedKey } from "../../src/auth/api-keys";
import {
  commitCredentialDefault,
  disconnectCredential,
  migrateCredentialBindings,
  previewCredentialRetirement,
  readServiceAvailability,
  retryCredentialCleanup,
  selectIssuanceDefaults,
  type CredentialActor
} from "../../src/auth/credential-defaults";
import { createTestD1 } from "../support/sqlite-d1";
import { admin, consoleCookie, createUser, makeFixture } from "../router/fixture";
import { handleRequest } from "../../src/router";
import { createConsoleSession } from "../../src/auth/console-session";

const NOW = new Date("2026-08-10T12:00:00.000Z");
const ACTOR: CredentialActor = {
  kind: "admin_secret",
  email: null,
  subject: null,
  userId: null,
  role: null,
  requestId: "req_defaults"
};
const ACCESS_ACTOR: CredentialActor = { ...ACTOR, kind: "access", role: "admin", userId: "admin_user", email: "admin@example.com" };

describe("credential defaults and retirement", () => {
  it("keeps retirement defaults scoped to the credential kind when account IDs collide", async () => {
    const { env, sqlite } = fixture();
    seedCodex(sqlite, "collision", "active", "2026-09-01T00:00:00.000Z");
    seedGrok(sqlite, "collision", "active");
    await commitCredentialDefault(env, ACTOR, { surface_grant: "surface:codex:production", credential_account_id: "collision" }, NOW);
    await commitCredentialDefault(env, ACTOR, { surface_grant: "surface:grok:production", credential_account_id: "collision" }, NOW);
    await commitCredentialDefault(env, ACTOR, { surface_grant: "surface:xai:production", credential_account_id: "collision" }, NOW);
    const codex = await previewCredentialRetirement(env, "codex", "collision");
    const grok = await previewCredentialRetirement(env, "grok", "collision");
    expect(codex.default_surfaces).toEqual(["surface:codex:production"]);
    expect(codex.shared_provider_authority).toBeUndefined();
    expect(grok.default_surfaces).toEqual(["surface:grok:production", "surface:xai:production"]);
    expect(grok.shared_provider_authority).toMatch(/does not isolate/);
  });

  it.each([
    ["codex", "active"], ["codex", "retiring"],
    ["grok", "active"], ["grok", "retiring"],
    ["xai", "active"], ["xai", "retiring"]
  ] as const)("blocks a concurrent %s binding at disconnect commit when the account becomes %s", async (surface, status) => {
    let sql!: DatabaseSync;
    let injected = false;
    const kind = surface === "codex" ? "codex" : "grok";
    const table = kind === "codex" ? "codex_auths" : "subscription_accounts";
    const { env, sqlite } = fixture({ onBatch: () => {
      if (injected) return;
      injected = true;
      // The binding commits while the account is selectable. Retirement can then
      // retain that existing binding; the pending disconnect must still reject it.
      seedSurfaceBinding(sql, "key_concurrent", surface, "old");
      sql.prepare(`UPDATE ${table} SET status=? WHERE id='old'`).run(status);
    } });
    sql = sqlite;
    seedAdmin(sqlite);
    if (kind === "codex") seedCodex(sqlite, "old", "active", "2026-09-01T00:00:00.000Z");
    else seedGrok(sqlite, "old", "active");
    let cleared = false;
    await expect(disconnectCredential(env, ACCESS_ACTOR, { kind, account_id: "old" }, async () => { cleared = true; }, NOW))
      .rejects.toMatchObject({ status: 409, code: "credential_disconnect_blocked" });
    expect(cleared).toBe(false);
    expect(sqlite.prepare(`SELECT status FROM ${table} WHERE id='old'`).get()).toEqual({ status });
    expect(sqlite.prepare("SELECT api_key_id,surface_grant,codex_auth_id,subscription_account_id FROM api_key_surface_credentials").all())
      .toEqual([{ api_key_id: "key_concurrent", surface_grant: `surface:${surface}:production`, codex_auth_id: kind === "codex" ? "old" : null, subscription_account_id: kind === "grok" ? "old" : null }]);
    expect(sqlite.prepare("SELECT action FROM operator_mutation_audit").all()).toEqual([]);
  });

  it.each([false, true])("only cleans an already revoked account for a currently authorized administrator (demoted=%s)", async demoted => {
    let sql!: DatabaseSync;
    const { env, sqlite } = fixture({ onBatch: () => {
      if (demoted) sql.exec("UPDATE users SET role='user' WHERE id='admin_user'");
    } });
    sql = sqlite;
    seedAdmin(sqlite);
    seedCodex(sqlite, "old", "revoked", "2026-09-01T00:00:00.000Z");
    let cleared = false;
    const outcome = disconnectCredential(env, ACCESS_ACTOR, { kind: "codex", account_id: "old" }, async () => { cleared = true; }, NOW);
    if (demoted) await expect(outcome).rejects.toMatchObject({ status: 403, code: "admin_required" });
    else await expect(outcome).resolves.toMatchObject({ d1_status: "revoked", completion: "complete", token_cleanup: "cleared" });
    expect(cleared).toBe(!demoted);
    expect(sqlite.prepare("SELECT status FROM codex_auths WHERE id='old'").get()).toEqual({ status: "revoked" });
    expect(sqlite.prepare("SELECT action FROM operator_mutation_audit").all()).toEqual([]);
  });

  it("rolls back metadata and does not clear tokens when the disconnect success audit fails", async () => {
    const { env, sqlite } = fixture();
    seedAdmin(sqlite);
    seedCodex(sqlite, "old", "active", "2026-09-01T00:00:00.000Z");
    sqlite.exec(`CREATE TRIGGER fail_disconnect_audit BEFORE INSERT ON operator_mutation_audit
      WHEN NEW.action='credential.disconnect' BEGIN SELECT RAISE(ABORT,'synthetic disconnect audit failure'); END;`);
    let cleared = false;
    await expect(disconnectCredential(env, ACCESS_ACTOR, { kind: "codex", account_id: "old" }, async () => { cleared = true; }, NOW))
      .rejects.toThrow("synthetic disconnect audit failure");
    expect(cleared).toBe(false);
    expect(sqlite.prepare("SELECT status FROM codex_auths WHERE id='old'").get()).toEqual({ status: "active" });
    expect(sqlite.prepare("SELECT action FROM operator_mutation_audit").all()).toEqual([]);
  });

  it.each([
    ["codex", false], ["codex", true], ["grok", false], ["grok", true], ["xai", false], ["xai", true]
  ] as const)("requires explicit disconnect before cleanup of a retiring %s account (bound=%s)", async (surface, bound) => {
    const { env, sqlite } = fixture();
    seedAdmin(sqlite);
    const kind = surface === "codex" ? "codex" : "grok";
    const table = kind === "codex" ? "codex_auths" : "subscription_accounts";
    if (kind === "codex") seedCodex(sqlite, "old", "active", "2026-09-01T00:00:00.000Z");
    else seedGrok(sqlite, "old", "active");
    if (bound) seedSurfaceBinding(sqlite, "bound", surface, "old");
    sqlite.prepare(`UPDATE ${table} SET status='retiring' WHERE id='old'`).run();
    const before = sqlite.prepare("SELECT api_key_id,surface_grant,codex_auth_id,subscription_account_id FROM api_key_surface_credentials").all();
    let cleared = false;
    await expect(retryCredentialCleanup(env, ACCESS_ACTOR, { kind, account_id: "old" }, async () => { cleared = true; }, NOW))
      .rejects.toMatchObject({ status: 409, code: "credential_cleanup_not_ready" });
    expect(cleared).toBe(false);
    expect(sqlite.prepare(`SELECT status FROM ${table} WHERE id='old'`).get()).toEqual({ status: "retiring" });
    expect(sqlite.prepare("SELECT api_key_id,surface_grant,codex_auth_id,subscription_account_id FROM api_key_surface_credentials").all()).toEqual(before);
    expect(sqlite.prepare("SELECT action,result FROM operator_mutation_audit").all()).toEqual([]);
  });

  it.each(["codex", "grok", "xai"] as const)("recovers failed cleanup of a revoked %s account without changing its status or bindings", async surface => {
    const { env, sqlite } = fixture();
    seedAdmin(sqlite);
    const kind = surface === "codex" ? "codex" : "grok";
    const table = kind === "codex" ? "codex_auths" : "subscription_accounts";
    if (kind === "codex") seedCodex(sqlite, "old", "active", "2026-09-01T00:00:00.000Z");
    else seedGrok(sqlite, "old", "active");
    seedSurfaceBinding(sqlite, "bound", surface, "old");
    sqlite.prepare(`UPDATE ${table} SET status='revoked' WHERE id='old'`).run();
    const bindings = sqlite.prepare("SELECT api_key_id,surface_grant,codex_auth_id,subscription_account_id FROM api_key_surface_credentials").all();
    await expect(retryCredentialCleanup(env, ACCESS_ACTOR, { kind, account_id: "old" }, async () => {
      throw new Error("Synthetic token cleanup unavailable");
    }, NOW)).resolves.toEqual({ completion: "partial", d1_status: "revoked", token_cleanup: "failed" });
    let cleared = false;
    await expect(retryCredentialCleanup(env, ACCESS_ACTOR, { kind, account_id: "old" }, async () => { cleared = true; }, NOW))
      .resolves.toEqual({ completion: "complete", d1_status: "revoked", token_cleanup: "cleared" });
    expect(cleared).toBe(true);
    expect(sqlite.prepare(`SELECT status FROM ${table} WHERE id='old'`).get()).toEqual({ status: "revoked" });
    expect(sqlite.prepare("SELECT api_key_id,surface_grant,codex_auth_id,subscription_account_id FROM api_key_surface_credentials").all()).toEqual(bindings);
    expect(sqlite.prepare("SELECT action,result,meta FROM operator_mutation_audit ORDER BY rowid").all()).toEqual([
      { action: "credential.cleanup_retry", result: "error", meta: JSON.stringify({ kind, token_cleanup: "failed" }) },
      { action: "credential.cleanup_retry", result: "ok", meta: JSON.stringify({ kind, token_cleanup: "cleared" }) }
    ]);
  });

  it.each([
    ["demotion", "UPDATE users SET role = 'user' WHERE id = 'admin_user'"],
    ["disable", "UPDATE users SET status = 'disabled' WHERE id = 'admin_user'"],
    ["session invalidation", "UPDATE users SET console_session_epoch = 1 WHERE id = 'admin_user'"],
    ["mailbox change", "UPDATE users SET canonical_email = 'changed@example.com', email = 'changed@example.com' WHERE id = 'admin_user'"]
  ])("rejects an in-flight default change after administrator %s", async (_name, change) => {
    const { env, sqlite } = fixture();
    seedAdmin(sqlite);
    seedCodex(sqlite, "codex_a", "active", "2026-09-01T00:00:00.000Z");
    const token = await createConsoleSession(env, { id: "admin_user", email: "admin@example.com", sessionEpoch: 0 }, NOW);
    const request = new Request("https://admin.example.test/admin/ui/credential-defaults/codex", {
      method: "POST",
      headers: { Cookie: `__Host-mini-console=${token}`, Origin: "https://admin.example.test", "Content-Type": "application/json" },
      body: JSON.stringify({ confirm: true, credential_account_id: "codex_a" })
    });
    let reachedBody!: () => void;
    let releaseBody!: () => void;
    const started = new Promise<void>(resolve => { reachedBody = resolve; });
    const held = new Promise<void>(resolve => { releaseBody = resolve; });
    const json = request.json.bind(request);
    // A slow body is an actual await between entry authorization and the SQL commit.
    Object.defineProperty(request, "json", { value: async () => { reachedBody(); await held; return json(); } });
    const response = handleRequest(request, env, { waitUntil() {} }, { now: () => NOW, fetch: async () => { throw new Error("Unexpected network"); } });
    expect(await Promise.race([started.then(() => true), response.then(() => false)])).toBe(true);
    sqlite.exec(change);
    releaseBody();
    expect((await response).status).toBe(403);
    expect(sqlite.prepare("SELECT count(*) AS count FROM organization_surface_credential_defaults").get()).toEqual({ count: 0 });
    expect(sqlite.prepare("SELECT count(*) AS count FROM operator_mutation_audit").get()).toEqual({ count: 0 });
  });

  it.each([
    ["administrator demotion", "UPDATE users SET role = 'user' WHERE id = 'admin_user'", 403],
    ["replacement retirement", "UPDATE codex_auths SET status = 'revoked' WHERE id = 'codex_new'", 409],
    ["replacement environment change", "UPDATE codex_auths SET environment = 'staging' WHERE id = 'codex_new'", 409],
    ["source disconnection", "UPDATE codex_auths SET status = 'revoked' WHERE id = 'codex_old'", 409]
  ])("leaves bindings, defaults and audit unchanged after concurrent %s", async (_name, change, status) => {
    let sql!: DatabaseSync;
    const { env, sqlite } = fixture({ onBatch: () => sql.exec(change) });
    sql = sqlite;
    seedAdmin(sqlite);
    seedCodex(sqlite, "codex_old", "active", "2026-09-01T00:00:00.000Z");
    seedCodex(sqlite, "codex_new", "active", "2026-09-01T00:00:00.000Z");
    seedKey(sqlite, "key_old", "codex_old", "hash_old");
    sqlite.prepare("INSERT INTO organization_surface_credential_defaults (surface_grant, codex_auth_id, created_at, updated_at) VALUES ('surface:codex:production', 'codex_old', ?, ?)").run(NOW.toISOString(), NOW.toISOString());
    await expect(migrateCredentialBindings(env, ACCESS_ACTOR, {
      kind: "codex", account_id: "codex_old", replacement_account_id: "codex_new",
      key_ids: ["key_old"], default_surfaces: ["surface:codex:production"]
    }, NOW)).rejects.toMatchObject({ status });
    expect(sqlite.prepare("SELECT codex_auth_id FROM api_key_surface_credentials WHERE api_key_id = 'key_old'").get()).toEqual({ codex_auth_id: "codex_old" });
    expect(sqlite.prepare("SELECT codex_auth_id FROM organization_surface_credential_defaults").get()).toEqual({ codex_auth_id: "codex_old" });
    expect(sqlite.prepare("SELECT count(*) AS count FROM operator_mutation_audit").get()).toEqual({ count: 0 });
  });

  it("does not disconnect or clear encrypted credentials after a concurrent administrator disable", async () => {
    let sql!: DatabaseSync;
    const { env, sqlite } = fixture({ onBatch: () => sql.exec("UPDATE users SET status = 'disabled' WHERE id = 'admin_user'") });
    sql = sqlite;
    seedAdmin(sqlite);
    seedCodex(sqlite, "codex_a", "active", "2026-09-01T00:00:00.000Z");
    let cleared = false;
    await expect(disconnectCredential(env, ACCESS_ACTOR, { kind: "codex", account_id: "codex_a" }, async () => { cleared = true; }, NOW)).rejects.toMatchObject({ status: 403 });
    expect(sqlite.prepare("SELECT status FROM codex_auths WHERE id = 'codex_a'").get()).toEqual({ status: "active" });
    expect(sqlite.prepare("SELECT count(*) AS count FROM operator_mutation_audit").get()).toEqual({ count: 0 });
    expect(cleared).toBe(false);
  });

  it("rejects cleanup retry with an invalidated administrator session before external cleanup", async () => {
    const { env, sqlite } = fixture();
    seedAdmin(sqlite);
    seedCodex(sqlite, "codex_a", "revoked", "2026-09-01T00:00:00.000Z");
    sqlite.exec("UPDATE users SET console_session_epoch = 1 WHERE id = 'admin_user'");
    let cleared = false;
    await expect(retryCredentialCleanup(env, ACCESS_ACTOR, { kind: "codex", account_id: "codex_a" }, async () => { cleared = true; }, NOW)).rejects.toMatchObject({ status: 403 });
    expect(sqlite.prepare("SELECT count(*) AS count FROM operator_mutation_audit").get()).toEqual({ count: 0 });
    expect(cleared).toBe(false);
  });

  it("keeps old bindings when a future default changes and reports availability without account ids", async () => {
    const { env, sqlite } = fixture();
    seedCodex(sqlite, "codex_a", "active", "2026-08-01T00:00:00.000Z");
    seedCodex(sqlite, "codex_b", "active", "2026-09-01T00:00:00.000Z");
    seedGrok(sqlite, "grok_a", "active");
    seedGrok(sqlite, "grok_b", "degraded");
    seedKey(sqlite, "key_old", "codex_a", "hash_old");
    await commitCredentialDefault(env, ACTOR, { surface_grant: "surface:codex:production", credential_account_id: "codex_a" }, NOW);
    await commitCredentialDefault(env, ACTOR, { surface_grant: "surface:grok:production", credential_account_id: "grok_a" }, NOW);
    await commitCredentialDefault(env, ACTOR, { surface_grant: "surface:xai:production", credential_account_id: "grok_a" }, NOW);
    const grokPreview = await previewCredentialRetirement(env, "grok", "grok_a");
    expect([...grokPreview.default_surfaces].sort()).toEqual(["surface:grok:production", "surface:xai:production"]);
    expect(grokPreview.shared_provider_authority).toContain("does not isolate");
    await commitCredentialDefault(env, ACTOR, { surface_grant: "surface:codex:production", credential_account_id: "codex_b" }, NOW);
    expect(sqlite.prepare("SELECT codex_auth_id FROM api_key_surface_credentials WHERE api_key_id = 'key_old'").get())
      .toEqual({ codex_auth_id: "codex_a" });
    expect(sqlite.prepare("SELECT key_hash, scopes, user_id FROM api_keys WHERE id = 'key_old'").get())
      .toEqual({ key_hash: "hash_old", scopes: '["surface:codex:production"]', user_id: "user_a" });
    const selected = await selectIssuanceDefaults(env, ["surface:codex:production", "surface:xai:production"], async () => undefined, NOW);
    expect(selected).toEqual([
      { surface_grant: "surface:codex:production", credential_account_id: "codex_b" },
      { surface_grant: "surface:xai:production", credential_account_id: "grok_a" }
    ]);
    seedCodex(sqlite, "codex_reauth", "reauth_required", "2026-09-01T00:00:00.000Z");
    const auditsBeforeRejectedDefault = sqlite.prepare("SELECT count(*) AS count FROM operator_mutation_audit").get();
    await expect(commitCredentialDefault(env, ACTOR, {
      surface_grant: "surface:codex:production",
      credential_account_id: "codex_reauth"
    }, NOW)).rejects.toMatchObject({ code: "credential_default_unavailable" });
    expect(sqlite.prepare("SELECT count(*) AS count FROM operator_mutation_audit").get()).toEqual(auditsBeforeRejectedDefault);
    await expect(selectIssuanceDefaults(env, ["surface:grok:production"], async () => {
      throw new Error("secret-account-grok_a");
    }, NOW)).rejects.toMatchObject({
      code: "credential_default_unavailable",
      message: expect.not.stringContaining("grok_a")
    });
    const member = await readServiceAvailability(env, async () => undefined, NOW);
    expect(member.map((service) => service.surface)).toEqual(["codex", "grok", "xai"]);
    expect(JSON.stringify(member)).not.toContain("codex_b");
    expect(JSON.stringify(member)).not.toContain("grok_a");
  });

  it("migrates only the named bindings and recovers a failed token cleanup without restoring the old account", async () => {
    const { env, sqlite } = fixture();
    seedCodex(sqlite, "codex_old", "active", "2020-01-01T00:00:00.000Z");
    seedCodex(sqlite, "codex_new", "active", "2026-09-01T00:00:00.000Z");
    seedKey(sqlite, "key_keep", "codex_old", "hash_keep", "family_keep");
    seedKey(sqlite, "key_move", "codex_old", "hash_move", "family_keep");
    seedKey(sqlite, "key_move2", "codex_old", "hash_move2", "family_keep");
    await commitCredentialDefault(env, ACTOR, { surface_grant: "surface:codex:production", credential_account_id: "codex_old" }, NOW);
    const preview = await previewCredentialRetirement(env, "codex", "codex_old");
    expect(preview.live_keys.map((key) => key.id).sort()).toEqual(["key_keep", "key_move", "key_move2"]);
    expect(preview.default_surfaces).toEqual(["surface:codex:production"]);
    expect(preview.compatible_replacements.map((account) => account.id)).toContain("codex_new");
    expect(preview.provider_resources_not_migrated).toContain("does not move");
    expect(JSON.stringify(preview)).not.toContain("hash_keep");

    await expect(disconnectCredential(env, ACTOR, { kind: "codex", account_id: "codex_old" }, async () => undefined, NOW))
      .rejects.toMatchObject({ code: "credential_disconnect_blocked" });
    expect(sqlite.prepare("SELECT status FROM codex_auths WHERE id = 'codex_old'").get()).toEqual({ status: "active" });
    expect(sqlite.prepare("SELECT count(*) AS count FROM operator_mutation_audit WHERE action = 'credential.disconnect' AND result = 'ok'").get())
      .toEqual({ count: 0 });

    const migrated = await migrateCredentialBindings(env, ACTOR, {
      kind: "codex",
      account_id: "codex_old",
      replacement_account_id: "codex_new",
      key_ids: ["key_move", "key_move2"],
      default_surfaces: ["surface:codex:production"]
    }, NOW);
    expect(migrated).toEqual({ migrated_bindings: 2, migrated_defaults: 1 });
    const bindingAudit = sqlite.prepare("SELECT meta FROM operator_mutation_audit WHERE action = 'credential.migrate_bindings'").get() as { meta: string };
    expect(JSON.parse(bindingAudit.meta)).toMatchObject({ changed: 2, replacement_account_id: "codex_new" });
    expect(sqlite.prepare("SELECT codex_auth_id FROM api_key_surface_credentials WHERE api_key_id = 'key_keep'").get())
      .toEqual({ codex_auth_id: "codex_old" });
    expect(sqlite.prepare("SELECT codex_auth_id FROM api_key_surface_credentials WHERE api_key_id = 'key_move'").get())
      .toEqual({ codex_auth_id: "codex_new" });
    expect(sqlite.prepare("SELECT key_hash, scopes, user_id, expires_at FROM api_keys WHERE id = 'key_move'").get())
      .toEqual({ key_hash: "hash_move", scopes: '["surface:codex:production"]', user_id: "user_a", expires_at: null });
    expect(sqlite.prepare("SELECT status FROM codex_auths WHERE id = 'codex_old'").get()).toEqual({ status: "retiring" });
    await expect(commitIssuedKey(env, ACTOR, {
      user_id: "user_a",
      name: "Replacement",
      action: "key.replace.create",
      scopes: ["surface:codex:production"],
      expires_at: null,
      copy_bindings_from_api_key_id: "key_keep"
    }, NOW)).rejects.toMatchObject({ code: "replacement_bindings_unavailable" });

    await expect(disconnectCredential(env, ACCESS_ACTOR, { kind: "codex", account_id: "codex_old", force: true }, async () => undefined, NOW))
      .rejects.toMatchObject({ status: 403 });
    const partial = await disconnectCredential(env, ACTOR, { kind: "codex", account_id: "codex_old", force: true }, async () => {
      throw new Error("cleanup failed");
    }, NOW);
    expect(partial).toMatchObject({ completion: "partial", d1_status: "revoked", token_cleanup: "failed", recovery: "retry_cleanup" });
    expect(sqlite.prepare("SELECT status FROM codex_auths WHERE id = 'codex_old'").get()).toEqual({ status: "revoked" });
    const auditsBeforeRetry = sqlite.prepare("SELECT count(*) AS count FROM operator_mutation_audit").get() as { count: number };
    const retried = await retryCredentialCleanup(env, ACTOR, { kind: "codex", account_id: "codex_old" }, async () => undefined, NOW);
    expect(retried).toMatchObject({ completion: "complete", d1_status: "revoked", token_cleanup: "cleared" });
    const auditsAfterRetry = sqlite.prepare("SELECT count(*) AS count FROM operator_mutation_audit").get();
    expect(auditsAfterRetry).toEqual({ count: auditsBeforeRetry.count + 1 });
    expect(sqlite.prepare("SELECT codex_auth_id FROM api_key_surface_credentials WHERE api_key_id = 'key_keep'").get())
      .toEqual({ codex_auth_id: "codex_old" });
    expect(sqlite.prepare("SELECT key_hash FROM api_keys WHERE id = 'key_move'").get()).toEqual({ key_hash: "hash_move" });
    await expect(migrateCredentialBindings(env, ACTOR, {
      kind: "codex",
      account_id: "codex_old",
      replacement_account_id: "codex_new",
      key_ids: ["key_move"],
      default_surfaces: ["surface:codex:production"]
    }, NOW)).rejects.toMatchObject({ code: "retirement_unchanged" });
    expect(sqlite.prepare("SELECT count(*) AS count FROM operator_mutation_audit").get()).toEqual(auditsAfterRetry);
    expect(sqlite.prepare("SELECT status FROM codex_auths WHERE id = 'codex_old'").get()).toEqual({ status: "revoked" });
  });
});

describe("credential default routes", () => {
  it.each(["codex", "grok"] as const)("preserves operator %s cleanup JSON after explicit disconnect and partial token cleanup", async kind => {
    const { env, sqlite } = fixture();
    if (kind === "codex") seedCodex(sqlite, "old", "retiring", "2026-09-01T00:00:00.000Z");
    else seedGrok(sqlite, "old", "retiring");
    let cleanupAttempts = 0;
    const cleanup = async () => {
      cleanupAttempts++;
      if (cleanupAttempts === 1) throw new Error("Synthetic cleanup unavailable");
    };
    const runtime = makeFixture({ env: { ...env, TOKEN_AUTHORITY: {
      idFromName: (name: string) => name,
      get: () => ({ revoke: cleanup, revokeSubscription: cleanup })
    } as unknown as Env["TOKEN_AUTHORITY"] } });
    const path = `https://api.trustedtunnel.app/admin/${kind === "codex" ? "codex-auths" : "subscriptions"}/old`;
    const denied = await admin(runtime, `${path}/cleanup`, { method: "POST" });
    expect(denied.status).toBe(409);
    expect(denied.headers.get("Content-Type")).toContain("application/json");
    expect(await denied.json()).toMatchObject({ error: { code: "credential_cleanup_not_ready" } });
    expect(cleanupAttempts).toBe(0);
    const disconnected = await admin(runtime, `${path}/disconnect`, { method: "POST" });
    expect(disconnected.status).toBe(200);
    expect(await disconnected.json()).toEqual({ completion: "partial", d1_status: "revoked", token_cleanup: "failed", recovery: "retry_cleanup", live_bindings: 0 });
    const retried = await admin(runtime, `${path}/cleanup`, { method: "POST" });
    expect(retried.status).toBe(200);
    expect(retried.headers.get("Content-Type")).toContain("application/json");
    expect(await retried.json()).toEqual({ completion: "complete", d1_status: "revoked", token_cleanup: "cleared" });
    expect(cleanupAttempts).toBe(2);
    const table = kind === "codex" ? "codex_auths" : "subscription_accounts";
    expect(sqlite.prepare(`SELECT status FROM ${table} WHERE id='old'`).get()).toEqual({ status: "revoked" });
    expect(sqlite.prepare("SELECT action,result FROM operator_mutation_audit ORDER BY rowid").all()).toEqual([
      { action: "credential.disconnect", result: "ok" }, { action: "credential.cleanup_retry", result: "ok" }
    ]);
  });

  it("lets an operator set a default and keeps account ids off the member availability read", async () => {
    const fixture = makeFixture();
    const user = await createUser(fixture, "availability@example.com");
    fixture.db.ensureCredentialAccountsForScopes(["surface:codex:production"]);
    await fixture.tokenAuthority.saveToken({
      auth_id: "shared_default",
      access_token: "shared_access",
      expires_at: "2020-01-01T00:00:00.000Z",
      status: "active"
    });
    const set = await admin(fixture, "https://api.trustedtunnel.app/admin/credential-defaults/codex", {
      method: "PUT",
      body: { credential_account_id: "shared_default" }
    });
    expect(set.status).toBe(200);
    {
      const memberCookie = await consoleCookie(fixture, "availability@example.com");
      const member = await handleRequest(new Request("https://admin.example.test/me/service-availability", {
        headers: { Cookie: `__Host-mini-console=${memberCookie}` }
      }), fixture.env, fixture.ctx, fixture.deps);
      expect(member.status).toBe(200);
      const body = await member.json() as { services: Array<{ surface: string; available: boolean }> };
      expect(body.services.find((service) => service.surface === "codex")).toEqual({ surface: "codex", available: true });
      expect(JSON.stringify(body)).not.toContain("shared_default");
      const denied = await handleRequest(new Request("https://admin.example.test/admin/ui/credential-defaults/codex", {
        method: "POST",
        headers: {
          Cookie: `__Host-mini-console=${memberCookie}`,
          Origin: "https://admin.example.test",
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ confirm: true, credential_account_id: "shared_default" })
      }), fixture.env, fixture.ctx, fixture.deps);
      expect(denied.status).toBe(403);
      const unguarded = await handleRequest(new Request("https://admin.example.test/admin/ui/credential-defaults/codex", {
        method: "POST",
        headers: {
          Cookie: `__Host-mini-console=${memberCookie}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ confirm: true, credential_account_id: "shared_default" })
      }), fixture.env, fixture.ctx, fixture.deps);
      expect(unguarded.status).toBe(403);
      const forced = await handleRequest(new Request("https://admin.example.test/admin/ui/codex-auths/shared_default/force-disconnect", {
        method: "POST",
        headers: {
          Cookie: `__Host-mini-console=${memberCookie}`,
          Origin: "https://admin.example.test",
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ confirm: true })
      }), fixture.env, fixture.ctx, fixture.deps);
      expect(forced.status).not.toBe(200);
    }
    expect(user.user.id).toBeTruthy();
  });
});

function fixture(options: Parameters<typeof createTestD1>[0] = {}): { env: Env; sqlite: DatabaseSync } {
  const testDb = createTestD1(options);
  onTestFinished(() => testDb.close());
  testDb.sqlite.prepare(
    "INSERT INTO users (id, email, canonical_email, role, status, login_capable, account_kind, created_at, updated_at) VALUES ('user_a', 'a@example.com', 'a@example.com', 'user', 'active', 1, 'human', ?, ?)"
  ).run(NOW.toISOString(), NOW.toISOString());
  testDb.sqlite.prepare("UPDATE organization_surface_credit_defaults SET monthly_allowance = 10").run();
  return { sqlite: testDb.sqlite, env: { DB: testDb.binding, CONSOLE_EMAIL_DOMAIN: "example.com", ADMIN_DASHBOARD_HOST: "admin.example.test", API_KEY_HASH_PEPPER: "synthetic-test-pepper" } as Env };
}

function seedAdmin(sqlite: DatabaseSync): void {
  sqlite.prepare("INSERT INTO users (id, email, canonical_email, role, status, account_kind, login_capable, created_at, updated_at) VALUES ('admin_user', 'admin@example.com', 'admin@example.com', 'admin', 'active', 'human', 1, ?, ?)").run(NOW.toISOString(), NOW.toISOString());
}

function seedCodex(sqlite: DatabaseSync, id: string, status: string, expiresAt: string): void {
  sqlite.prepare(
    `INSERT INTO codex_auths (id, kind, label, environment, status, expires_at, created_at, updated_at)
     VALUES (?, 'shared', ?, 'production', ?, ?, ?, ?)`
  ).run(id, id, status, expiresAt, NOW.toISOString(), NOW.toISOString());
}

function seedGrok(sqlite: DatabaseSync, id: string, status: string): void {
  sqlite.prepare(
    `INSERT INTO subscription_accounts
       (id, capability_source, environment, label, status, refresh_available, created_at, updated_at)
     VALUES (?, 'grok', 'production', ?, ?, 1, ?, ?)`
  ).run(id, id, status, NOW.toISOString(), NOW.toISOString());
}

function seedSurfaceBinding(sqlite: DatabaseSync, id: string, surface: "codex" | "grok" | "xai", accountId: string): void {
  const grant = `surface:${surface}:production`;
  sqlite.prepare(`INSERT INTO api_keys (id,user_id,key_prefix,key_hash,status,scopes,created_at)
    VALUES (?,'user_a',?,'synthetic-hash','active',?,?)`).run(id, `display_${id}`, JSON.stringify([grant]), NOW.toISOString());
  sqlite.prepare(`INSERT INTO api_key_surface_credentials
    (api_key_id,surface_grant,codex_auth_id,subscription_account_id,created_at,updated_at)
    VALUES (?,?,?,?,?,?)`).run(id, grant, surface === "codex" ? accountId : null,
      surface === "codex" ? null : accountId, NOW.toISOString(), NOW.toISOString());
}

function seedKey(sqlite: DatabaseSync, id: string, codexAuthId: string, keyHash: string, familyId = `family:${id}`): void {
  sqlite.prepare(
    `INSERT INTO api_keys
       (id, user_id, key_prefix, key_hash, status, scopes, family_id, created_at)
     VALUES (?, 'user_a', ?, ?, 'active', '["surface:codex:production"]', ?, ?)`
  ).run(id, id.slice(0, 12), keyHash, familyId, NOW.toISOString());
  sqlite.prepare(
    `INSERT INTO api_key_surface_credentials
       (api_key_id, surface_grant, codex_auth_id, subscription_account_id, created_at, updated_at)
     VALUES (?, 'surface:codex:production', ?, NULL, ?, ?)`
  ).run(id, codexAuthId, NOW.toISOString(), NOW.toISOString());
}
