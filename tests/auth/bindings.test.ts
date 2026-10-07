import { describe, expect, it, onTestFinished } from "vitest";
import {
  listApiKeySurfaceCredentials,
  replaceApiKeySurfaceCredential
} from "../../src/auth/bindings";
import { commitIssuedKey, type KeyActor } from "../../src/auth/api-keys";
import { createTestD1 } from "../support/sqlite-d1";

const NOW = new Date("2026-08-30T00:00:00.000Z");
const ACTOR: KeyActor = { kind: "admin_secret", email: null, subject: null, userId: null, role: null, requestId: "req_binding" };

describe("API key Surface Credential bindings", () => {
  it("binds each Surface to one compatible physical account and copies bindings on replacement", async () => {
    const { env, sqlite } = fixture();
    const first = await commitIssuedKey(env, ACTOR, {
      user_id: "user_binding",
      name: "Workstation",
      action: "key.create",
      scopes: ["surface:codex:production", "surface:grok:production", "surface:xai:production"],
      expires_at: null,
      selections: [
        { surface_grant: "surface:codex:production", credential_account_id: "auth_a" },
        { surface_grant: "surface:grok:production", credential_account_id: "sub_a" },
        { surface_grant: "surface:xai:production", credential_account_id: "sub_b" }
      ]
    }, NOW);

    expect(first.family_id).toEqual(expect.stringMatching(/\S/));
    expect(sqlite.prepare("SELECT family_id FROM api_keys WHERE id = ?").get(first.id))
      .toEqual({ family_id: first.family_id });
    expect(await listApiKeySurfaceCredentials(env, first.id)).toEqual([
      expect.objectContaining({ surface_grant: "surface:codex:production", codex_auth_id: "auth_a" }),
      expect.objectContaining({ surface_grant: "surface:grok:production", subscription_account_id: "sub_a" }),
      expect.objectContaining({ surface_grant: "surface:xai:production", subscription_account_id: "sub_b" })
    ]);

    const replacement = await commitIssuedKey(env, ACTOR, {
      user_id: "user_binding",
      name: "Workstation replacement",
      action: "key.replace.create",
      family_id: first.family_id!,
      scopes: ["surface:codex:production", "surface:grok:production", "surface:xai:production"],
      expires_at: null,
      copy_bindings_from_api_key_id: first.id
    }, NOW);
    expect((await listApiKeySurfaceCredentials(env, replacement.id)).map((row) => [
      row.surface_grant,
      row.codex_auth_id ?? row.subscription_account_id
    ])).toEqual([
      ["surface:codex:production", "auth_a"],
      ["surface:grok:production", "sub_a"],
      ["surface:xai:production", "sub_b"]
    ]);
  });

  it("changes one binding without changing the other Surface bindings", async () => {
    const { env } = fixture();
    const key = await commitIssuedKey(env, ACTOR, {
      user_id: "user_binding",
      name: "Service",
      action: "key.create",
      scopes: ["surface:grok:production", "surface:xai:production"],
      expires_at: null,
      selections: [
        { surface_grant: "surface:grok:production", credential_account_id: "sub_a" },
        { surface_grant: "surface:xai:production", credential_account_id: "sub_a" }
      ]
    }, NOW);

    await replaceApiKeySurfaceCredential(env, {
      api_key_id: key.id,
      surface_grant: "surface:xai:production",
      credential_account_id: "sub_b"
    }, ACTOR, NOW);

    expect((await listApiKeySurfaceCredentials(env, key.id)).map((row) => [
      row.surface_grant,
      row.subscription_account_id
    ])).toEqual([
      ["surface:grok:production", "sub_a"],
      ["surface:xai:production", "sub_b"]
    ]);
  });

  it("issues a key for explicit unlimited when the organization default is zero", async () => {
    const { env, sqlite } = fixture();
    sqlite.prepare("UPDATE organization_surface_credit_defaults SET monthly_allowance = 0").run();
    const at = NOW.toISOString();
    sqlite.prepare(
      `INSERT INTO user_surface_credit_modes (user_id, surface_grant, mode, created_at, updated_at)
       VALUES ('user_binding', 'surface:codex:production', 'unlimited', ?, ?)`
    ).run(at, at);
    const key = await commitIssuedKey(env, ACTOR, {
      user_id: "user_binding",
      name: "Unlimited",
      action: "key.create",
      scopes: ["surface:codex:production"],
      expires_at: null,
      selections: [{ surface_grant: "surface:codex:production", credential_account_id: "auth_a" }]
    }, NOW);
    expect(key.user_id).toBe("user_binding");
    expect(key.family_id).toEqual(expect.stringMatching(/\S/));
    expect(sqlite.prepare("SELECT family_id FROM api_keys WHERE id = ?").get(key.id))
      .toEqual({ family_id: key.family_id });
    sqlite.prepare("DELETE FROM user_surface_credit_modes").run();
    await expect(commitIssuedKey(env, ACTOR, {
      user_id: "user_binding",
      name: "Unavailable",
      action: "key.create",
      scopes: ["surface:codex:production"],
      expires_at: null,
      selections: [{ surface_grant: "surface:codex:production", credential_account_id: "auth_a" }]
    }, NOW)).rejects.toMatchObject({ code: "surface_not_entitled" });
  });

  it("rejects an account from the wrong credential type before the key write", async () => {
    const { env, sqlite } = fixture();
    await expect(commitIssuedKey(env, ACTOR, {
      user_id: "user_binding",
      name: "Wrong account type",
      action: "key.create",
      scopes: ["surface:codex:production"],
      expires_at: null,
      selections: [{ surface_grant: "surface:codex:production", credential_account_id: "sub_a" }]
    }, NOW)).rejects.toMatchObject({ code: "invalid_credential_account" });
    expect(sqlite.prepare("SELECT count(*) AS count FROM api_keys").get()).toEqual({ count: 0 });
  });
});

function fixture() {
  const testDb = createTestD1();
  onTestFinished(() => testDb.close());
  const timestamp = NOW.toISOString();
  testDb.sqlite.prepare(
    "INSERT INTO users (id, email, status, created_at, updated_at) VALUES ('user_binding', NULL, 'active', ?, ?)"
  ).run(timestamp, timestamp);
  testDb.sqlite.prepare("UPDATE organization_surface_credit_defaults SET monthly_allowance = 10").run();
  for (const [id, label] of [["auth_a", "ChatGPT A"], ["auth_b", "ChatGPT B"]]) {
    testDb.sqlite.prepare(
      `INSERT INTO codex_auths
         (id, kind, label, environment, status, created_at, updated_at)
       VALUES (?, 'shared', ?, 'production', 'active', ?, ?)`
    ).run(id, label, timestamp, timestamp);
  }
  for (const [id, label] of [["sub_a", "Grok A"], ["sub_b", "Grok B"]]) {
    testDb.sqlite.prepare(
      `INSERT INTO subscription_accounts
         (id, capability_source, environment, label, status, refresh_available, created_at, updated_at)
       VALUES (?, 'grok', 'production', ?, 'active', 1, ?, ?)`
    ).run(id, label, timestamp, timestamp);
  }
  return { env: { DB: testDb.binding, API_KEY_HASH_PEPPER: "binding-test-pepper" } as Env, sqlite: testDb.sqlite };
}
