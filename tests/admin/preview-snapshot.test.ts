import { expect, it } from "vitest";
import { createTestD1 } from "../support/sqlite-d1";
import { importSnapshot, reportSnapshotColumns, snapshotColumns, snapshotQueries, type PreviewSnapshot } from "../../scripts/console-preview/snapshot";

it("imports only display metadata and substitutes unusable local key material", () => {
  const db = createTestD1();
  try {
    const stamp = "2026-10-04T00:00:00.000Z";
    const snapshot: PreviewSnapshot = { capturedAt: stamp, domain: "example.test", tables: Object.fromEntries(Object.keys(snapshotColumns).map(name=>[name, []])) };
    snapshot.tables.users = [{ id: "member", email: "member@example.test", canonical_email: "member@example.test", account_kind: "human", login_capable: 1, role: "user", status: "active", display_name: null, created_at: stamp, updated_at: stamp }];
    snapshot.tables.api_keys = [{ id: "key", user_id: "member", status: "active", scopes: "[]", name: "Work", family_id: "family", created_at: stamp, key_hash: "must-not-import", key_prefix: "must-not-import" }];
    importSnapshot(db.sqlite, snapshot);
    const key = db.sqlite.prepare("SELECT key_prefix, key_hash, user_id FROM api_keys").get();
    expect(key).toEqual({ key_prefix: "preview_0", key_hash: "invalid-preview-hash-0", user_id: "member" });
    expect(db.sqlite.prepare("SELECT count(*) AS n FROM console_sessions").get()?.n).toBe(0);
  } finally { db.close(); }
});

it("queries only the selected account and required defaults, preserving report coverage without credentials or correlations", () => {
  const source = createTestD1();
  const local = createTestD1();
  const stamp = "2026-10-04T00:00:00.000Z";
  try {
    const user = source.sqlite.prepare("INSERT INTO users (id,email,canonical_email,role,status,account_kind,login_capable,created_at,updated_at) VALUES (?,?,?,'user','active','human',1,?,?)");
    user.run("target", "o'connor@example.test", "o'connor@example.test", stamp, stamp);
    user.run("foreign", "foreign@example.test", "foreign@example.test", stamp, stamp);
    source.sqlite.prepare("INSERT INTO users (id,status,account_kind,display_name,created_at,updated_at) VALUES ('service','active','service','Owned service',?,?)").run(stamp, stamp);
    source.sqlite.prepare("INSERT INTO service_account_owners (service_user_id,owner_user_id,revision,updated_at) VALUES ('service','target',1,?)").run(stamp);
    const auth = source.sqlite.prepare("INSERT INTO codex_auths (id,kind,label,environment,status,upstream_account_id,created_at,updated_at) VALUES (?,'isolated',?,'production','active','excluded-provider-id',?,?)");
    for (const id of ["default-auth", "target-auth", "foreign-auth"]) auth.run(id, id, stamp, stamp);
    source.sqlite.prepare("INSERT INTO organization_surface_credential_defaults (surface_grant,codex_auth_id,created_at,updated_at) VALUES ('surface:codex:production','default-auth',?,?)").run(stamp, stamp);
    const key = source.sqlite.prepare("INSERT INTO api_keys (id,user_id,key_prefix,key_hash,status,scopes,created_at) VALUES (?,?,?,'excluded-hash','active','[\"surface:codex:production\"]',?)");
    const binding = source.sqlite.prepare("INSERT INTO api_key_surface_credentials (api_key_id,surface_grant,codex_auth_id,created_at,updated_at) VALUES (?,'surface:codex:production',?,?,?)");
    for (const id of ["target", "foreign"]) {
      key.run(`${id}-key`, id, `${id}-prefix`, stamp);
      binding.run(`${id}-key`, `${id}-auth`, stamp, stamp);
      source.sqlite.prepare("INSERT INTO user_surface_credit_policies (user_id,surface_grant,monthly_allowance,created_at,updated_at) VALUES (?,'surface:codex:production',100,?,?)").run(id, stamp, stamp);
      source.sqlite.prepare("INSERT INTO user_surface_credit_usage (user_id,surface_grant,period_start,consumed_credits,admitted_attempts,last_seen_at) VALUES (?,'surface:codex:production','2026-10-01',7,9,?)").run(id, stamp);
      source.sqlite.prepare("INSERT INTO usage_daily (user_id,day,route_profile_id,response_model,requests,ok_requests,error_requests,total_tokens,token_measurements,provider_cost_usd_ticks,cost_measurements,last_seen_at) VALUES (?,'2026-10-04','codex.responses','N/A',11,9,2,1200,8,42,1,?)").run(id, stamp);
      source.sqlite.prepare("INSERT INTO media_usage_daily (user_id,day,route_profile_id,capability,started_jobs,completed_jobs,outputs,output_measurements,duration_measurements,cost_measurements,first_seen_at,last_seen_at) VALUES (?,'2026-10-04','grok.production.videos_generations','video_generation',3,2,2,2,0,0,?,?)").run(id, stamp, stamp);
      source.sqlite.prepare("INSERT INTO request_audit (id,user_id,key_id,route_profile_id,status,request_id,session_id,thread_id,response_id,created_at) VALUES (?,?,?,'codex.responses','ok','excluded-request','excluded-session','excluded-thread','excluded-response',?)").run(`${id}-request`, id, `${id}-key`, stamp);
    }
    const snapshot: PreviewSnapshot = { capturedAt: stamp, domain: "example.test", tables: {} };
    for (const query of snapshotQueries(" O'Connor@example.test ")) snapshot.tables[query.table] = source.sqlite.prepare(query.sql).all() as PreviewSnapshot["tables"][string];
    expect(snapshot.tables.users.map(row => row.id)).toEqual(["target"]);
    expect(snapshot.tables.api_keys.map(row => row.id)).toEqual(["target-key"]);
    expect(snapshot.tables.codex_auths.map(row => row.id).sort()).toEqual(["default-auth", "target-auth"]);
    expect(snapshot.tables.service_account_owners).toEqual([]);
    expect(snapshot.tables.api_keys[0]).not.toHaveProperty("key_hash");
    expect(snapshot.tables.api_keys[0]).not.toHaveProperty("key_prefix");
    expect(snapshot.tables.codex_auths[0]).not.toHaveProperty("upstream_account_id");
    for (const name of ["request_id", "session_id", "thread_id", "response_id"]) expect(snapshot.tables.request_audit[0]).not.toHaveProperty(name);
    importSnapshot(local.sqlite, snapshot);
    expect(local.sqlite.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(local.sqlite.prepare("SELECT consumed_credits,admitted_attempts FROM user_surface_credit_usage").get()).toEqual({ consumed_credits: 7, admitted_attempts: 9 });
    expect(local.sqlite.prepare("SELECT requests,token_measurements,cost_measurements FROM usage_daily").get()).toEqual({ requests: 11, token_measurements: 8, cost_measurements: 1 });
    expect(local.sqlite.prepare("SELECT output_measurements,duration_measurements,cost_measurements FROM media_usage_daily").get()).toEqual({ output_measurements: 2, duration_measurements: 0, cost_measurements: 0 });
    expect(local.sqlite.prepare("SELECT request_id,session_id,thread_id,response_id FROM request_audit").get()).toEqual({ request_id: null, session_id: null, thread_id: null, response_id: null });
  } finally { source.close(); local.close(); }
});

it("rejects invalid account selectors before constructing a download", () => {
  for (const email of ["", "missing-domain", "a@b@c", "a@b; SELECT * FROM users"]) expect(() => snapshotQueries(email)).toThrow("A valid account email is required");
});

it("imports the entire organization with real roles, service ownership and complete report coverage", () => {
  const source = createTestD1();
  const local = createTestD1();
  const stamp = "2026-10-04T00:00:00.000Z";
  try {
    const person = source.sqlite.prepare("INSERT INTO users (id,email,canonical_email,role,status,account_kind,login_capable,created_at,updated_at) VALUES (?,?,?,?,'active','human',1,?,?)");
    person.run("admin", "admin@example.test", "admin@example.test", "admin", stamp, stamp);
    person.run("member", "member@example.test", "member@example.test", "user", stamp, stamp);
    source.sqlite.prepare("INSERT INTO users (id,role,status,account_kind,display_name,created_at,updated_at) VALUES ('service','user','active','service','Synthetic automation',?,?)").run(stamp, stamp);
    source.sqlite.prepare("INSERT INTO service_account_owners (service_user_id,owner_user_id,revision,updated_at) VALUES ('service','member',7,?)").run(stamp);
    source.sqlite.prepare("INSERT INTO codex_auths (id,kind,label,environment,status,upstream_account_id,created_at,updated_at) VALUES ('auth','shared','Synthetic Codex','production','active','excluded-provider-id',?,?)").run(stamp, stamp);
    source.sqlite.prepare("INSERT INTO subscription_accounts (id,capability_source,environment,label,status,provider_account_ref,created_at,updated_at) VALUES ('subscription','grok','production','Synthetic Grok','active','excluded-provider-reference',?,?)").run(stamp, stamp);
    source.sqlite.prepare("INSERT INTO organization_surface_credential_defaults (surface_grant,codex_auth_id,created_at,updated_at) VALUES ('surface:codex:production','auth',?,?)").run(stamp, stamp);
    source.sqlite.prepare("INSERT INTO organization_surface_credential_defaults (surface_grant,subscription_account_id,created_at,updated_at) VALUES ('surface:grok:production','subscription',?,?)").run(stamp, stamp);
    source.sqlite.prepare("INSERT INTO user_surface_credit_policies (user_id,surface_grant,monthly_allowance,created_at,updated_at) VALUES ('member','surface:codex:production',50,?,?)").run(stamp, stamp);
    source.sqlite.prepare("INSERT INTO user_surface_credit_modes (user_id,surface_grant,mode,created_at,updated_at) VALUES ('service','surface:grok:production','unlimited',?,?)").run(stamp, stamp);
    for (const owner of ["member", "service"]) {
      source.sqlite.prepare("INSERT INTO api_keys (id,user_id,key_prefix,key_hash,status,scopes,family_id,created_at) VALUES (?,?,?,'excluded-hash','active','[\"surface:codex:production\"]',?,?)").run(`${owner}-key`, owner, `excluded-${owner}-prefix`, `${owner}-family`, stamp);
      source.sqlite.prepare("INSERT INTO api_key_surface_credentials (api_key_id,surface_grant,codex_auth_id,created_at,updated_at) VALUES (?,'surface:codex:production','auth',?,?)").run(`${owner}-key`, stamp, stamp);
      source.sqlite.prepare("INSERT INTO user_surface_credit_usage (user_id,surface_grant,period_start,consumed_credits,admitted_attempts,last_seen_at) VALUES (?,'surface:codex:production','2026-10-01',7,9,?)").run(owner, stamp);
      source.sqlite.prepare("INSERT INTO usage_daily (user_id,day,route_profile_id,response_model,requests,ok_requests,error_requests,total_tokens,token_measurements,provider_cost_usd_ticks,cost_measurements,last_seen_at) VALUES (?,'2026-10-04','codex.responses','N/A',11,9,2,1200,8,42,1,?)").run(owner, stamp);
      source.sqlite.prepare("INSERT INTO request_audit (id,user_id,key_id,route_profile_id,status,request_id,session_id,thread_id,response_id,created_at) VALUES (?,?,?,'codex.responses','ok','excluded-request','excluded-session','excluded-thread','excluded-response',?)").run(`${owner}-request`, owner, `${owner}-key`, stamp);
    }
    source.sqlite.prepare("INSERT INTO media_usage_daily (user_id,day,route_profile_id,capability,started_jobs,completed_jobs,outputs,output_measurements,duration_measurements,cost_measurements,first_seen_at,last_seen_at) VALUES ('service','2026-10-04','grok.production.videos_generations','video_generation',3,2,2,2,0,0,?,?)").run(stamp, stamp);
    const snapshot: PreviewSnapshot = { capturedAt: stamp, domain: "example.test", tables: {} };
    for (const query of snapshotQueries(undefined, 5000)) snapshot.tables[query.table] = source.sqlite.prepare(query.sql).all() as PreviewSnapshot["tables"][string];
    expect(snapshot.tables.users.map(row => row.id).sort()).toEqual(["admin", "member", "service"]);
    expect(snapshot.tables.service_account_owners).toEqual([{ service_user_id: "service", owner_user_id: "member", revision: 7, updated_at: stamp }]);
    expect(snapshot.tables.subscription_accounts[0]).not.toHaveProperty("provider_account_ref");
    for (const row of snapshot.tables.request_audit) {
      for (const name of ["request_id", "session_id", "thread_id", "response_id"]) expect(row).not.toHaveProperty(name);
    }
    importSnapshot(local.sqlite, snapshot);
    expect(local.sqlite.prepare("SELECT id,role,account_kind,login_capable FROM users ORDER BY id").all()).toEqual([
      { id: "admin", role: "admin", account_kind: "human", login_capable: 1 },
      { id: "member", role: "user", account_kind: "human", login_capable: 1 },
      { id: "service", role: "user", account_kind: "service", login_capable: 0 }
    ]);
    expect(local.sqlite.prepare("SELECT service_user_id,owner_user_id,revision FROM service_account_owners").get()).toEqual({ service_user_id: "service", owner_user_id: "member", revision: 7 });
    expect(local.sqlite.prepare("SELECT user_id,token_measurements,cost_measurements FROM usage_daily ORDER BY user_id").all()).toEqual([
      { user_id: "member", token_measurements: 8, cost_measurements: 1 },
      { user_id: "service", token_measurements: 8, cost_measurements: 1 }
    ]);
    expect(local.sqlite.prepare("SELECT user_id,output_measurements,duration_measurements,cost_measurements FROM media_usage_daily").get()).toEqual({ user_id: "service", output_measurements: 2, duration_measurements: 0, cost_measurements: 0 });
    expect(local.sqlite.prepare("SELECT monthly_allowance FROM user_surface_credit_policies WHERE user_id='member'").get()?.monthly_allowance).toBe(50);
    expect(local.sqlite.prepare("SELECT mode FROM user_surface_credit_modes WHERE user_id='service'").get()?.mode).toBe("unlimited");
    expect(local.sqlite.prepare("SELECT count(*) AS n FROM request_audit").get()?.n).toBe(2);
    expect(local.sqlite.prepare("SELECT count(*) AS n FROM console_sessions").get()?.n).toBe(0);
    expect(local.sqlite.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  } finally { source.close(); local.close(); }
});

it("selects the latest requests with a stable tie break and counts all matching rows", () => {
  const db = createTestD1();
  const stamp = "2026-10-04T00:00:00.000Z";
  try {
    const user = db.sqlite.prepare("INSERT INTO users (id,email,canonical_email,role,status,account_kind,login_capable,created_at,updated_at) VALUES (?,?,?,'user','active','human',1,?,?)");
    for (const id of ["target", "foreign"]) user.run(id, `${id}@example.test`, `${id}@example.test`, stamp, stamp);
    const request = db.sqlite.prepare("INSERT INTO request_audit (id,user_id,route_profile_id,status,created_at) VALUES (?,?,'codex.responses','ok',?)");
    request.run("old", "target", "2026-10-01T00:00:00.000Z");
    request.run("tie-a", "target", stamp);
    request.run("tie-z", "foreign", stamp);
    request.run("tie-m", "target", stamp);
    request.run("newest", "foreign", "2026-10-05T00:00:00.000Z");
    const organization = snapshotQueries(undefined, 3).find(query => query.table === "request_audit")!;
    expect(organization.countSql).toBeDefined();
    const selected = db.sqlite.prepare(organization.sql);
    expect(selected.all().map(row => row.id)).toEqual(["newest", "tie-z", "tie-m"]);
    expect(selected.all().map(row => row.id)).toEqual(["newest", "tie-z", "tie-m"]);
    expect(db.sqlite.prepare(organization.countSql!).get()?.n).toBe(5);
    const account = snapshotQueries("target@example.test", 2).find(query => query.table === "request_audit")!;
    expect(account.countSql).toBeDefined();
    expect(db.sqlite.prepare(account.sql).all().map(row => row.id)).toEqual(["tie-m", "tie-a"]);
    expect(db.sqlite.prepare(account.countSql!).get()?.n).toBe(3);
  } finally { db.close(); }
});

it("rejects partially imported reports without changing the local inventory or defaults", () => {
  const db = createTestD1();
  const stamp = "2026-10-04T00:00:00.000Z";
  try {
    const defaults = db.sqlite.prepare("SELECT * FROM organization_surface_credit_defaults ORDER BY surface_grant").all();
    for (const missing of Object.keys(reportSnapshotColumns)) {
      const snapshot: PreviewSnapshot = { capturedAt: stamp, domain: "example.test", tables: Object.fromEntries(Object.keys({ ...snapshotColumns, ...reportSnapshotColumns }).map(name => [name, []])) };
      snapshot.tables.users = [{ id: "member", email: "member@example.test", canonical_email: "member@example.test", role: "user", status: "active", account_kind: "human", login_capable: 1, display_name: null, created_at: stamp, updated_at: stamp }];
      delete snapshot.tables[missing];
      expect(() => importSnapshot(db.sqlite, snapshot)).toThrow();
      expect(db.sqlite.prepare("SELECT count(*) AS n FROM users").get()?.n).toBe(0);
      expect(db.sqlite.prepare("SELECT * FROM organization_surface_credit_defaults ORDER BY surface_grant").all()).toEqual(defaults);
    }
    const complete: PreviewSnapshot = { capturedAt: stamp, domain: "example.test", tables: Object.fromEntries(Object.keys({ ...snapshotColumns, ...reportSnapshotColumns }).map(name => [name, []])) };
    expect(() => importSnapshot(db.sqlite, complete)).not.toThrow();
  } finally { db.close(); }
});

it("rolls back earlier inventory, report rows and default replacement when the final table fails", () => {
  const db = createTestD1();
  const stamp = "2026-10-04T00:00:00.000Z";
  try {
    db.sqlite.prepare("UPDATE organization_surface_credit_defaults SET monthly_allowance=42 WHERE surface_grant='surface:codex:production'").run();
    const defaults = db.sqlite.prepare("SELECT * FROM organization_surface_credit_defaults ORDER BY surface_grant").all();
    const snapshot: PreviewSnapshot = { capturedAt: stamp, domain: "example.test", tables: Object.fromEntries(Object.keys({ ...snapshotColumns, ...reportSnapshotColumns }).map(name => [name, []])) };
    snapshot.tables.users = [{ id: "member", email: "member@example.test", canonical_email: "member@example.test", role: "user", status: "active", account_kind: "human", login_capable: 1, display_name: null, created_at: stamp, updated_at: stamp }];
    snapshot.tables.api_keys = [{ id: "key", user_id: "member", status: "active", scopes: "[]", expires_at: null, last_used_at: null, created_at: stamp, revoked_at: null, name: "Synthetic review", family_id: "family" }];
    snapshot.tables.organization_surface_credit_defaults = [{ surface_grant: "surface:codex:production", monthly_allowance: 100, created_at: stamp, updated_at: stamp }];
    snapshot.tables.user_surface_credit_usage = [{ user_id: "member", surface_grant: "surface:codex:production", period_start: "2026-10-01", consumed_credits: 7, admitted_attempts: 9, last_seen_at: stamp }];
    snapshot.tables.request_audit = [{ id: "invalid-record", user_id: "member", route_profile_id: "codex.responses", response_model: "N/A", status: null, created_at: stamp }];
    expect(() => importSnapshot(db.sqlite, snapshot)).toThrow();
    expect(db.sqlite.prepare("SELECT count(*) AS n FROM users").get()?.n).toBe(0);
    expect(db.sqlite.prepare("SELECT count(*) AS n FROM api_keys").get()?.n).toBe(0);
    expect(db.sqlite.prepare("SELECT count(*) AS n FROM user_surface_credit_usage").get()?.n).toBe(0);
    expect(db.sqlite.prepare("SELECT * FROM organization_surface_credit_defaults ORDER BY surface_grant").all()).toEqual(defaults);
    expect(db.sqlite.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    snapshot.tables.request_audit = [];
    expect(() => importSnapshot(db.sqlite, snapshot)).not.toThrow();
    expect(db.sqlite.prepare("SELECT count(*) AS n FROM api_keys").get()?.n).toBe(1);
    expect(db.sqlite.prepare("SELECT consumed_credits FROM user_surface_credit_usage").get()?.consumed_credits).toBe(7);
    expect(db.sqlite.prepare("SELECT monthly_allowance FROM organization_surface_credit_defaults WHERE surface_grant='surface:codex:production'").get()?.monthly_allowance).toBe(100);
  } finally { db.close(); }
});
