import type { ApiKeyRow, UserRow } from "../types";
import type { ApiKeySurfaceCredentialRow } from "../auth/bindings";
import { DASHBOARD_PEOPLE_PAGE_SIZE, DASHBOARD_PEOPLE_PAGE_SIZES } from "./ui/href";

export const DASHBOARD_PAGE_SIZE = 40;
export type DashboardKey = Pick<ApiKeyRow, "id" | "user_id" | "key_prefix" | "status" | "scopes" | "expires_at" | "last_used_at" | "created_at"> & { readonly name?: string | null };
export type DashboardAccessKey = Pick<ApiKeyRow, "user_id" | "scopes" | "expires_at">;
export interface DashboardPage<T> { rows: T[]; page: number; hasNext: boolean }
export type DashboardAccountKey = DashboardKey & { user_status: string | null; user_email: string | null; bound_grants: string[] };

const slots = (ids: readonly string[]) => ids.length ? ids.map(() => "?").join(",") : "NULL";
const pageResult = <T>(rows: T[], page: number): DashboardPage<T> => ({ rows: rows.slice(0, DASHBOARD_PAGE_SIZE), page, hasNext: rows.length > DASHBOARD_PAGE_SIZE });

export async function dashboardInventoryCounts(env: Env): Promise<{ userCount: number; keyCount: number }> {
  const counts = await env.DB.prepare(
    "SELECT (SELECT COUNT(*) FROM users) AS userCount, (SELECT COUNT(*) FROM api_keys) AS keyCount"
  ).first<{ userCount: number; keyCount: number }>();
  if (!counts) throw new Error("Inventory counts unavailable");
  return counts;
}

export async function dashboardPeoplePage(env: Env, search: string, page: number, kind = "human", pageSize = DASHBOARD_PEOPLE_PAGE_SIZE): Promise<DashboardPage<UserRow>> {
  const filter = kind === "human" ? "account_kind = 'human' AND role = 'user'"
    : kind === "admin" ? "account_kind = 'human' AND role = 'admin'"
    : kind === "service" ? "account_kind = 'service'"
    : kind === "legacy_unresolved" ? "account_kind = 'legacy_unresolved'" : null;
  if (!filter || !DASHBOARD_PEOPLE_PAGE_SIZES.some(size => size === pageSize)) throw new Error("Invalid people inventory query");
  const result = await env.DB.prepare(
    `SELECT id, email, canonical_email, role, status, login_capable, account_kind, display_name, created_at, updated_at FROM users
     WHERE ${filter} AND (instr(lower(id), lower(?)) > 0 OR instr(lower(COALESCE(email, '')), lower(?)) > 0 OR instr(lower(COALESCE(display_name, '')), lower(?)) > 0)
     ORDER BY created_at DESC, id ASC LIMIT ? OFFSET ?`
  ).bind(search, search, search, pageSize + 1, (page - 1) * pageSize).all<UserRow>();
  return { rows: result.results.slice(0, pageSize), page, hasNext: result.results.length > pageSize };
}

export async function dashboardKeyPage(env: Env, input: { person?: string; search: string; page: number; activeOnly?: boolean }): Promise<DashboardPage<DashboardKey>> {
  const filters = ["1 = 1"];
  const bindings: (string | number)[] = [];
  if (input.person !== undefined) { filters.push("k.user_id = ?"); bindings.push(input.person); }
  if (input.activeOnly) filters.push("k.status = 'active'");
  if (input.search) {
    filters.push(`(instr(lower(k.user_id), lower(?)) > 0 OR instr(lower(k.key_prefix), lower(?)) > 0 OR instr(lower(COALESCE(k.name, '')), lower(?)) > 0
      OR instr(lower(k.scopes), lower(?)) > 0 OR instr(lower(COALESCE(u.email, '')), lower(?)) > 0
      OR instr(lower(COALESCE(u.display_name, '')), lower(?)) > 0)`);
    bindings.push(input.search, input.search, input.search, input.search, input.search, input.search);
  }
  const result = await env.DB.prepare(
    `SELECT k.id, k.user_id, k.name, k.key_prefix, k.status, k.scopes, k.expires_at, k.last_used_at, k.created_at
     FROM api_keys AS k LEFT JOIN users AS u ON u.id = k.user_id
     WHERE ${filters.join(" AND ")}
     ORDER BY COALESCE(julianday(k.last_used_at), 0) DESC, k.created_at DESC, k.id ASC LIMIT ? OFFSET ?`
  ).bind(...bindings, DASHBOARD_PAGE_SIZE + 1, (input.page - 1) * DASHBOARD_PAGE_SIZE).all<DashboardKey>();
  return pageResult(result.results, input.page);
}

export async function dashboardPersonKey(env: Env, person: string, keyId: string): Promise<DashboardKey | null> {
  return env.DB.prepare(
    `SELECT id, user_id, name, key_prefix, status, scopes, expires_at, last_used_at, created_at
     FROM api_keys WHERE id = ? AND user_id = ?`
  ).bind(keyId, person).first<DashboardKey>();
}

/** Presence metadata covers every active key for these people, not the visible key page. */
export async function dashboardAccessKeys(env: Env, userIds: readonly string[]): Promise<DashboardAccessKey[]> {
  const result = await env.DB.prepare(
    `SELECT DISTINCT user_id, scopes, expires_at FROM api_keys
     WHERE status = 'active' AND user_id IN (${slots(userIds)})`
  ).bind(...userIds).all<DashboardAccessKey>();
  return result.results;
}

export async function dashboardKeyOwners(env: Env, userIds: readonly string[]): Promise<UserRow[]> {
  const result = await env.DB.prepare(
    `SELECT id, email, canonical_email, role, status, login_capable, account_kind, display_name, created_at, updated_at FROM users WHERE id IN (${slots(userIds)})`
  ).bind(...userIds).all<UserRow>();
  return result.results;
}

export async function dashboardKeyBindings(env: Env, keyIds: readonly string[]): Promise<ApiKeySurfaceCredentialRow[]> {
  const result = await env.DB.prepare(
    `SELECT api_key_id, surface_grant, codex_auth_id, subscription_account_id, created_at, updated_at
     FROM api_key_surface_credentials WHERE api_key_id IN (${slots(keyIds)}) ORDER BY api_key_id, surface_grant`
  ).bind(...keyIds).all<ApiKeySurfaceCredentialRow>();
  return result.results;
}

export async function dashboardAccountKeys(env: Env, provider: "codex" | "grok", accountId: string, page: number): Promise<{ page: DashboardPage<DashboardAccountKey>; total: number }> {
  const column = provider === "codex" ? "codex_auth_id" : "subscription_account_id";
  const linked = `k.id IN (SELECT b.api_key_id FROM api_key_surface_credentials AS b WHERE b.${column} = ?)`;
  const [count, result] = await Promise.all([
    env.DB.prepare(`SELECT COUNT(*) AS total FROM api_keys AS k WHERE ${linked}`).bind(accountId).first<{ total: number }>(),
    env.DB.prepare(
      `SELECT k.id, k.user_id, k.name, k.key_prefix, k.status, k.scopes, k.expires_at, k.last_used_at, k.created_at, u.status AS user_status, u.email AS user_email
       FROM api_keys AS k LEFT JOIN users AS u ON u.id = k.user_id WHERE ${linked}
       ORDER BY k.user_id ASC, k.created_at DESC, k.id ASC LIMIT ? OFFSET ?`
    ).bind(accountId, DASHBOARD_PAGE_SIZE + 1, (page - 1) * DASHBOARD_PAGE_SIZE).all<DashboardKey & { user_status: string | null; user_email: string | null }>()
  ]);
  if (!count) throw new Error("Account access count unavailable");
  const visible = pageResult(result.results, page);
  const bindings = visible.rows.length ? await dashboardKeyBindings(env, visible.rows.map(key => key.id)) : [];
  return {
    total: count.total,
    page: { ...visible, rows: visible.rows.map(key => ({ ...key, bound_grants: bindings.filter(binding => binding.api_key_id === key.id && binding[column] === accountId).map(binding => binding.surface_grant) })) }
  };
}
