import { d1ChangeCount, utcDay } from "../records";
import { nowIso } from "../crypto";

export interface VideoJobRow {
  request_id_hash: string;
  user_id: string;
  route_profile_id: string;
  capability: "video_generation" | "video_edit" | "video_extension";
  status: "pending" | "done" | "failed" | "expired";
  video_seconds: number | null;
  outputs: number | null;
  provider_cost_usd_ticks: number | null;
  created_at: string;
  updated_at: string;
  terminal_at: string | null;
  usage_finalized_at: string | null;
}

export async function createVideoJob(
  env: Env,
  input: {
    request_id_hash: string;
    user_id: string;
    route_profile_id: string;
    capability: VideoJobRow["capability"];
  },
  now = new Date()
): Promise<void> {
  const timestamp = nowIso(now);
  await env.DB.prepare(
    `INSERT INTO video_jobs
     (request_id_hash, user_id, route_profile_id, capability, status, video_seconds, outputs,
      provider_cost_usd_ticks, created_at,
      updated_at, terminal_at, usage_finalized_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    input.request_id_hash,
    input.user_id,
    input.route_profile_id,
    input.capability,
    "pending",
    null,
    null,
    null,
    timestamp,
    timestamp,
    null,
    null
  ).run();
}

const MEDIA_USAGE_DAILY_COLUMNS = `(user_id, day, route_profile_id, capability, started_jobs, completed_jobs, failed_jobs,
      expired_jobs, outputs, video_seconds, output_measurements,
      duration_measurements, provider_cost_usd_ticks, cost_measurements,
      first_seen_at, last_seen_at)`;

export async function recordUntrackedVideoStart(
  env: Env,
  input: {
    user_id: string;
    route_profile_id: string;
    capability: VideoJobRow["capability"];
  },
  now = new Date()
): Promise<void> {
  const timestamp = nowIso(now);
  await env.DB.prepare(
    `INSERT INTO media_usage_daily
     ${MEDIA_USAGE_DAILY_COLUMNS}
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id, day, route_profile_id, capability) DO UPDATE SET
       started_jobs = media_usage_daily.started_jobs + 1,
       first_seen_at = MIN(media_usage_daily.first_seen_at, excluded.first_seen_at),
       last_seen_at = MAX(media_usage_daily.last_seen_at, excluded.last_seen_at)`
  ).bind(
    input.user_id,
    utcDay(now),
    input.route_profile_id,
    input.capability,
    1,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    timestamp,
    timestamp
  ).run();
}

export async function findVideoJobForUser(
  env: Env,
  requestIdHash: string,
  userId: string
): Promise<VideoJobRow | null> {
  return await env.DB.prepare(
    "SELECT * FROM video_jobs WHERE request_id_hash = ? AND user_id = ?"
  ).bind(requestIdHash, userId).first<VideoJobRow>();
}

export async function observeVideoJob(
  env: Env,
  input: {
    request_id_hash: string;
    user_id: string;
    status: VideoJobRow["status"];
    video_seconds: number | null;
    outputs: number | null;
    provider_cost_usd_ticks: number | null;
  },
  now = new Date()
): Promise<boolean> {
  const timestamp = nowIso(now);
  const terminal = input.status === "done" || input.status === "failed" || input.status === "expired";
  const result = await env.DB.prepare(
    `UPDATE video_jobs
     SET status = ?, video_seconds = ?, outputs = ?, provider_cost_usd_ticks = ?, updated_at = ?,
         terminal_at = ?, usage_finalized_at = ?
     WHERE request_id_hash = ? AND user_id = ? AND usage_finalized_at IS NULL`
  ).bind(
    input.status,
    input.status === "done" ? input.video_seconds : null,
    input.status === "done" ? input.outputs : null,
    input.status === "done" ? input.provider_cost_usd_ticks : null,
    timestamp,
    terminal ? timestamp : null,
    terminal ? timestamp : null,
    input.request_id_hash,
    input.user_id
  ).run();
  return d1ChangeCount(result) > 0;
}

export async function cleanupVideoJobs(env: Env, cutoffIso: string): Promise<number> {
  const result = await env.DB.prepare(
    "DELETE FROM video_jobs WHERE updated_at < ?"
  ).bind(cutoffIso).run();
  return d1ChangeCount(result);
}

export interface XaiFileOwnerRow {
  file_id_hash: string;
  user_id: string;
  source: "upload" | "image_output" | "video_output";
  expires_at: string | null;
  created_at: string;
  updated_at: string;
}

export async function bindXaiFileOwner(
  env: Env,
  input: {
    file_id_hash: string;
    user_id: string;
    source: XaiFileOwnerRow["source"];
    expires_at: string | null;
  },
  now = new Date()
): Promise<boolean> {
  const timestamp = nowIso(now);
  await env.DB.prepare(
    "DELETE FROM xai_file_owners WHERE expires_at IS NOT NULL AND expires_at <= ?"
  ).bind(timestamp).run();
  await env.DB.prepare(
    `INSERT OR IGNORE INTO xai_file_owners
     (file_id_hash, user_id, source, expires_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).bind(
    input.file_id_hash,
    input.user_id,
    input.source,
    input.expires_at,
    timestamp,
    timestamp
  ).run();
  return await findXaiFileOwner(env, input.file_id_hash, input.user_id, now) !== null;
}

export async function findXaiFileOwner(
  env: Env,
  fileIdHash: string,
  userId: string,
  now = new Date()
): Promise<XaiFileOwnerRow | null> {
  return await env.DB.prepare(
    `SELECT * FROM xai_file_owners
     WHERE file_id_hash = ? AND user_id = ?
       AND (expires_at IS NULL OR expires_at > ?)`
  ).bind(fileIdHash, userId, nowIso(now)).first<XaiFileOwnerRow>();
}

export async function deleteXaiFileOwner(
  env: Env,
  fileIdHash: string,
  userId: string
): Promise<boolean> {
  const result = await env.DB.prepare(
    "DELETE FROM xai_file_owners WHERE file_id_hash = ? AND user_id = ?"
  ).bind(fileIdHash, userId).run();
  return d1ChangeCount(result) > 0;
}

export async function recordImageMediaUsage(
  env: Env,
  input: {
    user_id: string;
    route_profile_id: string;
    capability: "image_generation" | "image_edit";
    status: "ok" | "error";
    outputs: number | null;
    provider_cost_usd_ticks: number | null;
  },
  now = new Date()
): Promise<void> {
  const timestamp = nowIso(now);
  const completed = input.status === "ok" ? 1 : 0;
  const failed = input.status === "error" ? 1 : 0;
  const outputs = input.outputs ?? 0;
  const outputMeasurements = input.outputs !== null ? 1 : 0;
  const cost = input.provider_cost_usd_ticks ?? 0;
  const costMeasurements = input.provider_cost_usd_ticks !== null ? 1 : 0;
  await env.DB.prepare(
    `INSERT INTO media_usage_daily
     ${MEDIA_USAGE_DAILY_COLUMNS}
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id, day, route_profile_id, capability) DO UPDATE SET
       started_jobs = media_usage_daily.started_jobs + excluded.started_jobs,
       completed_jobs = media_usage_daily.completed_jobs + excluded.completed_jobs,
       failed_jobs = media_usage_daily.failed_jobs + excluded.failed_jobs,
       outputs = media_usage_daily.outputs + excluded.outputs,
       output_measurements = media_usage_daily.output_measurements + excluded.output_measurements,
       provider_cost_usd_ticks = media_usage_daily.provider_cost_usd_ticks + excluded.provider_cost_usd_ticks,
       cost_measurements = media_usage_daily.cost_measurements + excluded.cost_measurements,
       first_seen_at = MIN(media_usage_daily.first_seen_at, excluded.first_seen_at),
       last_seen_at = MAX(media_usage_daily.last_seen_at, excluded.last_seen_at)`
  ).bind(
    input.user_id,
    utcDay(now),
    input.route_profile_id,
    input.capability,
    1,
    completed,
    failed,
    0,
    outputs,
    0,
    outputMeasurements,
    0,
    cost,
    costMeasurements,
    timestamp,
    timestamp
  ).run();
}
