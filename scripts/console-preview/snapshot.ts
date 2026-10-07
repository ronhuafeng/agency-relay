import { existsSync, readFileSync } from "node:fs";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";

// Only display metadata. Never export session material, hashes, provider IDs or payloads.
export const snapshotColumns: Record<string, string[]> = {
  users: "id,email,status,created_at,updated_at,role,canonical_email,login_capable,account_kind,display_name".split(","),
  codex_auths: "id,kind,label,environment,status,expires_at,last_refresh_at,created_at,updated_at".split(","),
  subscription_accounts: "id,capability_source,environment,label,status,expires_at,refresh_available,last_refresh_at,reauth_required_at,last_success_at,last_failure_at,last_test_at,last_test_status,created_at,updated_at".split(","),
  api_keys: "id,user_id,status,scopes,expires_at,last_used_at,created_at,revoked_at,name,family_id".split(","),
  api_key_surface_credentials: "api_key_id,surface_grant,codex_auth_id,subscription_account_id,created_at,updated_at".split(","),
  organization_surface_credential_defaults: "surface_grant,codex_auth_id,subscription_account_id,created_at,updated_at".split(","),
  organization_surface_credit_defaults: "surface_grant,monthly_allowance,created_at,updated_at".split(","),
  user_surface_credit_policies: "user_id,surface_grant,monthly_allowance,created_at,updated_at".split(","),
  user_surface_credit_modes: "user_id,surface_grant,mode,created_at,updated_at".split(","),
  service_account_owners: "service_user_id,owner_user_id,revision,updated_at".split(",")
};
// Reports contain counters and display evidence, never traffic or session IDs.
export const reportSnapshotColumns: Record<string, string[]> = {
  user_surface_credit_usage: "user_id,surface_grant,period_start,consumed_credits,admitted_attempts,last_seen_at".split(","),
  usage_daily: "user_id,day,route_profile_id,response_model,requests,ok_requests,error_requests,input_tokens,cached_input_tokens,output_tokens,reasoning_tokens,total_tokens,token_measurements,provider_cost_usd_ticks,cost_measurements,first_seen_at,last_seen_at,api_equivalent_usd_ticks,api_equivalent_measurements".split(","),
  media_usage_daily: "user_id,day,route_profile_id,capability,started_jobs,completed_jobs,failed_jobs,expired_jobs,outputs,video_seconds,output_measurements,duration_measurements,first_seen_at,last_seen_at,provider_cost_usd_ticks,cost_measurements".split(","),
  request_audit: "id,route_profile_id,route,user_id,key_id,codex_auth_id,response_model,status,upstream_status,error_code,latency_ms,input_tokens,cached_input_tokens,output_tokens,reasoning_tokens,total_tokens,created_at,ingress_profile_id,ingress_protocol,resolved_model,capability_source,subscription_account_id,egress_profile_id,provider_cost_usd_ticks,cache_write_input_tokens,api_equivalent_usd_ticks,api_price_version".split(",")
};
export interface SnapshotQuery { table: string; columns: string[]; sql: string; countSql?: string }
export function snapshotQueries(email?: string, requestLimit?: number): SnapshotQuery[] {
  if (requestLimit !== undefined && (!Number.isInteger(requestLimit) || requestLimit < 1 || requestLimit > 5000)) throw new Error("Request display limit must be an integer from 1 to 5000");
  const query = (table: string, columns: string[], filter?: string): SnapshotQuery => {
    const from = `FROM ${table}${filter ? ` WHERE ${filter}` : ""}`;
    return table === "request_audit" && requestLimit !== undefined
      ? { table, columns, sql: `SELECT ${columns.join(",")} ${from} ORDER BY created_at DESC,id DESC LIMIT ${requestLimit}`, countSql: `SELECT COUNT(*) AS n ${from}` }
      : { table, columns, sql: `SELECT ${columns.join(",")} ${from} LIMIT 5001` };
  };
  if (email === undefined) return Object.entries({ ...snapshotColumns, ...reportSnapshotColumns }).map(([table, columns]) => query(table, columns));
  const canonical = email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+$/.test(canonical)) throw new Error("A valid account email is required");
  const literal = `'${canonical.replaceAll("'", "''")}'`;
  const users = `SELECT id FROM users WHERE canonical_email=${literal} AND account_kind='human'`;
  const keys = `SELECT id FROM api_keys WHERE user_id IN (${users})`;
  const credentialReferences = (column: string) => `SELECT ${column} FROM organization_surface_credential_defaults UNION SELECT ${column} FROM api_key_surface_credentials WHERE api_key_id IN (${keys})`;
  const filters: Record<string, string> = {
    users: `id IN (${users})`,
    api_keys: `user_id IN (${users})`,
    api_key_surface_credentials: `api_key_id IN (${keys})`,
    codex_auths: `id IN (${credentialReferences("codex_auth_id")})`,
    subscription_accounts: `id IN (${credentialReferences("subscription_account_id")})`,
    organization_surface_credential_defaults: "1",
    organization_surface_credit_defaults: "1",
    user_surface_credit_policies: `user_id IN (${users})`,
    user_surface_credit_modes: `user_id IN (${users})`,
    service_account_owners: "0"
  };
  return Object.entries({ ...snapshotColumns, ...reportSnapshotColumns }).map(([table, columns]) => query(table, columns, filters[table] ?? `user_id IN (${users})`));
}
export const snapshotPath = "tmp/console-preview/snapshot.json";
export interface PreviewSnapshot { capturedAt: string; domain: string; accountScoped?: boolean; requestHistory?: { imported: number; available: number }; tables: Record<string, Record<string, SQLInputValue>[]> }
export function readSnapshot(): PreviewSnapshot | null {
  return existsSync(snapshotPath) ? JSON.parse(readFileSync(snapshotPath, "utf8")) as PreviewSnapshot : null;
}
export function importSnapshot(sqlite: DatabaseSync, snapshot: PreviewSnapshot) {
  const reportTables = Object.keys(reportSnapshotColumns);
  if (reportTables.some(table => snapshot.tables[table] !== undefined) && reportTables.some(table => !Array.isArray(snapshot.tables[table]))) throw new Error("Incomplete preview reports");
  sqlite.exec("BEGIN");
  try {
    for (const [table, columns] of Object.entries({ ...snapshotColumns, ...reportSnapshotColumns })) {
      const rows = snapshot.tables[table];
      if (rows === undefined && Object.hasOwn(reportSnapshotColumns, table)) continue;
      if (!Array.isArray(rows)) throw new Error("Incomplete preview snapshot");
      if (table === "organization_surface_credit_defaults") sqlite.exec(`DELETE FROM ${table}`);
      const extra = table === "api_keys" ? ["key_prefix", "key_hash"] : [];
      const names = [...columns, ...extra];
      const statement = sqlite.prepare(`INSERT INTO ${table} (${names.join(",")}) VALUES (${names.map(()=>"?").join(",")})`);
      rows.forEach((row,index) => statement.run(...columns.map(name => row[name] ?? null), ...(extra.length ? [`preview_${index}`, `invalid-preview-hash-${index}`] : [])));
    }
    sqlite.exec("COMMIT");
  } catch (error) { sqlite.exec("ROLLBACK"); throw error; }
}
