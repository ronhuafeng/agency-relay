import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { commitIssuedKey, commitReplacement, listMemberKeys, normalizeKeyName, resolveKeyExpiry } from "../../src/auth/api-keys";
import { handleRequest } from "../../src/router";
import { createTestD1 } from "../support/sqlite-d1";
import { admin, consoleCookie, createUser, makeFixture } from "../router/fixture";

const NOW = new Date("2026-08-10T00:00:00.000Z");

describe("own API key families", () => {
  it("issues, replaces and revokes only the caller's keys", async () => {
    const fixture = makeFixture();
    const owner = await createUser(fixture, "owner@example.com");
    const other = await createUser(fixture, "other@example.com");
    await admin(fixture, `https://api.trustedtunnel.app/admin/users/${owner.user.id}/role`, {
      method: "POST",
      body: { role: "admin" }
    });
    fixture.db.ensureCredentialAccountsForScopes(["surface:codex:production"]);
    await fixture.tokenAuthority.saveToken({
      auth_id: "shared_default",
      access_token: "shared_access",
      expires_at: "2020-01-01T00:00:00.000Z",
      status: "active"
    });
    expect((await admin(fixture, "https://api.trustedtunnel.app/admin/credential-defaults/codex", {
      method: "PUT",
      body: { credential_account_id: "shared_default" }
    })).status).toBe(200);
    const call = async (email: string, path: string, method = "GET", body?: unknown) => handleRequest(new Request(`https://admin.example.test${path}`, {
      method,
      headers: {
        Cookie: `__Host-mini-console=${await consoleCookie(fixture, email)}`,
        Origin: "https://admin.example.test",
        "Content-Type": "application/json"
      },
      body: body === undefined ? undefined : JSON.stringify(body)
    }), fixture.env, fixture.ctx, fixture.deps);

    const forbidden = await call("owner@example.com", "/me/keys", "POST", {
      name: "First",
      surfaces: ["codex"],
      credential_account_id: "shared_default"
    });
    expect(forbidden.status).toBe(400);

    const created = await call("owner@example.com", "/me/keys", "POST", {
      name: "  First  ",
      surfaces: ["codex"],
      user_id: other.user.id
    });
    expect(created.status).toBe(201);
    const createdBody = await created.json() as { api_key: string; key: { id: string; name: string; expires_at: string; family_id: string } };
    expect(createdBody.api_key.startsWith("cfwd_")).toBe(true);
    expect(createdBody.key.name).toBe("First");
    expect(createdBody.key.expires_at).toBe("2026-09-22T00:00:00.000Z");
    expect(fixture.db.apiKeys.get(createdBody.key.id)?.user_id).toBe(owner.user.id);
    expect(JSON.stringify(fixture.db.apiKeys.get(createdBody.key.id))).not.toContain(createdBody.api_key);

    const duplicate = await call("owner@example.com", "/me/ui/keys", "POST", { name: "First", surfaces: ["codex"] });
    expect(duplicate.status).toBe(201);
    expect((await admin(fixture, `https://api.trustedtunnel.app/admin/users/${other.user.id}/keys`, {
      method: "POST",
      body: {
        name: "Other key",
        scopes: ["surface:codex:production"],
        credential_bindings: [{ surface_grant: "surface:codex:production", credential_account_id: "shared_default" }]
      }
    })).status).toBe(201);

    const listed = await call("owner@example.com", "/me/keys");
    const listedBody = await listed.json() as { keys: Array<Record<string, unknown>> };
    expect(listedBody.keys.map((key) => key.name).sort()).toEqual(["First", "First"]);
    expect(JSON.stringify(listedBody)).not.toContain(createdBody.api_key);
    expect(JSON.stringify(listedBody)).not.toContain("shared_default");
    expect(JSON.stringify(listedBody)).not.toContain("key_hash");

    fixture.db.seedCodexAuth({
      id: "codex_other",
      kind: "shared",
      upstream_email: null,
      upstream_account_id: null,
      status: "active",
      expires_at: null,
      last_refresh_at: null,
      created_at: "2026-06-24T00:00:00.000Z",
      updated_at: "2026-06-24T00:00:00.000Z"
    });
    await fixture.tokenAuthority.saveToken({
      auth_id: "codex_other",
      access_token: "other_access",
      expires_at: "2026-07-01T00:00:00.000Z",
      status: "active"
    });
    expect((await admin(fixture, "https://api.trustedtunnel.app/admin/credential-defaults/codex", {
      method: "PUT",
      body: { credential_account_id: "codex_other" }
    })).status).toBe(200);
    const replaced = await call("owner@example.com", `/me/keys/${createdBody.key.id}/replace`, "POST", {});
    expect(replaced.status).toBe(201);
    const replacedBody = await replaced.json() as { api_key: string; key: { id: string; family_id: string }; old_key_remains_active: boolean };
    expect(replacedBody.old_key_remains_active).toBe(true);
    expect(replacedBody.key.family_id).toBe(createdBody.key.family_id);
    expect(replacedBody.api_key).not.toBe(createdBody.api_key);
    const binding = await admin(fixture, `https://api.trustedtunnel.app/admin/keys/${replacedBody.key.id}/credential-bindings`, { method: "GET" });
    expect(await binding.json()).toMatchObject({
      bindings: [expect.objectContaining({ surface_grant: "surface:codex:production", codex_auth_id: "shared_default" })]
    });
    const again = await call("owner@example.com", `/me/keys/${createdBody.key.id}/replace`, "POST", {});
    expect(again.status).toBe(409);

    const missing = await call("owner@example.com", "/me/keys/missing", "DELETE");
    const foreign = await call("other@example.com", `/me/keys/${createdBody.key.id}`, "DELETE");
    expect(missing.status).toBe(404);
    expect(foreign.status).toBe(404);
    expect((await missing.json() as { error: { code: string } }).error.code)
      .toBe((await foreign.json() as { error: { code: string } }).error.code);

    const renamed = await call("owner@example.com", `/me/keys/${replacedBody.key.id}`, "PATCH", { name: "Renamed" });
    expect(renamed.status).toBe(200);
    expect(fixture.db.apiKeys.get(replacedBody.key.id)?.key_hash)
      .toBe(fixture.db.apiKeys.get(replacedBody.key.id)?.key_hash);

    fixture.db.seedSurfaceCreditUsage(owner.user.id, "surface:codex:production", {
      consumed_credits: 3,
      admitted_attempts: 1,
      last_seen_at: NOW.toISOString()
    });
    const revoked = await call("owner@example.com", `/me/keys/${createdBody.key.id}`, "DELETE");
    expect(revoked.status).toBe(200);
    const credits = await admin(fixture, `https://api.trustedtunnel.app/admin/users/${owner.user.id}/credits`, { method: "GET" });
    expect(await credits.json()).toMatchObject({
      states: expect.arrayContaining([expect.objectContaining({
        surface_grant: "surface:codex:production",
        consumed_credits: 3
      })])
    });
    expect(fixture.db.apiKeys.get(replacedBody.key.id)?.status).toBe("active");

    const cleared = await call("owner@example.com", "/me/keys/revoke-all", "POST", {});
    expect(cleared.status).toBe(200);
    expect(fixture.db.users.get(owner.user.id)?.status).toBe("active");
    expect([...fixture.db.apiKeys.values()].filter((key) => key.user_id === owner.user.id).every((key) => key.status === "revoked")).toBe(true);
  });

  it("keeps a grandfathered family replaceable without opening a sixth family", async () => {
    const { env, sqlite } = database();
    seedAccount(sqlite);
    const actor = { kind: "admin_secret" as const, email: null, subject: null, userId: null, role: null, requestId: "req" };
    for (let index = 0; index < 6; index += 1) {
      sqlite.prepare(
        `INSERT INTO api_keys (id, user_id, key_prefix, key_hash, status, scopes, name, family_id, expires_at, created_at)
         VALUES (?, 'user_keys', ?, 'hash', 'active', '["surface:codex:production"]', 'Legacy', ?, ?, ?)`
      ).run(`legacy_${index}`, `pfx_${index}`, `legacy:${index}`, "2020-01-01T00:00:00.000Z", NOW.toISOString());
    }
    // Grandfathered keys still need a complete usable sticky binding to renew.
    sqlite.exec(`INSERT INTO api_key_surface_credentials (api_key_id,surface_grant,codex_auth_id,created_at,updated_at)
      SELECT id,'surface:codex:production','codex_keys',created_at,created_at FROM api_keys WHERE user_id='user_keys'`);
    sqlite.prepare("UPDATE api_keys SET expires_at = NULL").run();
    await expect(commitIssuedKey(env, actor, {
      user_id: "user_keys",
      name: "New family",
      scopes: ["surface:codex:production"],
      expires_at: resolveKeyExpiry(undefined, NOW),
      selections: [{ surface_grant: "surface:codex:production", credential_account_id: "codex_keys" }],
      action: "key.create"
    }, NOW)).rejects.toMatchObject({ code: "key_family_cap" });
    const legacy = await env.DB.prepare("SELECT * FROM api_keys WHERE id = 'legacy_0'").first<Record<string, string>>();
    const replaced = await commitReplacement(env, actor, {
      ...legacy,
      name: "Legacy",
      expires_at: null,
      last_used_at: null,
      revoked_at: null
    } as never, undefined, NOW);
    expect(replaced.family_id).toBe("legacy:0");
    expect(sqlite.prepare("SELECT family_id FROM api_keys WHERE id = ?").get(replaced.id))
      .toEqual({ family_id: "legacy:0" });
    expect(sqlite.prepare("SELECT count(*) AS count FROM api_keys WHERE id = 'legacy_0' AND status = 'active'").get()).toEqual({ count: 1 });
    await expect(commitReplacement(env, actor, {
      ...legacy,
      name: "Legacy",
      expires_at: null,
      last_used_at: null,
      revoked_at: null
    } as never, undefined, NOW)).rejects.toMatchObject({ code: "key_family_overlap" });
    expect(normalizeKeyName("  ok  ")).toBe("ok");
    expect(() => normalizeKeyName("a\nb")).toThrow(/control characters/);
    expect(() => resolveKeyExpiry("2020-01-01T00:00:00.000Z", NOW)).toThrow(/future/);
    expect(() => resolveKeyExpiry("2028-01-01T00:00:00.000Z", NOW)).toThrow(/365 days/);
    expect(await listMemberKeys(env, "user_keys")).toHaveLength(7);
    expect(sqlite.prepare("SELECT count(*) AS count FROM operator_mutation_audit WHERE action = 'key.create'").get()).toEqual({ count: 0 });
    expect(sqlite.prepare("SELECT count(*) AS count FROM operator_mutation_audit WHERE action = 'key.replace.create'").get()).toEqual({ count: 1 });
  });
});

function database(): { env: Env; sqlite: DatabaseSync } {
  const testDb = createTestD1();
  testDb.sqlite.prepare(
    "INSERT INTO users (id, email, canonical_email, role, status, login_capable, account_kind, created_at, updated_at) VALUES ('user_keys', 'keys@example.com', 'keys@example.com', 'user', 'active', 1, 'human', ?, ?)"
  ).run(NOW.toISOString(), NOW.toISOString());
  testDb.sqlite.prepare("UPDATE organization_surface_credit_defaults SET monthly_allowance = 10").run();
  return { env: { DB: testDb.binding, API_KEY_HASH_PEPPER: "pepper" } as Env, sqlite: testDb.sqlite };
}

function seedAccount(sqlite: DatabaseSync): void {
  sqlite.prepare(
    `INSERT INTO codex_auths (id, kind, label, environment, status, created_at, updated_at)
     VALUES ('codex_keys', 'shared', 'Codex', 'production', 'active', ?, ?)`
  ).run(NOW.toISOString(), NOW.toISOString());
}
