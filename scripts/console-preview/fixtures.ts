import { readSnapshot, importSnapshot } from "./snapshot";
import { createTestD1 } from "../../tests/support/sqlite-d1";
import { createConsoleSession, CONSOLE_COOKIE } from "../../src/auth/console-session";

export const PREVIEW_ORIGIN = "https://console.preview.test";
export const scenarios = ["populated", "empty", "long", "snapshot"] as const;
export type Scenario = typeof scenarios[number];

/** Synthetic SQL rows, real migrations and production routes. No remote credentials. */
export async function createPreviewFixture(scenario: Scenario, preferredEmail?: string) {
  const db = createTestD1();
  const now = new Date();
  const stamp = now.toISOString();
  const env: Env = {
    DB: db.binding, ADMIN_DASHBOARD_HOST: new URL(PREVIEW_ORIGIN).hostname,
    CONSOLE_EMAIL_DOMAIN: "example.test", API_KEY_HASH_PEPPER: "local-preview-only",
    TOKEN_ENCRYPTION_KEY_V1: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
    ADMIN_SECRET: "local-preview-only", CODEX_EGRESS_SECRET: "local-preview-only",
    CODEX_EGRESS_BASE_URL: "https://provider.invalid", CODEX_OAUTH_TOKEN_URL: "https://provider.invalid/token",
    CODEX_CLIENT_ID: "local-preview", FEISHU_APP_ID: "local-preview", FEISHU_APP_SECRET: "local-preview",
    REQUEST_AUDIT_RETENTION_DAYS: "7",
    CREDENTIAL_EVENTS: undefined as unknown as Env["CREDENTIAL_EVENTS"],
    TOKEN_AUTHORITY: { idFromName: (name: string) => name, get: () => new Proxy({}, { get: () => async () => { throw new Error("Provider connection is not part of the local scenario"); } }) } as unknown as Env["TOKEN_AUTHORITY"]
  };
  if (scenario === "snapshot") {
    try {
      const snapshot = readSnapshot();
      if (!snapshot) throw new Error("Download the preview snapshot first");
      importSnapshot(db.sqlite, snapshot);
      env.CONSOLE_EMAIL_DOMAIN = snapshot.domain;
      const cookies = new Map<string, string>();
      for (const role of ["admin", "member"]) {
        const row = db.sqlite.prepare("SELECT id, canonical_email AS email, console_session_epoch AS sessionEpoch FROM users WHERE role=? AND status='active' AND login_capable=1 AND account_kind='human' ORDER BY CASE WHEN canonical_email=? THEN 0 ELSE 1 END, id LIMIT 1").get(role === "admin" ? "admin" : "user", preferredEmail?.trim().toLowerCase() ?? null) as {id: string; email: string; sessionEpoch: number} | undefined;
        if (row) cookies.set(role, `${CONSOLE_COOKIE}=${await createConsoleSession(env, row, now)}`);
      }
      return { env, cookies, close: () => db.close() };
    } catch (error) { db.close(); throw error; }
  }
  const insert = db.sqlite.prepare(`INSERT INTO users (id,email,canonical_email,role,status,account_kind,login_capable,display_name,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)`);
  for (const role of ["admin", "member"] as const) {
    insert.run(role, `${role}@example.test`, `${role}@example.test`, role === "admin" ? "admin" : "user", "active", "human", 1, null, stamp, stamp);
  }
  if (scenario !== "empty") {
    const people = scenario === "long" ? 48 : 8;
    for (let index = 0; index < people; index++) {
      const id = `person-${String(index + 1).padStart(2, "0")}`;
      const email = scenario === "long" && index === 0 ? "long.department.and.project.name@example.test" : `${["lin", "chen", "wang", "zhou"][index % 4]}.${index + 1}@example.test`;
      insert.run(id, email, email, "user", index === 3 ? "disabled" : "active", "human", 1, null, stamp, stamp);
    }
    for (const [id, name, status] of [["service-build", "每日构建", "active"], ["service-report", "用量周报", "disabled"]]) {
      insert.run(id, null, null, "user", status, "service", 0, name, stamp, stamp);
    }
    insert.run("usr_6a0cd219-4b33-4279-8696-29445903d07e", null, null, "user", "active", "legacy_unresolved", 0, null, stamp, stamp);
    db.sqlite.prepare(`INSERT INTO codex_auths (id,kind,label,environment,status,created_at,updated_at) VALUES ('preview-codex','shared','团队 Codex','production','active',?,?)`).run(stamp, stamp);
    db.sqlite.prepare(`INSERT INTO organization_surface_credential_defaults (surface_grant,codex_auth_id,created_at,updated_at) VALUES ('surface:codex:production','preview-codex',?,?)`).run(stamp, stamp);
    db.sqlite.exec("UPDATE organization_surface_credit_defaults SET monthly_allowance=100 WHERE surface_grant='surface:codex:production'");
    for (const id of ["member", "person-01", "person-02", "service-build"]) {
      db.sqlite.prepare(`INSERT INTO api_keys (id,user_id,key_prefix,key_hash,status,scopes,name,family_id,expires_at,created_at) VALUES (?,?,?,'invalid-preview-hash','active','["surface:codex:production"]',?,?,?,?)`).run(`${id}-key`, id, `display_${id}`, "工作电脑", `${id}-family`, new Date(now.getTime()+30*86400000).toISOString(), stamp);
      db.sqlite.prepare(`INSERT INTO api_key_surface_credentials (api_key_id,surface_grant,codex_auth_id,created_at,updated_at) VALUES (?,'surface:codex:production','preview-codex',?,?)`).run(`${id}-key`,stamp,stamp);
    }
    // Display-only metadata exercises records, exact-key evidence and coverage.
    // It contains no traffic body, prompt, provider token or usable key material.
    const request = db.sqlite.prepare(`INSERT INTO request_audit
      (id,request_id,route_profile_id,route,user_id,key_id,codex_auth_id,status,
       upstream_status,error_code,latency_ms,total_tokens,created_at)
      VALUES (?,?,'codex.responses','/v1/responses',?,?,'preview-codex',?,?,?,?,?,?)`);
    const usage = db.sqlite.prepare(`INSERT INTO usage_daily
      (user_id,day,route_profile_id,response_model,requests,ok_requests,error_requests,
       total_tokens,token_measurements,first_seen_at,last_seen_at)
      VALUES (?,?,'codex.responses','N/A',1,?,?,?,?,?,?)
      ON CONFLICT(user_id,day,route_profile_id,response_model) DO UPDATE SET
        requests=requests+1,ok_requests=ok_requests+excluded.ok_requests,
        error_requests=error_requests+excluded.error_requests,
        total_tokens=total_tokens+excluded.total_tokens,
        token_measurements=token_measurements+excluded.token_measurements,
        first_seen_at=MIN(first_seen_at,excluded.first_seen_at),
        last_seen_at=MAX(last_seen_at,excluded.last_seen_at)`);
    for (let index = 0; index < (scenario === "long" ? 32 : 12); index++) {
      const owner = ["member", "person-01", "person-02", "service-build"][index % 4]!;
      const at = new Date(now.getTime() - (index * 3 + 1) * 3_600_000).toISOString();
      const failed = index % 5 === 0;
      const tokens = failed || index % 3 === 0 ? null : (index + 1) * 120;
      request.run(`preview-request-${String(index).padStart(2,"0")}`,`preview-correlation-${index}`,owner,`${owner}-key`,failed ? "error" : "ok",failed ? null : 200,failed ? "provider_upstream_transport_error" : null,failed ? null : 350 + index * 80,tokens,at);
      usage.run(owner,at.slice(0,10),failed ? 0 : 1,failed ? 1 : 0,tokens ?? 0,tokens === null ? 0 : 1,at,at);
      db.sqlite.prepare("UPDATE api_keys SET last_used_at=? WHERE id=? AND (last_used_at IS NULL OR last_used_at<?)").run(at,`${owner}-key`,at);
    }
  }
  const cookies = new Map<string, string>();
  for (const id of ["admin", "member"]) cookies.set(id, `${CONSOLE_COOKIE}=${await createConsoleSession(env, { id, email: `${id}@example.test`, sessionEpoch: 0 }, now)}`);
  return { env, cookies, close: () => db.close() };
}
