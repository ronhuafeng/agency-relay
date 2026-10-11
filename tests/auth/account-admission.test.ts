import { readFileSync, readdirSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { commitCodexAdmission } from "../../src/auth/account-admission";
import { commitIssuedKey, replaceMemberKey } from "../../src/auth/api-keys";
import { createConsoleSession } from "../../src/auth/console-session";
import { replaceApiKeySurfaceCredential } from "../../src/auth/bindings";
import {
  commitCredentialDefault, migrateCredentialBindings, readServiceAvailability,
  selectIssuanceDefaults, type CredentialActor
} from "../../src/auth/credential-defaults";
import { resolveCredentialSlot } from "../../src/auth/slots";
import { TokenAuthority } from "../../src/auth/token-authority";
import { readTokenResult } from "../../src/auth/token-result";
import { createCodexAuth, getCodexAuth } from "../../src/db";
import { decryptJson, hmacSha256Hex, keyPrefix } from "../../src/crypto";
import { handleRequest } from "../../src/router";
import type { TokenCiphertext } from "../../src/types";
import { createTestD1 } from "../support/sqlite-d1";
import { seedIdentityVersions } from "../support/identity-version";

const NOW = new Date("2026-10-06T12:00:00.000Z");
const CODEX = "surface:codex:production";
const GROK = "surface:grok:production";
const XAI = "surface:xai:production";
const ACTOR: CredentialActor = {
  kind: "access", userId: "admin", email: "admin@example.test", subject: "synthetic-admin",
  role: "admin", sessionEpoch: 0, requestId: "account-admission"
};
const OPERATOR: CredentialActor = { ...ACTOR, kind: "admin_secret", userId: null, email: null, subject: null, role: null };

// Accept a state-only pause of exactly A; reject logout, shared-account fallback,
// stale-authority writes or a refresh that restores admission. SQL shape and
// helper organization may change without changing these persisted outcomes.
describe("ChatGPT account admission", () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

  it("migrates existing accounts as enabled without rewriting their data or sticky assignments", async () => {
    const migration = "0039_codex_account_admission.sql";
    const migrations = readdirSync(new URL("../../migrations/", import.meta.url))
      .filter(name => /^\d{4}_.+\.sql$/.test(name) && name < migration).sort();
    const f = fixture({ migrations });
    const before = preserved(f.db.sqlite);
    const accounts = f.db.sqlite.prepare("SELECT * FROM codex_auths ORDER BY id").all();
    f.db.sqlite.exec(readFileSync(new URL(`../../migrations/${migration}`, import.meta.url), "utf8"));
    expect(f.db.sqlite.prepare("SELECT id, admission_state FROM codex_auths ORDER BY id").all()).toEqual([
      { id: "account_a", admission_state: "enabled" }, { id: "account_b", admission_state: "enabled" }
    ]);
    expect(f.db.sqlite.prepare("SELECT * FROM codex_auths ORDER BY id").all()
      .map(({ admission_state: _state, ...row }) => row)).toEqual(accounts);
    expect(preserved(f.db.sqlite)).toEqual(before);
    expect(await createCodexAuth(f.env, { label: "New account" }, NOW)).toMatchObject({ admission_state: "enabled" });
    expect(() => f.db.sqlite.exec("UPDATE codex_auths SET admission_state='unknown' WHERE id='account_a'"))
      .toThrow(/CHECK constraint failed/);
  });

  it("repeated pause/resume preserves credentials, keys, defaults, allowances and historical usage", async () => {
    const f = fixture();
    const { authority, storage } = tokenAuthority(f.env);
    readTokenResult(await authority.saveToken({
      auth_id: "account_a", access_token: "synthetic-access", refresh_token: "synthetic-refresh",
      expires_at: "2099-01-01T00:00:00.000Z", status: "active"
    }));
    const ciphertext = structuredClone(await storage.get("token"));
    const before = preserved(f.db.sqlite);
    const metadata = await getCodexAuth(f.env, "account_a");
    for (const state of ["paused", "paused", "enabled", "enabled"] as const) {
      expect(await commitCodexAdmission(f.env, ACTOR, "account_a", state, NOW))
        .toEqual({ ...metadata, admission_state: state });
      expect(await getCodexAuth(f.env, "account_a")).toEqual({ ...metadata, admission_state: state });
      expect(preserved(f.db.sqlite)).toEqual(before);
      expect(await storage.get("token")).toEqual(ciphertext);
    }
    expect(f.tokenReads).toEqual([]);
    expect(audits(f.db.sqlite)).toEqual(["paused", "paused", "enabled", "enabled"].map(state => ({
      action: state === "paused" ? "credential.codex_pause" : "credential.codex_resume",
      target_type: "codex_auth", target_id: "account_a", actor_user_id: "admin", actor_role: "admin",
      result: "ok", meta: JSON.stringify({ admission_state: state })
    })));
  });

  it.each([
    ["member", "UPDATE users SET role='user' WHERE id='admin'", false],
    ["demotion after admission", "UPDATE users SET role='user' WHERE id='admin'", true],
    ["session invalidation", "UPDATE users SET console_session_epoch=1 WHERE id='admin'", true]
  ] as const)("rejects %s without a state change or success audit", async (_name, change, race) => {
    const f = fixture(race ? { onBatch: () => f.db.sqlite.exec(change) } : {});
    if (!race) f.db.sqlite.exec(change);
    const before = await getCodexAuth(f.env, "account_a");
    await expect(commitCodexAdmission(f.env, ACTOR, "account_a", "paused", NOW))
      .rejects.toMatchObject({ status: 403, code: "admin_required" });
    expect(await getCodexAuth(f.env, "account_a")).toEqual(before);
    expect(audits(f.db.sqlite)).toEqual([]);
  });

  it("rolls back the state if its success audit fails, and never audits a missing target", async () => {
    const f = fixture();
    await expect(commitCodexAdmission(f.env, ACTOR, "missing", "paused", NOW))
      .rejects.toMatchObject({ status: 404, code: "codex_auth_not_found" });
    f.db.sqlite.exec(`CREATE TRIGGER reject_admission_audit BEFORE INSERT ON operator_mutation_audit
      WHEN NEW.action='credential.codex_pause' BEGIN SELECT RAISE(ABORT,'synthetic audit failure'); END;`);
    await expect(commitCodexAdmission(f.env, ACTOR, "account_a", "paused", NOW)).rejects.toThrow("synthetic audit failure");
    expect(await getCodexAuth(f.env, "account_a")).toMatchObject({ admission_state: "enabled", status: "active" });
    expect(audits(f.db.sqlite)).toEqual([]);
  });

  it("operator and console routes require confirmation and current admin authority, then expose the same committed state", async () => {
    const f = fixture();
    const sessions = new Map<string, string>();
    for (const id of ["admin", "owner"]) sessions.set(id, await createConsoleSession(f.env, {
      id, email: `${id}@example.test`, sessionEpoch: 0
    }, NOW));
    const send = (kind: "operator" | "admin" | "owner", action: "pause" | "resume", confirm?: number) => {
      const browser = kind !== "operator";
      const host = browser ? "admin.example.test" : "api.trustedtunnel.app";
      const headers = new Headers({ "Content-Type": "application/json" });
      if (browser) {
        headers.set("Cookie", `__Host-mini-console=${sessions.get(kind)}`);
        headers.set("Origin", `https://${host}`);
      } else headers.set("Authorization", `Bearer ${f.env.ADMIN_SECRET}`);
      return handleRequest(new Request(`https://${host}/admin/${browser ? "ui/" : ""}codex-auths/account_a/${action}`, {
        method: "POST", headers, body: JSON.stringify({ confirm })
      }), f.env, { waitUntil() {} }, { now: () => NOW, fetch: async () => { throw new Error("No provider operation expected"); } });
    };
    const unconfirmed = await send("operator", "pause");
    expect(unconfirmed.status).toBe(400);
    expect(await unconfirmed.json()).toMatchObject({ error: { code: "confirm_required" } });
    expect((await send("owner", "pause", 1)).status).toBe(403);
    expect(await getCodexAuth(f.env, "account_a")).toMatchObject({ admission_state: "enabled" });
    expect(audits(f.db.sqlite)).toEqual([]);
    for (const [kind, action, state] of [["operator", "pause", "paused"], ["admin", "resume", "enabled"]] as const) {
      const response = await send(kind, action, 1);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ auth: { id: "account_a", status: "active", admission_state: state } });
      expect(await getCodexAuth(f.env, "account_a")).toMatchObject({ admission_state: state });
    }
    expect(audits(f.db.sqlite)).toEqual([
      { action: "credential.codex_pause", target_type: "codex_auth", target_id: "account_a", actor_user_id: null,
        actor_role: null, result: "ok", meta: JSON.stringify({ admission_state: "paused" }) },
      { action: "credential.codex_resume", target_type: "codex_auth", target_id: "account_a", actor_user_id: "admin",
        actor_role: "admin", result: "ok", meta: JSON.stringify({ admission_state: "enabled" }) }
    ]);
    expect(f.tokenReads).toEqual([]);
  });

  it("rejects A before token access or provider dispatch while B, Grok and xAI still dispatch", async () => {
    const f = fixture();
    const tokens = new Map<string, string>();
    for (const id of ["key_a", "key_b", "key_grok"]) {
      const token = `cfwd_${id}_synthetic_route_test`;
      tokens.set(id, token);
      f.db.sqlite.prepare("UPDATE api_keys SET key_prefix=?,key_hash=? WHERE id=?")
        .run(keyPrefix(token), await hmacSha256Hex(f.env.API_KEY_HASH_PEPPER, token), id);
    }
    const forwarded: string[] = [];
    const waits: Promise<unknown>[] = [];
    const request = (key: string, host: string) => handleRequest(new Request(`https://${host}/v1/models`, {
      headers: { Authorization: `Bearer ${tokens.get(key)}` }
    }), f.env, { waitUntil: work => { waits.push(work); } }, {
      now: () => NOW,
      fetch: async (url) => { forwarded.push(String(url)); return Response.json({ models: [] }); }
    });
    try {
      await commitCodexAdmission(f.env, ACTOR, "account_a", "paused", NOW);
      const before = preserved(f.db.sqlite);
      const denied = await request("key_a", "api.trustedtunnel.app");
      expect(denied.status).toBe(503);
      expect(await denied.json()).toMatchObject({ error: { code: "credential_paused" } });
      expect(f.tokenReads).toEqual([]);
      expect(forwarded).toEqual([]);
      expect(preserved(f.db.sqlite)).toEqual(before);
      for (const [key, host] of [
        ["key_b", "api.trustedtunnel.app"], ["key_grok", "grok.trustedtunnel.app"], ["key_grok", "xai.trustedtunnel.app"]
      ]) {
        const response = await request(key!, host!);
        const body = await response.json() as { error?: { code?: string } };
        expect({ host, status: response.status, error: body.error?.code }).toEqual({ host, status: 200, error: undefined });
      }
      expect([...new Set(f.tokenReads)].sort()).toEqual(["account_b", "subscription:account_a"]);
      expect(forwarded).toHaveLength(3);
      await commitCodexAdmission(f.env, ACTOR, "account_a", "enabled", NOW);
      expect((await request("key_a", "api.trustedtunnel.app")).status).toBe(200);
      expect(f.tokenReads.at(-1)).toBe("account_a");
      expect(forwarded).toHaveLength(4);
    } finally { await Promise.all(waits); }
  });

  it("resume removes only admission and cannot revive revoked or reauthorization-required credentials", async () => {
    const f = fixture();
    await commitCodexAdmission(f.env, OPERATOR, "account_a", "paused", NOW);
    for (const [status, code] of [["revoked", "credential_inactive"], ["reauth_required", "reauth_required"]]) {
      f.db.sqlite.prepare("UPDATE codex_auths SET status=? WHERE id='account_a'").run(status!);
      await commitCodexAdmission(f.env, OPERATOR, "account_a", "enabled", NOW);
      await expect(resolveCredentialSlot(f.env, "chatgpt_production", { apiKeyId: "key_a", surfaceGrant: CODEX }))
        .rejects.toMatchObject({ code });
      expect(await getCodexAuth(f.env, "account_a")).toMatchObject({ admission_state: "enabled", status });
    }
    expect(f.tokenReads).toEqual([]);
  });

  it("allows a request past account metadata admission to finish, then blocks the next request before token access", async () => {
    const f = fixture();
    const token = "cfwd_admitted_synthetic_request";
    f.db.sqlite.prepare("UPDATE api_keys SET key_prefix=?,key_hash=? WHERE id='key_a'")
      .run(keyPrefix(token), await hmacSha256Hex(f.env.API_KEY_HASH_PEPPER, token));
    let entered!: () => void; let release!: () => void;
    const reached = new Promise<void>(resolve => { entered = resolve; });
    const held = new Promise<void>(resolve => { release = resolve; });
    f.env.TOKEN_AUTHORITY = {
      idFromName: (name: string) => name,
      get: (id: string) => ({ getFreshAccessToken: async () => {
        f.tokenReads.push(id); entered(); await held;
        return { ok: true, value: { access_token: "synthetic-admitted-access" } };
      } })
    } as unknown as Env["TOKEN_AUTHORITY"];
    const forwarded: string[] = [];
    const waits: Promise<unknown>[] = [];
    const request = () => handleRequest(new Request("https://api.trustedtunnel.app/v1/models", {
      headers: { Authorization: `Bearer ${token}` }
    }), f.env, { waitUntil: work => { waits.push(work); } }, {
      now: () => NOW,
      fetch: async url => { forwarded.push(String(url)); return Response.json({ models: [] }); }
    });
    const admitted = request();
    let primaryFailure: unknown;
    try {
      expect(await Promise.race([reached.then(() => true), admitted.then(() => false)])).toBe(true);
      expect(f.tokenReads).toEqual(["account_a"]);
      expect(forwarded).toEqual([]);
      await commitCodexAdmission(f.env, ACTOR, "account_a", "paused", NOW);
      expect(await getCodexAuth(f.env, "account_a")).toMatchObject({ admission_state: "paused" });
      release();
      const completed = await admitted;
      await completed.arrayBuffer();
      expect(completed.status).toBe(200);
      expect(forwarded).toHaveLength(1);
      const subsequent = await request();
      expect(subsequent.status).toBe(503);
      expect(await subsequent.json()).toMatchObject({ error: { code: "credential_paused" } });
      expect(f.tokenReads).toEqual(["account_a"]);
      expect(forwarded).toHaveLength(1);
    } catch (error) { primaryFailure = error; }
    finally {
      release();
      const requestResults = await Promise.allSettled([admitted]);
      const bodyResults = await Promise.allSettled(requestResults.flatMap(result =>
        result.status === "fulfilled" && !result.value.bodyUsed && result.value.body
          ? [result.value.body.cancel()] : []));
      const backgroundResults = await Promise.allSettled(waits);
      const failures = [...requestResults, ...bodyResults, ...backgroundResults]
        .filter((result): result is PromiseRejectedResult => result.status === "rejected").map(result => result.reason);
      if (primaryFailure !== undefined) failures.unshift(primaryFailure);
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1) throw new AggregateError(failures, "Admission boundary assertion or cleanup failed");
    }
  });

  it("a held refresh and later OAuth credential save cannot clear a committed pause", async () => {
    vi.useFakeTimers(); vi.setSystemTime(NOW);
    const f = fixture();
    const { authority, storage } = tokenAuthority(f.env);
    readTokenResult(await authority.saveToken({
      auth_id: "account_a", access_token: "synthetic-old", refresh_token: "synthetic-refresh",
      expires_at: "2099-01-01T00:00:00.000Z", status: "active"
    }));
    let entered!: () => void; let release!: () => void;
    const reached = new Promise<void>(resolve => { entered = resolve; });
    const held = new Promise<void>(resolve => { release = resolve; });
    vi.stubGlobal("fetch", async () => { entered(); await held; return Response.json({
      access_token: "synthetic-refreshed", refresh_token: "synthetic-next-refresh", expires_in: 3600
    }); });
    const refresh = authority.refreshNow();
    try {
      expect(await Promise.race([reached.then(() => true), refresh.then(() => false)])).toBe(true);
      await commitCodexAdmission(f.env, ACTOR, "account_a", "paused", NOW);
    } finally { release(); await refresh; }
    readTokenResult(await refresh);
    expect(await getCodexAuth(f.env, "account_a")).toMatchObject({ admission_state: "paused", status: "active" });
    const refreshed = await decryptJson<{ access_token: string }>(f.env.TOKEN_ENCRYPTION_KEY_V1, (await storage.get<TokenCiphertext>("token"))!);
    expect(refreshed.access_token === "synthetic-refreshed").toBe(true);
    // OAuth completion/import share saveToken's encrypted-save and metadata path.
    readTokenResult(await authority.saveToken({
      auth_id: "account_a", access_token: "synthetic-reauthorized", refresh_token: "synthetic-new-refresh",
      expires_at: "2099-01-01T00:00:00.000Z", status: "active"
    }));
    await expect(resolveCredentialSlot(f.env, "chatgpt_production", { apiKeyId: "key_a", surfaceGrant: CODEX }))
      .rejects.toMatchObject({ code: "credential_paused" });
    expect(f.tokenReads).toEqual([]);
    expect(await getCodexAuth(f.env, "account_a")).toMatchObject({ admission_state: "paused", status: "active" });
  });

  it("keeps a paused default in place but excludes it from new selection and replacement", async () => {
    const f = fixture();
    await commitCodexAdmission(f.env, ACTOR, "account_a", "paused", NOW);
    const before = preserved(f.db.sqlite);
    const probed: string[] = [];
    const probe = async (_env: Env, kind: "codex" | "grok", id: string) => { probed.push(`${kind}:${id}`); };
    expect(await readServiceAvailability(f.env, probe, NOW)).toEqual([
      { surface: "codex", available: false }, { surface: "grok", available: true }, { surface: "xai", available: true }
    ]);
    await expect(selectIssuanceDefaults(f.env, [CODEX], probe, NOW)).rejects.toMatchObject({ code: "credential_default_unavailable" });
    expect([...new Set(probed)]).toEqual(["grok:account_a"]);
    await expect(replaceMemberKey(f.env, OPERATOR, "owner", "key_a", null, NOW))
      .rejects.toMatchObject({ code: "replacement_bindings_unavailable" });
    expect(preserved(f.db.sqlite)).toEqual(before);
    expect(audits(f.db.sqlite)).toHaveLength(1);
  });

  // Each operation is a different committing owner. The pause lands after its
  // advisory reads but before SQL; no partial key, binding, default or audit may survive.
  it.each(["issue", "replace", "rebind", "default", "migration"] as const)("rejects a concurrent pause at %s commit atomically", async operation => {
    let inject = false;
    const f = fixture({ onBatch: () => {
      if (inject) { inject = false; f.db.sqlite.exec("UPDATE codex_auths SET admission_state='paused' WHERE id='account_a'"); }
    } });
    const before = preserved(f.db.sqlite);
    inject = true;
    const pending = operation === "issue" ? commitIssuedKey(f.env, OPERATOR, {
      user_id: "owner", name: "New", scopes: [CODEX], expires_at: "2026-11-01T00:00:00.000Z",
      selections: [{ surface_grant: CODEX, credential_account_id: "account_a" }], action: "key.create"
    }, NOW) : operation === "replace" ? replaceMemberKey(f.env, OPERATOR, "owner", "key_a", null, NOW)
      : operation === "rebind" ? replaceApiKeySurfaceCredential(f.env, {
        api_key_id: "key_b", surface_grant: CODEX, credential_account_id: "account_a"
      }, OPERATOR, NOW) : operation === "default" ? commitCredentialDefault(f.env, OPERATOR, {
        surface_grant: CODEX, credential_account_id: "account_a"
      }, NOW) : migrateCredentialBindings(f.env, OPERATOR, {
        kind: "codex", account_id: "account_b", replacement_account_id: "account_a",
        key_ids: ["key_b"], default_surfaces: [CODEX]
      }, NOW);
    const codes = {
      issue: "credential_not_selectable", replace: "replacement_bindings_unavailable",
      rebind: "credential_binding_changed", default: "credential_default_unavailable", migration: "retirement_unchanged"
    };
    await expect(pending).rejects.toMatchObject({ status: 409, code: codes[operation] });
    expect(inject).toBe(false);
    expect(preserved(f.db.sqlite)).toEqual(before);
    expect(audits(f.db.sqlite)).toEqual([]);
    expect(await getCodexAuth(f.env, "account_b")).toMatchObject({ status: "active", admission_state: "enabled" });
  });
});

function fixture(options: Parameters<typeof createTestD1>[0] = {}) {
  const db = createTestD1(options);
  onTestFinished(() => db.close());
  seedIdentityVersions(db.sqlite);
  db.sqlite.exec(`INSERT INTO users (id,email,canonical_email,login_capable,account_kind,role,status,created_at,updated_at)
    VALUES ('admin','admin@example.test','admin@example.test',1,'human','admin','active','t','t'),
      ('owner','owner@example.test','owner@example.test',1,'human','user','active','t','t');
    UPDATE organization_surface_credit_defaults SET monthly_allowance=100;
    INSERT INTO codex_auths (id,kind,label,environment,status,expires_at,created_at,updated_at)
      VALUES ('account_a','shared','ChatGPT A','production','active','2099-01-01T00:00:00.000Z','t','t'),
        ('account_b','shared','ChatGPT B','production','active','2099-01-01T00:00:00.000Z','t','t');
    INSERT INTO subscription_accounts (id,capability_source,environment,label,status,refresh_available,created_at,updated_at)
      VALUES ('account_a','grok','production','Grok with colliding ID','active',1,'t','t');
    INSERT INTO user_surface_credit_policies (user_id,surface_grant,monthly_allowance,created_at,updated_at)
      VALUES ('owner','${CODEX}',40,'t','t');
    INSERT INTO user_surface_credit_usage (user_id,surface_grant,period_start,consumed_credits,admitted_attempts,last_seen_at)
      VALUES ('owner','${CODEX}','2026-09-01',7,7,'2026-09-05T00:00:00.000Z');
    INSERT INTO usage_daily (user_id,day,route_profile_id,response_model,requests,ok_requests,total_tokens,last_seen_at)
      VALUES ('owner','2026-09-05','codex.responses','synthetic-model',7,7,100,'2026-09-05T00:00:00.000Z');`);
  for (const [id, grants] of [["key_a", [CODEX]], ["key_b", [CODEX]], ["key_grok", [GROK, XAI]]] as const) {
    db.sqlite.prepare(`INSERT INTO api_keys (id,user_id,key_prefix,key_hash,name,status,scopes,family_id,expires_at,last_used_at,created_at)
      VALUES (?,'owner',?,?,'Work','active',?,?,'2099-01-01T00:00:00.000Z',?,'t')`)
      .run(id, `display_${id}`, `synthetic_hash_${id}`, JSON.stringify(grants), `family:${id}`, NOW.toISOString());
    for (const grant of grants) db.sqlite.prepare(`INSERT INTO api_key_surface_credentials
      (api_key_id,surface_grant,codex_auth_id,subscription_account_id,created_at,updated_at) VALUES (?,?,?,?,'t','t')`)
      .run(id, grant, grant === CODEX ? id === "key_a" ? "account_a" : "account_b" : null, grant === CODEX ? null : "account_a");
  }
  for (const grant of [CODEX, GROK, XAI]) db.sqlite.prepare(`INSERT INTO organization_surface_credential_defaults
    (surface_grant,codex_auth_id,subscription_account_id,created_at,updated_at) VALUES (?,?,?,'t','t')`)
    .run(grant, grant === CODEX ? "account_a" : null, grant === CODEX ? null : "account_a");
  const tokenReads: string[] = [];
  const env = {
    DB: db.binding, API_KEY_HASH_PEPPER: "synthetic-pepper", TOKEN_ENCRYPTION_KEY_V1: "synthetic-encryption",
    CONSOLE_EMAIL_DOMAIN: "example.test", ADMIN_DASHBOARD_HOST: "admin.example.test", ADMIN_SECRET: "synthetic-admin",
    REQUEST_AUDIT_RETENTION_DAYS: "30",
    CODEX_EGRESS_BASE_URL: "https://codex-egress-us-west1-a.trustedtunnel.app", CODEX_EGRESS_SECRET: "synthetic-egress",
    CODEX_OAUTH_TOKEN_URL: "https://oauth.example.test/token", CODEX_CLIENT_ID: "synthetic-client",
    TOKEN_AUTHORITY: {
      idFromName: (name: string) => name,
      get: (id: string) => ({
        getFreshAccessToken: async () => { tokenReads.push(id); return { ok: true, value: { access_token: "synthetic-codex" } }; },
        getFreshSubscriptionCredential: async () => { tokenReads.push(id); return { ok: true, value: { access_token: "synthetic-grok" } }; }
      })
    }
  } as unknown as Env;
  return { db, env, tokenReads };
}

function preserved(sqlite: DatabaseSync) {
  return Object.fromEntries([
    "api_keys", "api_key_surface_credentials", "organization_surface_credential_defaults", "subscription_accounts",
    "organization_surface_credit_defaults", "user_surface_credit_policies", "user_surface_credit_modes",
    "user_surface_credit_usage", "usage_daily", "media_usage_daily"
  ].map(table => [table, sqlite.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
}
function audits(sqlite: DatabaseSync) {
  return sqlite.prepare(`SELECT action,target_type,target_id,actor_user_id,actor_role,result,meta
    FROM operator_mutation_audit ORDER BY rowid`).all();
}

function tokenAuthority(env: Env) {
  // Local storage is an explicit external seam; these tests claim D1 admission
  // and encrypted-material preservation, not a cross-store transaction.
  const values = new Map<string, unknown>();
  const storage = {
    get: async <T>(key: string) => values.get(key) as T | undefined,
    put: async (key: string, value: unknown) => { values.set(key, value); },
    delete: async (key: string) => values.delete(key),
    setAlarm: async (_at: number) => undefined,
    deleteAlarm: async () => undefined,
    transaction: async <T>(closure: (txn: unknown) => Promise<T>) => closure(storage)
  };
  const authority = new TokenAuthority({ storage, waitUntil() {} } as unknown as DurableObjectState, env);
  return { authority, storage };
}
