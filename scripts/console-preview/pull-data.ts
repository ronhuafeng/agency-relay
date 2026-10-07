import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { snapshotQueries, snapshotPath, type PreviewSnapshot } from "./snapshot";

const { values } = parseArgs({ options: { email: { type: "string" }, "request-limit": { type: "string" } }, allowPositionals: false });
const requestLimit = values["request-limit"] === undefined ? undefined : Number(values["request-limit"]);
const queries = snapshotQueries(values.email, requestLimit);
const requestCountSql = queries.find(query => query.table === "request_audit")?.countSql;
if (process.env.PREVIEW_ENV_FILE) process.loadEnvFile(process.env.PREVIEW_ENV_FILE);
const account = process.env.CLOUDFLARE_ACCOUNT_ID;
const token = process.env.CLOUDFLARE_API_TOKEN_D1_READ || process.env.CLOUDFLARE_API_TOKEN;
if (!account || !token) throw new Error("Cloudflare account and D1 query credentials are required");
const config = JSON.parse(readFileSync("wrangler.jsonc", "utf8")) as { d1_databases: { binding: string; database_id: string }[]; vars: { CONSOLE_EMAIL_DOMAIN: string } };
const database = config.d1_databases.find(item => item.binding === "DB")?.database_id;
if (!database) throw new Error("DB binding is missing");
const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/d1/database/${database}/query`, {
  method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
  body: JSON.stringify({ sql: [...queries.map(query => query.sql), ...(requestCountSql ? [requestCountSql] : [])].join("; ") }),
  signal: AbortSignal.timeout(30000)
});
const data = await response.json() as { success: boolean; result?: { success: boolean; results: Record<string, string | number | null>[] }[] };
if (!response.ok || !data.success || data.result?.length !== queries.length + (requestCountSql ? 1 : 0) || data.result.some(result => !result.success)) {
  throw new Error(`Snapshot query failed or exceeded its row bound (HTTP ${response.status}); no snapshot replaced`);
}
for (const [index, query] of queries.entries()) if (data.result[index]!.results.length > 5000) throw new Error(`${query.table} exceeds 5000 rows; no snapshot replaced. Select an explicit --request-limit for request display history.`);
const snapshot: PreviewSnapshot = { capturedAt: new Date().toISOString(), domain: config.vars.CONSOLE_EMAIL_DOMAIN, accountScoped: values.email !== undefined, tables: {} };
queries.forEach(({ table, columns }, index) => {
  // Project once more before persistence so future API response fields cannot leak in.
  snapshot.tables[table] = data.result![index]!.results.map(row => Object.fromEntries(columns.map(column => [column, row[column] ?? null])));
});
if (requestCountSql) {
  const available = data.result[queries.length]?.results[0]?.n;
  if (typeof available !== "number" || !Number.isSafeInteger(available) || available < snapshot.tables.request_audit!.length) throw new Error("Invalid request history count; no snapshot replaced");
  snapshot.requestHistory = { imported: snapshot.tables.request_audit!.length, available };
}
if (values.email !== undefined && snapshot.tables.users!.length !== 1) throw new Error("Account email must match exactly one human account; no snapshot replaced");
mkdirSync("tmp/console-preview", { recursive: true, mode: 0o700 });
chmodSync("tmp/console-preview", 0o700);
writeFileSync(`${snapshotPath}.new`, JSON.stringify(snapshot), { mode: 0o600 });
chmodSync(`${snapshotPath}.new`, 0o600);
renameSync(`${snapshotPath}.new`, snapshotPath);
console.info(`Saved local ${values.email === undefined ? "metadata" : "account"} snapshot: ${snapshot.tables.users!.length} people/accounts, ${snapshot.tables.api_keys!.length} key metadata rows, ${snapshot.tables.usage_daily?.length ?? 0} usage rows, ${snapshot.tables.request_audit?.length ?? 0} request display rows. No credentials exported.`);
if (snapshot.requestHistory) console.info(`Request display history: latest ${snapshot.requestHistory.imported} of ${snapshot.requestHistory.available} records. Daily usage and credit counters are not sampled.`);
