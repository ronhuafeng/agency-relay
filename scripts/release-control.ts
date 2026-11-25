import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

interface Binding { name: string; type: string; text?: string; id?: string; namespace_id?: string; class_name?: string; service_id?: string }
interface Runtime { compatibility_date: string; compatibility_flags: string[] }
interface Version { id: string; annotations: Record<string, string>; resources: { bindings: Binding[]; script_runtime: Runtime } }
interface Deployment { id: string; versions: { version_id: string; percentage: number }[] }
interface Config {
  name: string; compatibility_date: string; compatibility_flags: string[];
  vars: Record<string, string>; secrets: { required: string[] };
  d1_databases: { binding: string; database_id: string }[];
  durable_objects: { bindings: { name: string; class_name: string }[] };
  vpc_services?: { binding: string; service_id: string; remote?: boolean }[];
}

type ProductionRoute = { pattern: string; zone_name?: string; custom_domain?: true };
const privateVariables = ["ADMIN_DASHBOARD_HOST", "CONSOLE_EMAIL_DOMAIN", "CODEX_EGRESS_BASE_URL", "RUNTIME_MCP_ORIGIN"] as const;
const CODEX_EGRESS_BINDING = "CODEX_EGRESS";
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

export function productionConfig(base: Config, input: unknown) {
  const invalid = () => new Error("Invalid private production Worker configuration");
  if (!input || typeof input !== "object" || Array.isArray(input)) throw invalid();
  const settings = input as Record<string, unknown>;
  const { name, databaseName, databaseId, routes, vars, codexEgressTransport = "public", codexEgressServiceId } = settings;
  if (Object.keys(settings).some(key => !["name", "databaseName", "databaseId", "routes", "vars", "codexEgressTransport", "codexEgressServiceId"].includes(key)) ||
      (codexEgressTransport !== "public" && codexEgressTransport !== "vpc") ||
      (codexEgressServiceId !== undefined && (typeof codexEgressServiceId !== "string" || !uuid.test(codexEgressServiceId))) ||
      (codexEgressTransport === "vpc" && codexEgressServiceId === undefined) ||
      typeof name !== "string" || !/^[a-z0-9-]{1,63}$/.test(name) || name === base.name ||
      typeof databaseName !== "string" || !/^[a-zA-Z0-9_-]{1,63}$/.test(databaseName) ||
      typeof databaseId !== "string" || !uuid.test(databaseId) ||
      !Array.isArray(routes) || routes.length < 3 || !vars || typeof vars !== "object" || Array.isArray(vars)) throw invalid();
  const variables = vars as Record<string, unknown>;
  if (Object.keys(variables).length !== privateVariables.length ||
      privateVariables.some(key => typeof variables[key] !== "string" || !/^[a-z0-9.\-:/]+$/.test(variables[key]))) throw invalid();
  const host = /^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/;
  const values = variables as Record<(typeof privateVariables)[number], string>;
  if (!host.test(values.ADMIN_DASHBOARD_HOST) || !host.test(values.CONSOLE_EMAIL_DOMAIN) ||
      !values.CODEX_EGRESS_BASE_URL.startsWith("https://") || !host.test(values.CODEX_EGRESS_BASE_URL.slice(8)) ||
      !values.RUNTIME_MCP_ORIGIN.startsWith("https://") || !host.test(values.RUNTIME_MCP_ORIGIN.slice(8))) throw invalid();
  const checkedRoutes = routes.map((route: unknown): ProductionRoute => {
    if (!route || typeof route !== "object" || Array.isArray(route)) throw invalid();
    const {pattern, zone_name, custom_domain, ...extra} = route as Record<string, unknown>;
    if (Object.keys(extra).length || typeof pattern !== "string") throw invalid();
    if (custom_domain === true && zone_name === undefined && host.test(pattern)) return {pattern,custom_domain:true};
    if (custom_domain === undefined && typeof zone_name === "string" && host.test(zone_name) &&
        pattern.endsWith("/*") && host.test(pattern.slice(0,-2))) return {pattern,zone_name};
    throw invalid();
  });
  if (new Set(checkedRoutes.map(route=>route.pattern)).size !== checkedRoutes.length ||
      ![values.ADMIN_DASHBOARD_HOST,values.RUNTIME_MCP_ORIGIN.slice(8)].every(domain=>
        checkedRoutes.some(route=>route.custom_domain && route.pattern === domain))) throw invalid();
  // VPC Services are production-only: the template declares none, and none is inherited.
  const { vpc_services: _template, ...rest } = base;
  const vpcServices = typeof codexEgressServiceId === "string"
    ? { vpc_services: [{ binding: CODEX_EGRESS_BINDING, service_id: codexEgressServiceId }] } : {};
  return { ...rest, ...vpcServices, name, routes: checkedRoutes,
    vars: { ...base.vars, ...values, CODEX_EGRESS_TRANSPORT: codexEgressTransport as string },
    d1_databases: base.d1_databases.map(db => db.binding === "DB" ? {...db,database_name:databaseName,database_id:databaseId} : db) };
}
export function assertVersion(version: Version, config: Config, sha: string, previous?: Version): void {
  if (version.annotations["workers/message"] !== `release ${sha}`) throw new Error("Version source annotation mismatch");
  const runtime = version.resources.script_runtime;
  if (runtime.compatibility_date !== config.compatibility_date ||
      JSON.stringify([...runtime.compatibility_flags].sort()) !== JSON.stringify([...config.compatibility_flags].sort()) ||
      !runtime.compatibility_flags.includes("global_fetch_strictly_public")) throw new Error("Version runtime mismatch");
  const bindings = version.resources.bindings;
  for (const name of config.secrets.required) {
    if (!bindings.some(b => b.name === name && b.type === "secret_text")) throw new Error("Required secret is absent");
  }
  for (const [name, text] of Object.entries(config.vars)) {
    if (!bindings.some(b => b.name === name && b.type === "plain_text" && b.text === text)) throw new Error("Version variable mismatch");
  }
  for (const db of config.d1_databases) {
    if (!bindings.some(b => b.name === db.binding && b.type === "d1" && b.id === db.database_id)) throw new Error("D1 binding mismatch");
  }
  for (const vpc of config.vpc_services ?? []) {
    if (!bindings.some(b => b.name === vpc.binding && b.type === "vpc_service" && b.service_id === vpc.service_id)) throw new Error("VPC Service binding mismatch");
  }
  for (const object of config.durable_objects.bindings) {
    const binding = bindings.find(b => b.name === object.name && b.type === "durable_object_namespace" && b.class_name === object.class_name);
    if (!binding?.namespace_id) throw new Error("Durable Object binding mismatch");
    if (previous && !previous.resources.bindings.some(b => b.name === object.name && b.namespace_id === binding.namespace_id)) throw new Error("Durable Object namespace changed");
  }
}
export function assertDeployment(deployment: Deployment, version: string): void {
  if (deployment.versions.length !== 1 || deployment.versions[0].version_id !== version || deployment.versions[0].percentage !== 100) throw new Error("Deployment is not the expected version at 100%");
}
export function assertMigrations(expected: string[], applied: string[]): void {
  const latest = Math.max(...expected.map(name => Number(name.split("_")[0])));
  if (!expected.length || expected.some(name => !applied.includes(name)) ||
      applied.some(name => !/^\d+_.+\.sql$/.test(name) || Number(name.split("_")[0]) > latest)) {
    throw new Error("D1 has pending or newer migrations; operator review required");
  }
}
async function run(mode: string): Promise<void> {
  const configPath = process.env.WRANGLER_CONFIG_PATH;
  if (!configPath) throw new Error("Missing private production Worker configuration path");
  if (mode === "prepare") {
    try {
      const base: Config = JSON.parse(readFileSync("wrangler.jsonc", "utf8"));
      const settings: unknown = JSON.parse(process.env.WRANGLER_PRODUCTION_SETTINGS ?? "");
      writeFileSync(configPath, JSON.stringify(productionConfig(base, settings)), { mode: 0o600, flag: "wx" });
    } catch { throw new Error("Unable to create private production Worker configuration"); }
    return;
  }
  const config: Config = JSON.parse(readFileSync(configPath, "utf8"));
  const sha = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const account = process.env.CLOUDFLARE_ACCOUNT_ID, token = process.env.CLOUDFLARE_API_TOKEN;
  if (!account || !token) throw new Error("Missing Cloudflare release credentials");
  const base = `/workers/scripts/${config.name}`;
  async function api<T>(path: string, body?: unknown): Promise<T> {
    const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}${path}`, {
      method: body ? "POST" : "GET", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(30_000), redirect: "error",
    });
    const data = await response.json() as { success: boolean; result: T };
    if (!response.ok || !data.success) throw new Error(`Cloudflare release read failed: HTTP ${response.status}`);
    return data.result;
  }
  const deployment = async () => {
    const result = await api<{ deployments: Deployment[] }>(`${base}/deployments`);
    if (!result.deployments[0]) throw new Error("No current deployment");
    return result.deployments[0];
  };
  if (mode === "preflight") {
    const current = await deployment();
    if (current.versions.length !== 1) throw new Error("Split deployment requires operator review");
    const previous = await api<Version>(`${base}/versions/${current.versions[0].version_id}`);
    assertDeployment(current, previous.id);
    const oldSha = previous.annotations["workers/message"]?.match(/^release ([a-f0-9]{40})$/)?.[1];
    if (!oldSha) throw new Error("Current release source cannot be established");
    // Automatic code release must not apply schema, route, credential or egress changes.
    const oldConfig = JSON.parse(execFileSync("git", ["show", `${oldSha}:wrangler.jsonc`], { encoding: "utf8" }));
    const newConfig = JSON.parse(readFileSync("wrangler.jsonc", "utf8"));
    delete oldConfig.build; delete newConfig.build;
    if (JSON.stringify(oldConfig) !== JSON.stringify(newConfig)) throw new Error("Deployment configuration change requires operator review");
    execFileSync("git", ["diff", "--exit-code", oldSha, sha, "--", "migrations", "deploy/codex-egress-shim/server.mjs", "deploy/codex-egress-shim/*.ts", "deploy/codex-egress-shim/egress-protocol.json"], { stdio: "pipe" });
    assertVersion(previous, config, oldSha);
    for (const db of config.d1_databases) {
      const result = await api<{ success: boolean; results: { name: string }[] }[]>(`/d1/database/${db.database_id}/query`, { sql: "SELECT name FROM d1_migrations ORDER BY name" });
      const expected = readdirSync("migrations").filter(name => name.endsWith(".sql")).sort();
      if (!result[0]?.success) throw new Error("D1 migration query failed");
      assertMigrations(expected, result[0].results.map(row => row.name));
    }
    writeFileSync("tmp/release-before.json", JSON.stringify({ deployment: current.id, version: previous.id, sha: oldSha }));
    console.log("Preflight passed; existing version is the code rollback target. No data rollback or egress update.");
  } else {
    const before = JSON.parse(readFileSync("tmp/release-before.json", "utf8")) as { deployment: string; version: string; sha: string };
    const records = readFileSync("tmp/wrangler-upload.jsonl", "utf8").trim().split("\n").map(line => JSON.parse(line));
    const uploads = records.filter(row => row.type === "version-upload" && row.worker_name === config.name);
    if (uploads.length !== 1 || typeof uploads[0].version_id !== "string") throw new Error("Upload result is ambiguous; reconcile before retry");
    const version = await api<Version>(`${base}/versions/${uploads[0].version_id}`);
    const previous = await api<Version>(`${base}/versions/${before.version}`);
    assertVersion(version, config, sha, previous);
    const current = await deployment();
    if (mode === "uploaded") {
      if (current.id !== before.deployment) throw new Error("Production changed during upload; do not switch traffic");
      if (!process.env.GITHUB_OUTPUT) throw new Error("Missing Actions output destination");
      appendFileSync(process.env.GITHUB_OUTPUT, `version=${version.id}\n`);
    } else if (mode === "deployed") {
      assertDeployment(current, version.id);
      const evidence = { sha, version: version.id, deployment: current.id, traffic: 100, rollbackVersion: before.version, rollbackSha: before.sha, d1: "no pending or newer migrations; historical ledger entries retained; no migration applied", egress: "unchanged", run: process.env.GITHUB_RUN_ID };
      writeFileSync("tmp/release-evidence.json", JSON.stringify(evidence, null, 2) + "\n");
      console.log(JSON.stringify(evidence));
    } else throw new Error("Unknown release phase");
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  run(process.argv[2]).catch(error => { console.error(error instanceof Error ? error.message : "Release failed"); process.exitCode = 1; });
}
