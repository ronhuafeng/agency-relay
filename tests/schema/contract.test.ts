import { describe, expect, it, onTestFinished } from "vitest";
import { createTestD1 } from "../support/sqlite-d1";

const CURRENT_REQUEST_AUDIT_COLUMNS = [
  "id",
  "request_id",
  "route_profile_id",
  "route",
  "user_id",
  "key_id",
  "codex_auth_id",
  "response_model",
  "status",
  "upstream_status",
  "error_code",
  "session_id",
  "thread_id",
  "latency_ms",
  "response_id",
  "input_tokens",
  "cached_input_tokens",
  "output_tokens",
  "reasoning_tokens",
  "total_tokens",
  "created_at",
  "ingress_profile_id",
  "ingress_protocol",
  "resolved_model",
  "capability_source",
  "subscription_account_id",
  "egress_profile_id",
  "provider_cost_usd_ticks"
] as const;

const VIDEO_JOB_COLUMNS = [
  "request_id_hash",
  "user_id",
  "status",
  "video_seconds",
  "outputs",
  "created_at",
  "updated_at",
  "terminal_at",
  "usage_finalized_at",
  "capability",
  "provider_cost_usd_ticks",
  "route_profile_id"
] as const;

const METERED_USAGE_DAILY_COLUMNS = [
  "user_id",
  "day",
  "route_profile_id",
  "response_model",
  "requests",
  "ok_requests",
  "error_requests",
  "input_tokens",
  "cached_input_tokens",
  "output_tokens",
  "reasoning_tokens",
  "total_tokens",
  "token_measurements",
  "provider_cost_usd_ticks",
  "cost_measurements",
  "first_seen_at",
  "last_seen_at"
] as const;

const METERED_MEDIA_USAGE_DAILY_COLUMNS = [
  "user_id",
  "day",
  "route_profile_id",
  "capability",
  "started_jobs",
  "completed_jobs",
  "failed_jobs",
  "expired_jobs",
  "outputs",
  "video_seconds",
  "output_measurements",
  "duration_measurements",
  "first_seen_at",
  "last_seen_at",
  "provider_cost_usd_ticks",
  "cost_measurements"
] as const;

const XAI_FILE_OWNER_COLUMNS = [
  "file_id_hash",
  "user_id",
  "source",
  "expires_at",
  "created_at",
  "updated_at"
] as const;

describe("current D1 schema", () => {
  it("keeps subscription state and the canonical Operator Audit only", () => {
    const { sqlite: db, close } = createTestD1();
    onTestFinished(close);
    const accountCols = db.prepare("SELECT name FROM pragma_table_info('subscription_accounts')").all()
      .map((row) => (row as { name: string }).name);
    expect(accountCols).toContain("capability_source");
    expect(accountCols).toContain("environment");
    expect(accountCols).not.toContain("project_ref");
    expect(accountCols).not.toContain("access_token");
    expect(accountCols).not.toContain("refresh_token");
    expect(db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'control_plane_audit'"
    ).get()).toBeUndefined();
    const omaCols = db.prepare("SELECT name FROM pragma_table_info('operator_mutation_audit')").all()
      .map((row) => (row as { name: string }).name);
    expect(omaCols).toEqual(expect.arrayContaining([
      "actor_kind", "actor_email", "actor_subject", "action", "target_type", "target_id", "result", "meta"
    ]));
    expect(omaCols).not.toContain("token");
    expect(omaCols).not.toContain("access_token");
    const oauthCols = db.prepare("SELECT name FROM pragma_table_info('oauth_pending_sessions')").all()
      .map((row) => (row as { name: string }).name);
    expect(oauthCols).toEqual(expect.arrayContaining([
      "id", "provider", "state", "code_verifier", "redirect_uri", "expires_at"
    ]));
    const requestCols = db.prepare("SELECT name FROM pragma_table_info('request_audit')").all()
      .map((row) => (row as { name: string }).name);
    expect(requestCols).toEqual(CURRENT_REQUEST_AUDIT_COLUMNS);
    expect(db.prepare("SELECT name FROM pragma_table_info('usage_daily')").all()
      .map((row) => (row as { name: string }).name)).toEqual(METERED_USAGE_DAILY_COLUMNS);
    expect(db.prepare("SELECT name FROM pragma_table_info('video_jobs')").all()
      .map((row) => (row as { name: string }).name)).toEqual(VIDEO_JOB_COLUMNS);
    expect(db.prepare("SELECT name FROM pragma_table_info('media_usage_daily')").all()
      .map((row) => (row as { name: string }).name)).toEqual(METERED_MEDIA_USAGE_DAILY_COLUMNS);
    expect(db.prepare("SELECT name FROM pragma_table_info('video_jobs')").all()
      .map((row) => (row as { name: string }).name)).toContain("route_profile_id");
    expect(db.prepare("SELECT name FROM pragma_table_info('video_jobs') WHERE name LIKE '%request_id%'").all())
      .toEqual([{ name: "request_id_hash" }]);
    expect(db.prepare("SELECT name FROM pragma_table_info('xai_file_owners')").all()
      .map((row) => (row as { name: string }).name)).toEqual(XAI_FILE_OWNER_COLUMNS);
    expect(db.prepare("SELECT name FROM pragma_table_info('xai_file_owners') WHERE name LIKE '%file_id%'").all())
      .toEqual([{ name: "file_id_hash" }]);
    expect(db.prepare("SELECT name FROM pragma_table_info('user_surface_credit_policies')").all()
      .map((row) => (row as { name: string }).name)).toEqual([
      "user_id", "surface_grant", "monthly_allowance", "created_at", "updated_at"
    ]);
    expect(db.prepare("SELECT name FROM pragma_table_info('user_surface_credit_modes')").all()
      .map((row) => (row as { name: string }).name)).toEqual([
      "user_id", "surface_grant", "mode", "created_at", "updated_at"
    ]);
    expect(db.prepare("SELECT name FROM pragma_table_info('user_surface_credit_usage')").all()
      .map((row) => (row as { name: string }).name)).toEqual([
      "user_id", "surface_grant", "period_start", "consumed_credits", "admitted_attempts",
      "last_seen_at"
    ]);
    expect(db.prepare("SELECT name FROM pragma_table_info('codex_auths')").all()
      .map((row) => (row as { name: string }).name)).toEqual(expect.arrayContaining([
      "label", "environment"
    ]));
    expect(db.prepare("SELECT name FROM pragma_table_info('oauth_pending_sessions')").all()
      .map((row) => (row as { name: string }).name)).toContain("credential_account_id");
    expect(db.prepare("SELECT name FROM pragma_table_info('api_key_surface_credentials')").all()
      .map((row) => (row as { name: string }).name)).toEqual([
      "api_key_id", "surface_grant", "codex_auth_id", "subscription_account_id", "created_at", "updated_at"
    ]);
    expect(db.prepare("SELECT name FROM pragma_table_info('upstream_identity_version')").all()
      .map((row) => (row as { name: string }).name)).toEqual(["identity", "version"]);
  });

  it("accounts video start and terminal usage exactly once through schema triggers", () => {
    const { sqlite: db, close } = createTestD1();
    onTestFinished(close);
    db.exec(`
      INSERT INTO users (id, email, status, created_at, updated_at)
      VALUES ('usr', 'user@example.com', 'active', '2026-07-31T00:00:00Z', '2026-07-31T00:00:00Z');
      INSERT INTO video_jobs
        (request_id_hash, user_id, status, video_seconds, outputs, created_at, updated_at)
      VALUES
        ('hashed-id', 'usr', 'pending', 0, 0, '2026-07-31T01:00:00Z', '2026-07-31T01:00:00Z');
      UPDATE video_jobs
      SET status = 'done', video_seconds = 6, outputs = 1,
          provider_cost_usd_ticks = 500000000,
          updated_at = '2026-07-31T01:02:00Z',
          terminal_at = '2026-07-31T01:02:00Z',
          usage_finalized_at = '2026-07-31T01:02:00Z'
      WHERE request_id_hash = 'hashed-id' AND usage_finalized_at IS NULL;
      UPDATE video_jobs
      SET status = 'done', video_seconds = 6, outputs = 1,
          updated_at = '2026-07-31T01:03:00Z',
          terminal_at = '2026-07-31T01:03:00Z',
          usage_finalized_at = '2026-07-31T01:03:00Z'
      WHERE request_id_hash = 'hashed-id' AND usage_finalized_at IS NULL;
    `);
    expect(db.prepare(`
      SELECT started_jobs, completed_jobs, failed_jobs, expired_jobs, outputs, video_seconds,
             output_measurements, duration_measurements, provider_cost_usd_ticks,
             cost_measurements
      FROM media_usage_daily
      WHERE user_id = 'usr' AND day = '2026-07-31' AND capability = 'video_generation'
    `).get()).toEqual({
      started_jobs: 1,
      completed_jobs: 1,
      failed_jobs: 0,
      expired_jobs: 0,
      outputs: 1,
      video_seconds: 6,
      output_measurements: 1,
      duration_measurements: 1,
      provider_cost_usd_ticks: 500000000,
      cost_measurements: 1
    });
  });

  it("preserves unknown provider output and duration measurements", () => {
    const { sqlite: db, close } = createTestD1();
    onTestFinished(close);
    db.exec(`
      INSERT INTO users (id, email, status, created_at, updated_at)
      VALUES ('usr', 'user@example.com', 'active', '2026-07-31T00:00:00Z', '2026-07-31T00:00:00Z');
      INSERT INTO video_jobs
        (request_id_hash, user_id, status, created_at, updated_at)
      VALUES
        ('hashed-id', 'usr', 'pending', '2026-07-31T01:00:00Z', '2026-07-31T01:00:00Z');
      UPDATE video_jobs
      SET status = 'done',
          updated_at = '2026-07-31T01:02:00Z',
          terminal_at = '2026-07-31T01:02:00Z',
          usage_finalized_at = '2026-07-31T01:02:00Z'
      WHERE request_id_hash = 'hashed-id' AND usage_finalized_at IS NULL;
    `);
    expect(db.prepare(`
      SELECT completed_jobs, outputs, video_seconds, output_measurements, duration_measurements
      FROM media_usage_daily
      WHERE user_id = 'usr' AND day = '2026-07-31' AND capability = 'video_generation'
    `).get()).toEqual({
      completed_jobs: 1,
      outputs: 0,
      video_seconds: 0,
      output_measurements: 0,
      duration_measurements: 0
    });
  });

  it("accounts video generation, editing, and extension separately", () => {
    const { sqlite: db, close } = createTestD1();
    onTestFinished(close);
    db.exec(`
      INSERT INTO users (id, email, status, created_at, updated_at)
      VALUES ('usr', 'user@example.com', 'active', '2026-08-01T00:00:00Z', '2026-08-01T00:00:00Z');
      INSERT INTO video_jobs
        (request_id_hash, user_id, capability, status, created_at, updated_at)
      VALUES
        ('edit-id', 'usr', 'video_edit', 'pending', '2026-08-01T01:00:00Z', '2026-08-01T01:00:00Z'),
        ('extension-id', 'usr', 'video_extension', 'pending', '2026-08-01T01:01:00Z', '2026-08-01T01:01:00Z');
    `);
    expect(db.prepare(`
      SELECT capability, started_jobs
      FROM media_usage_daily
      WHERE user_id = 'usr'
      ORDER BY capability
    `).all()).toEqual([
      { capability: "video_edit", started_jobs: 1 },
      { capability: "video_extension", started_jobs: 1 }
    ]);
  });

  it("binds xAI file ownership without storing a raw file id", () => {
    const { sqlite: db, close } = createTestD1();
    onTestFinished(close);
    db.exec(`
      INSERT INTO users (id, email, status, created_at, updated_at)
      VALUES ('usr', 'user@example.com', 'active', '2026-08-01T00:00:00Z', '2026-08-01T00:00:00Z');
      INSERT INTO xai_file_owners
        (file_id_hash, user_id, source, expires_at, created_at, updated_at)
      VALUES
        ('hashed-file-id', 'usr', 'upload', '2026-08-02T01:00:00Z', '2026-08-01T01:00:00Z', '2026-08-01T01:00:00Z');
    `);
    expect(db.prepare("SELECT * FROM xai_file_owners").get()).toEqual({
      file_id_hash: "hashed-file-id",
      user_id: "usr",
      source: "upload",
      expires_at: "2026-08-02T01:00:00Z",
      created_at: "2026-08-01T01:00:00Z",
      updated_at: "2026-08-01T01:00:00Z"
    });
  });
});
