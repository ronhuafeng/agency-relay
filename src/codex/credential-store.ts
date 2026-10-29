import { ADMINISTRATIVE_TERMINAL_SQL, CODEX_SHARED_PRODUCTION_SQL } from "../auth/credential-policy";
import { d1ChangeCount } from "../records";
import type { CodexAuthRow } from "./types";
import { generateId, nowIso } from "../crypto";

export const SHARED_CODEX_AUTH_ID = "shared_default";

const CODEX_AUTH_KIND = "shared";

export async function listCodexAuths(env: Env): Promise<CodexAuthRow[]> {
  const result = await env.DB.prepare(
    `SELECT * FROM codex_auths
     WHERE ${CODEX_SHARED_PRODUCTION_SQL}
     ORDER BY created_at ASC`
  ).all<CodexAuthRow>();
  return result.results ?? [];
}

export async function getCodexAuth(env: Env, authId: string): Promise<CodexAuthRow | null> {
  return env.DB.prepare(
    `SELECT * FROM codex_auths
     WHERE id = ? AND ${CODEX_SHARED_PRODUCTION_SQL}
     LIMIT 1`
  ).bind(authId).first<CodexAuthRow>();
}

export async function createCodexAuth(
  env: Env,
  input: { label: string },
  now = new Date()
): Promise<CodexAuthRow> {
  const timestamp = nowIso(now);
  const row: CodexAuthRow = {
    id: generateId("auth"),
    kind: CODEX_AUTH_KIND,
    label: input.label.trim() || "ChatGPT",
    environment: "production",
    upstream_email: null,
    upstream_account_id: null,
    status: "pending_credential",
    admission_state: "enabled",
    expires_at: null,
    last_refresh_at: null,
    created_at: timestamp,
    updated_at: timestamp
  };
  await env.DB.prepare(
    `INSERT INTO codex_auths
       (id, kind, label, environment, upstream_email, upstream_account_id,
        status, expires_at, last_refresh_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, NULL, NULL, ?, NULL, NULL, ?, ?)`
  ).bind(row.id, row.kind, row.label, row.environment, row.status, timestamp, timestamp).run();
  return row;
}

type CodexRefreshProjection = {
  expires_at?: string | null;
  account_id?: string | null;
  email?: string | null;
  status?: string;
  last_refresh_at?: string | null;
};

const CODEX_REFRESH_ASSIGNMENTS = `upstream_email = COALESCE(?, upstream_email),
         upstream_account_id = COALESCE(?, upstream_account_id),
         status = COALESCE(?, status),
         expires_at = COALESCE(?, expires_at),
         last_refresh_at = COALESCE(?, last_refresh_at),
         updated_at = ?`;

function codexRefreshBindings(input: CodexRefreshProjection, now: Date, authId: string): unknown[] {
  return [
    input.email ?? null,
    input.account_id ?? null,
    input.status ?? null,
    input.expires_at ?? null,
    input.last_refresh_at ?? null,
    nowIso(now),
    authId
  ];
}

export async function updateCodexAuthAfterRefresh(
  env: Env,
  authId: string,
  input: CodexRefreshProjection,
  now = new Date()
): Promise<void> {
  await env.DB.prepare(
    `UPDATE codex_auths SET ${CODEX_REFRESH_ASSIGNMENTS} WHERE id = ? AND kind = 'shared'`
  ).bind(...codexRefreshBindings(input, now, authId)).run();
}

export async function readCodexAuthStatus(env: Env, authId: string): Promise<string | null> {
  const row = await env.DB.prepare(
    "SELECT status FROM codex_auths WHERE id = ? AND kind = 'shared'"
  ).bind(authId).first<{ status: string }>();
  return row?.status ?? null;
}

/** Refresh projection. An administrative terminal status is authoritative and is not rewritten. */
export async function projectCodexRefreshIfMutable(
  env: Env,
  authId: string,
  input: CodexRefreshProjection,
  now = new Date()
): Promise<boolean> {
  const result = await env.DB.prepare(
    `UPDATE codex_auths SET ${CODEX_REFRESH_ASSIGNMENTS}
     WHERE id = ? AND kind = 'shared' AND ${ADMINISTRATIVE_TERMINAL_SQL}`
  ).bind(...codexRefreshBindings(input, now, authId)).run();
  return d1ChangeCount(result) > 0;
}

export async function markCodexAuthReauthRequiredIfMutable(env: Env, authId: string, now = new Date()): Promise<boolean> {
  const result = await env.DB.prepare(
    `UPDATE codex_auths SET status = 'reauth_required', updated_at = ?
     WHERE id = ? AND kind = 'shared' AND ${ADMINISTRATIVE_TERMINAL_SQL}`
  ).bind(nowIso(now), authId).run();
  return d1ChangeCount(result) > 0;
}
