import { d1ChangeCount } from "../records";
import type { UserRow, ApiKeyRow } from "./types";
import { canonicalMailbox } from "./principal";
import { generateId, nowIso } from "../crypto";
import { HttpError, emailConflict } from "../errors";

interface EndUserAuthRow {
  api_key_id: string;
  api_key_user_id: string;
  key_prefix: string;
  key_hash: string;
  api_key_status: string;
  scopes: string;
  expires_at: string | null;
  last_used_at: string | null;
  api_key_created_at: string;
  revoked_at: string | null;
  user_id: string | null;
  user_email: string | null;
  user_status: string | null;
  user_created_at: string | null;
  user_updated_at: string | null;
}

export interface EndUserAuthCandidate {
  apiKey: ApiKeyRow;
  user: UserRow | null;
}

export async function createUser(env: Env, input: { id?: string; email?: string | null; status?: string }, now = new Date()): Promise<UserRow> {
  const requested = input.email ?? null;
  const canonical = requested == null || requested.trim() === "" ? null : canonicalMailbox(requested);
  if (requested != null && requested.trim() !== "" && canonical == null) {
    throw new HttpError(400, "Enter a valid email address.", "invalid_request_error", "invalid_email");
  }
  const row: UserRow = {
    id: input.id ?? generateId("usr"),
    email: canonical,
    canonical_email: canonical,
    role: "user",
    status: input.status ?? "active",
    login_capable: canonical ? 1 : 0,
    account_kind: canonical ? "human" : "legacy_unresolved",
    created_at: nowIso(now),
    updated_at: nowIso(now)
  };
  const result = canonical
    ? await env.DB.prepare(
      `INSERT INTO users (id, email, canonical_email, role, status, login_capable, account_kind, created_at, updated_at)
       SELECT ?, ?, ?, 'user', ?, 1, 'human', ?, ?
       WHERE NOT EXISTS (SELECT 1 FROM users WHERE canonical_email = ?)`
    ).bind(row.id, canonical, canonical, row.status, row.created_at, row.updated_at, canonical).run()
    : await env.DB.prepare(
      `INSERT INTO users (id, email, canonical_email, role, status, login_capable, account_kind, created_at, updated_at)
       VALUES (?, NULL, NULL, 'user', ?, 0, 'legacy_unresolved', ?, ?)`
    ).bind(row.id, row.status, row.created_at, row.updated_at).run();
  if (d1ChangeCount(result) !== 1) {
    throw emailConflict();
  }
  return row;
}

export async function getUser(env: Env, userId: string): Promise<UserRow | null> {
  return env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(userId).first<UserRow>();
}

export async function findEndUserAuthByKeyPrefix(env: Env, prefix: string): Promise<EndUserAuthCandidate | null> {
  const row = await env.DB.prepare(
    `SELECT
       ak.id AS api_key_id,
       ak.user_id AS api_key_user_id,
       ak.key_prefix AS key_prefix,
       ak.key_hash AS key_hash,
       ak.status AS api_key_status,
       ak.scopes AS scopes,
       ak.expires_at AS expires_at,
       ak.last_used_at AS last_used_at,
       ak.created_at AS api_key_created_at,
       ak.revoked_at AS revoked_at,
       u.id AS user_id,
       u.email AS user_email,
       u.status AS user_status,
       u.created_at AS user_created_at,
       u.updated_at AS user_updated_at
     FROM api_keys AS ak
     LEFT JOIN users AS u ON u.id = ak.user_id
     WHERE ak.key_prefix = ?
     LIMIT 1`
  ).bind(prefix).first<EndUserAuthRow>();
  if (!row) {
    return null;
  }
  const apiKey: ApiKeyRow = {
    id: row.api_key_id,
    user_id: row.api_key_user_id,
    key_prefix: row.key_prefix,
    key_hash: row.key_hash,
    status: row.api_key_status,
    scopes: row.scopes,
    expires_at: row.expires_at,
    last_used_at: row.last_used_at,
    created_at: row.api_key_created_at,
    revoked_at: row.revoked_at
  };
  const user = row.user_id && row.user_status && row.user_created_at && row.user_updated_at
    ? {
        id: row.user_id,
        email: row.user_email,
        status: row.user_status,
        created_at: row.user_created_at,
        updated_at: row.user_updated_at
      }
    : null;
  return { apiKey, user };
}

export async function touchApiKey(env: Env, keyId: string, staleBefore: Date, now = new Date()): Promise<void> {
  await env.DB.prepare(
    "UPDATE api_keys SET last_used_at = ? WHERE id = ? AND (last_used_at IS NULL OR last_used_at < ?)"
  ).bind(nowIso(now), keyId, nowIso(staleBefore)).run();
}

export async function getApiKeyById(env: Env, keyId: string): Promise<ApiKeyRow | null> {
  return env.DB.prepare(
    `SELECT id, user_id, key_prefix, key_hash, status, scopes, name, family_id, expires_at, last_used_at, created_at, revoked_at
     FROM api_keys WHERE id = ? LIMIT 1`
  ).bind(keyId).first<ApiKeyRow>();
}
