import { ADMINISTRATIVE_TERMINAL_SQL, CODEX_SHARED_PRODUCTION_SQL, d1ChangeCount, GROK_PRODUCTION_SQL, OPERATOR_MUTATION_AUDIT_COLUMNS } from "../db";
import { generateId, nowIso } from "../crypto";
import { HttpError, adminRequired, userInactive } from "../errors";
import { sqlSurfaceEntitled, assertIssuanceEntitlement } from "./credits";
import { isChatgptProductionSlot, type CredentialSlotId } from "../plans/execution-plans";
import { keyIsLive } from "./key-state";
import { replacementCredentialMetadataSql } from "./credential-defaults";
import { keyActorAuthority, assertKeyActorAuthority } from "./key-authority";
import type { KeyActor } from "./api-keys";
import type { ApiKeyRow } from "../types";
import type { LifecycleActor } from "./principal";
import { serviceAdminAuthorityBindings, serviceAdminAuthoritySql } from "./service-accounts";

export interface ApiKeySurfaceCredentialRow {
  api_key_id: string;
  surface_grant: string;
  codex_auth_id: string | null;
  subscription_account_id: string | null;
  created_at: string;
  updated_at: string;
}

export const API_KEY_SURFACE_CREDENTIAL_COLUMNS = "api_key_id, surface_grant, codex_auth_id, subscription_account_id, created_at, updated_at";

export type SurfaceCredentialSelection =
  | { surface_grant: "surface:codex:production"; credential_account_id: string }
  | {
      surface_grant: "surface:grok:production" | "surface:xai:production";
      credential_account_id: string;
    };

function credentialColumnIds(selection: {
  surface_grant: SurfaceCredentialSelection["surface_grant"];
  credential_account_id: string;
}): {
  codexAuthId: string | null;
  subscriptionAccountId: string | null;
} {
  if (selection.surface_grant === "surface:codex:production") {
    return { codexAuthId: selection.credential_account_id, subscriptionAccountId: null };
  }
  return { codexAuthId: null, subscriptionAccountId: selection.credential_account_id };
}

export async function insertBoundApiKey(
  env: Env,
  input: {
    user_id: string;
    key_id?: string;
    actor: KeyActor;
    key_prefix: string;
    key_hash: string;
    scopes: string[];
    expires_at: string | null;
    name?: string | null;
    family_id?: string;
    selections?: readonly SurfaceCredentialSelection[];
    copy_bindings_from_api_key_id?: string;
    audit: (keyId: string) => D1PreparedStatement;
  },
  now = new Date()
): Promise<ApiKeyRow> {
  for (const selection of input.selections ?? []) {
    await assertCredentialAccountCompatible(
      env,
      selection.surface_grant,
      selection.credential_account_id
    );
  }
  const timestamp = nowIso(now);
  const row: ApiKeyRow = {
    id: input.key_id ?? generateId("key"),
    user_id: input.user_id,
    key_prefix: input.key_prefix,
    key_hash: input.key_hash,
    status: "active",
    scopes: JSON.stringify(input.scopes),
    name: input.name ?? null,
    family_id: "",
    expires_at: input.expires_at,
    last_used_at: null,
    created_at: timestamp,
    revoked_at: null
  };
  row.family_id = input.family_id || `family:${row.id}`;
  const snapshot = await liveKeySnapshot(env, row.user_id, now);
  const copySource = input.copy_bindings_from_api_key_id;
  const copyGuard = copySource ? copiedBindingsUsableSql() : "1";
  const authority = keyActorAuthority(input.actor, row.user_id);
  const insert = env.DB.prepare(
      `INSERT INTO api_keys
         (id, user_id, key_prefix, key_hash, status, scopes, name, family_id, expires_at,
          last_used_at, created_at, revoked_at)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, NULL
       WHERE EXISTS (SELECT 1 FROM users WHERE id = ? AND status = 'active')
         AND ${authority.sql}
         AND (? IS NULL OR EXISTS (
           SELECT 1 FROM api_keys AS source
           WHERE source.id = ? AND source.user_id = ? AND source.status = 'active'
         ))
         AND ${copyGuard}
         AND EXISTS (
           SELECT 1 FROM (SELECT ? AS payload) AS observed
           WHERE NOT EXISTS (
             SELECT 1 FROM api_keys AS current
             WHERE current.user_id = ? AND current.status = 'active'
               AND NOT EXISTS (
                 SELECT 1 FROM json_each(observed.payload) AS captured
                 WHERE json_extract(captured.value, '$.id') = current.id
                   AND json_extract(captured.value, '$.family_id') IS current.family_id
                   AND json_extract(captured.value, '$.expires_at') IS current.expires_at
               )
           )
           AND NOT EXISTS (
             SELECT 1 FROM json_each(observed.payload) AS captured
             WHERE NOT EXISTS (
               SELECT 1 FROM api_keys AS current
               WHERE current.user_id = ? AND current.status = 'active'
                 AND current.id = json_extract(captured.value, '$.id')
             )
           )
           AND (
             EXISTS (SELECT 1 FROM json_each(observed.payload) AS captured
               WHERE json_extract(captured.value, '$.live') = 1
                 AND json_extract(captured.value, '$.family_id') = ?)
             OR (SELECT COUNT(DISTINCT json_extract(captured.value, '$.family_id'))
                 FROM json_each(observed.payload) AS captured
                 WHERE json_extract(captured.value, '$.live') = 1) < 5
           )
           AND (SELECT COUNT(*) FROM json_each(observed.payload) AS captured
                WHERE json_extract(captured.value, '$.live') = 1
                  AND json_extract(captured.value, '$.family_id') = ?) < 2
         )
         AND NOT EXISTS (
           SELECT 1 FROM json_each(?) AS surface
           WHERE NOT ${sqlSurfaceEntitled("surface.value")}
         )`
    ).bind(
      row.id, row.user_id, row.key_prefix, row.key_hash, row.status, row.scopes, row.name ?? null,
      row.family_id, row.expires_at, row.created_at,
      row.user_id,
      ...authority.values,
      input.copy_bindings_from_api_key_id ?? null, input.copy_bindings_from_api_key_id ?? null, row.user_id,
      ...(copySource ? [row.scopes, copySource] : []),
      JSON.stringify(snapshot), row.user_id, row.user_id, row.family_id, row.family_id,
      row.scopes, row.user_id, row.user_id, row.user_id
    );
  const statements: D1PreparedStatement[] = [insert, input.audit(row.id)];

  if (input.copy_bindings_from_api_key_id) {
    statements.push(env.DB.prepare(
      `INSERT INTO api_key_surface_credentials
         (api_key_id, surface_grant, codex_auth_id, subscription_account_id,
          created_at, updated_at)
       SELECT ?, surface_grant, codex_auth_id, subscription_account_id, ?, ?
       FROM api_key_surface_credentials
       WHERE api_key_id = ? AND surface_grant IN (SELECT value FROM json_each(?))
         AND EXISTS (SELECT 1 FROM api_keys WHERE id = ?)`
    ).bind(row.id, timestamp, timestamp, input.copy_bindings_from_api_key_id, row.scopes, row.id));
  } else {
    for (const selection of input.selections ?? []) {
      const { codexAuthId, subscriptionAccountId } = credentialColumnIds(selection);
      statements.push(env.DB.prepare(
        `INSERT INTO api_key_surface_credentials
           (api_key_id, surface_grant, codex_auth_id, subscription_account_id,
            created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).bind(
        row.id,
        selection.surface_grant,
        codexAuthId,
        subscriptionAccountId,
        timestamp,
        timestamp
      ));
    }
  }
  let results: D1Result[];
  try {
    results = await env.DB.batch(statements);
  } catch (error) {
    if (error instanceof Error && /FOREIGN KEY constraint failed/i.test(error.message)) {
      await assertKeyActorAuthority(env, input.actor, row.user_id);
      throw await explainIssueRejection(env, row, input.copy_bindings_from_api_key_id);
    }
    throw mapKeyWriteError(error);
  }
  if (d1ChangeCount(results[0]) !== 1) {
    await assertKeyActorAuthority(env, input.actor, row.user_id);
    throw await explainIssueRejection(env, row, input.copy_bindings_from_api_key_id);
  }
  return row;
}

/** Every requested surface must have its current, compatible usable sticky binding. */
function copiedBindingsUsableSql(): string {
  return `NOT EXISTS (
    SELECT 1 FROM json_each(?) AS required_surface
    WHERE NOT EXISTS (
      SELECT 1 FROM api_key_surface_credentials AS binding
      WHERE binding.api_key_id = ? AND binding.surface_grant = required_surface.value
        AND ((required_surface.value = 'surface:codex:production' AND EXISTS (
          SELECT 1 FROM codex_auths AS account WHERE account.id = binding.codex_auth_id
            AND ${replacementCredentialMetadataSql("codex", "account")}
        )) OR (required_surface.value IN ('surface:grok:production','surface:xai:production') AND EXISTS (
          SELECT 1 FROM subscription_accounts AS account WHERE account.id = binding.subscription_account_id
            AND ${replacementCredentialMetadataSql("grok", "account")}
        )))
    )
  )`;
}

export async function assertCopiedBindingsUsable(env: Env, sourceId: string, scopes: readonly string[]): Promise<void> {
  const result = await env.DB.prepare(`SELECT ${copiedBindingsUsableSql()} AS allowed`)
    .bind(JSON.stringify(scopes), sourceId).first<{allowed: number}>();
  if (result?.allowed !== 1) {
    throw new HttpError(409, "The source key needs complete, compatible and usable credential bindings.", "invalid_request_error", "replacement_bindings_unavailable");
  }
}

interface KeyCapacityRow { id: string; family_id: string; expires_at: string | null }
/** Use the authentication parser, not SQLite's narrower date parser. No secrets. */
async function liveKeySnapshot(env: Env, userId: string, now: Date): Promise<Array<KeyCapacityRow & {live: boolean}>> {
  const rows = await env.DB.prepare("SELECT id, family_id, expires_at FROM api_keys WHERE user_id = ? AND status = 'active'")
    .bind(userId).all<KeyCapacityRow>();
  return (rows.results ?? []).map(row => ({...row, live: keyIsLive({status: "active", expires_at: row.expires_at}, now.getTime())}));
}

async function explainIssueRejection(env: Env, row: ApiKeyRow, sourceId?: string): Promise<Error> {
  const user = await env.DB.prepare("SELECT status FROM users WHERE id = ?").bind(row.user_id).first<{ status: string }>();
  if (!user || user.status !== "active") {
    return userInactive();
  }
  if (sourceId) {
    const source = await env.DB.prepare("SELECT user_id, status FROM api_keys WHERE id = ?").bind(sourceId).first<{ user_id: string; status: string }>();
    if (!source || source.user_id !== row.user_id || source.status !== "active") {
      return new HttpError(409, "The source key is no longer active.", "invalid_request_error", "key_not_active");
    }
    try { await assertCopiedBindingsUsable(env, sourceId, JSON.parse(row.scopes) as string[]); }
    catch (error) { return error instanceof Error ? error : new Error("Replacement bindings unavailable"); }
  }
  const live = (await liveKeySnapshot(env, row.user_id, new Date(row.created_at))).filter(key => key.live);
  const sameFamily = live.filter(key => key.family_id === row.family_id).length;
  if (sameFamily >= 2) {
    return new HttpError(409, "Finish or cancel the current replacement before starting another.", "invalid_request_error", "key_family_overlap");
  }
  if (new Set(live.map(key => key.family_id)).size >= 5 && sameFamily === 0) {
    return new HttpError(409, "This account already has five live key families.", "invalid_request_error", "key_family_cap");
  }
  try { await assertIssuanceEntitlement(env, row.user_id, JSON.parse(row.scopes) as string[], new Date(row.created_at)); }
  catch (error) { return error instanceof Error ? error : new Error("Issuance entitlement unavailable"); }
  return new HttpError(409, "Key inventory changed. Read current keys before submitting again.", "invalid_request_error", "key_inventory_changed");
}

export function mapKeyWriteError(error: unknown): Error {
  if (!(error instanceof Error)) return new Error("Key write failed");
  const message = error.message;
  if (message.includes("credential_not_selectable")) {
    return new HttpError(409, "That credential account can no longer be selected.", "invalid_request_error", "credential_not_selectable");
  }
  return error;
}

export async function getApiKeySurfaceCredential(
  env: Env,
  apiKeyId: string,
  surfaceGrant: string
): Promise<ApiKeySurfaceCredentialRow | null> {
  return env.DB.prepare(
    `SELECT ${API_KEY_SURFACE_CREDENTIAL_COLUMNS}
     FROM api_key_surface_credentials
     WHERE api_key_id = ? AND surface_grant = ?
     LIMIT 1`
  ).bind(apiKeyId, surfaceGrant).first<ApiKeySurfaceCredentialRow>();
}

export async function listApiKeySurfaceCredentials(
  env: Env,
  apiKeyId?: string
): Promise<ApiKeySurfaceCredentialRow[]> {
  const statement = apiKeyId
    ? env.DB.prepare(
      `SELECT ${API_KEY_SURFACE_CREDENTIAL_COLUMNS}
       FROM api_key_surface_credentials
       WHERE api_key_id = ?
       ORDER BY surface_grant`
    ).bind(apiKeyId)
    : env.DB.prepare(
      `SELECT ${API_KEY_SURFACE_CREDENTIAL_COLUMNS}
       FROM api_key_surface_credentials
       ORDER BY api_key_id, surface_grant`
    );
  const result = await statement.all<ApiKeySurfaceCredentialRow>();
  return result.results ?? [];
}

export async function replaceApiKeySurfaceCredential(
  env: Env,
  input: {
    api_key_id: string;
    surface_grant: SurfaceCredentialSelection["surface_grant"];
    credential_account_id: string;
  },
  actor: LifecycleActor,
  now = new Date()
): Promise<ApiKeySurfaceCredentialRow> {
  await assertCredentialAccountCompatible(env, input.surface_grant, input.credential_account_id);
  const timestamp = nowIso(now);
  const { codexAuthId, subscriptionAccountId } = credentialColumnIds(input);
  const account = input.surface_grant === "surface:codex:production"
    ? `EXISTS (SELECT 1 FROM codex_auths WHERE id = ? AND ${CODEX_SHARED_PRODUCTION_SQL} AND admission_state = 'enabled' AND ${ADMINISTRATIVE_TERMINAL_SQL})`
    : `EXISTS (SELECT 1 FROM subscription_accounts WHERE id = ? AND ${GROK_PRODUCTION_SQL} AND ${ADMINISTRATIVE_TERMINAL_SQL})`;
  const authority = serviceAdminAuthorityBindings(env, actor);
  const results = await env.DB.batch([env.DB.prepare(
    `INSERT INTO api_key_surface_credentials
       (api_key_id, surface_grant, codex_auth_id, subscription_account_id,
        created_at, updated_at)
     SELECT ?, ?, ?, ?, ?, ?
     WHERE EXISTS (
       SELECT 1 FROM api_keys AS k WHERE k.id = ? AND k.status = 'active'
         AND EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(k.scopes) THEN k.scopes ELSE '[]' END)
           WHERE value = ?)
     ) AND ${account} AND ${serviceAdminAuthoritySql}
     ON CONFLICT(api_key_id, surface_grant) DO UPDATE SET
       codex_auth_id = excluded.codex_auth_id,
       subscription_account_id = excluded.subscription_account_id,
       updated_at = excluded.updated_at`
  ).bind(
    input.api_key_id,
    input.surface_grant,
    codexAuthId,
    subscriptionAccountId,
    timestamp,
    timestamp,
    input.api_key_id,
    input.surface_grant,
    input.credential_account_id,
    ...authority
  ), env.DB.prepare(
    `INSERT INTO operator_mutation_audit (${OPERATOR_MUTATION_AUDIT_COLUMNS})
     SELECT ?, ?, ?, ?, ?, ?, ?, 'key.credential_binding.set',
       'api_key_surface_credential', ?, 'ok', ?, ?, ? WHERE changes() = 1`
  ).bind(generateId("oma"), timestamp, actor.kind, actor.email, actor.subject, actor.userId, actor.role,
    `${input.api_key_id}:${input.surface_grant}`, actor.requestId,
    JSON.stringify({api_key_id: input.api_key_id, surface_grant: input.surface_grant, credential_account_id: input.credential_account_id}), timestamp)]);
  if (d1ChangeCount(results[0]) !== 1) {
    const current = await env.DB.prepare(`SELECT ${serviceAdminAuthoritySql} AS allowed`)
      .bind(...authority).first<{allowed: number}>();
    if (current?.allowed !== 1) throw adminRequired();
    throw new HttpError(409, "The key or account changed. Read its current state before changing a binding.", "invalid_request_error", "credential_binding_changed");
  }
  const row = await getApiKeySurfaceCredential(env, input.api_key_id, input.surface_grant);
  if (!row) {
    throw new HttpError(500, "Credential binding was not persisted", "server_error", "credential_binding_failed");
  }
  return row;
}

export function credentialAccountId(row: ApiKeySurfaceCredentialRow, slot: CredentialSlotId): string {
  const accountId = isChatgptProductionSlot(slot)
    ? row.codex_auth_id
    : row.subscription_account_id;
  if (!accountId) {
    throw new HttpError(
      500,
      "Credential binding is incompatible with the Execution Plan",
      "server_error",
      "invalid_credential_binding"
    );
  }
  return accountId;
}

export async function assertCredentialAccountCompatible(
  env: Env,
  surfaceGrant: SurfaceCredentialSelection["surface_grant"],
  accountId: string
): Promise<void> {
  if (surfaceGrant === "surface:codex:production") {
    const row = await env.DB.prepare(
      `SELECT id FROM codex_auths
       WHERE id = ? AND ${CODEX_SHARED_PRODUCTION_SQL}
         AND admission_state = 'enabled' AND ${ADMINISTRATIVE_TERMINAL_SQL}
       LIMIT 1`
    ).bind(accountId).first();
    if (!row) {
      throw new HttpError(400, "ChatGPT Credential Account is incompatible", "invalid_request_error", "invalid_credential_account");
    }
    return;
  }
  const row = await env.DB.prepare(
    `SELECT id FROM subscription_accounts
     WHERE id = ? AND ${GROK_PRODUCTION_SQL}
       AND ${ADMINISTRATIVE_TERMINAL_SQL}
     LIMIT 1`
  ).bind(accountId).first();
  if (!row) {
    throw new HttpError(400, "Grok Credential Account is incompatible", "invalid_request_error", "invalid_credential_account");
  }
}
