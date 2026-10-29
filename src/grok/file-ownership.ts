import { parseJsonObject, unixSecondsToIso } from "./provider-transport";
import { hmacSha256Hex } from "../crypto";
import { bindXaiFileOwner } from "./media-store";
import { HttpError } from "../errors";
import { XAI_FILE_ID_PATTERN } from "../plans/execution-plans";

export const XAI_FILE_ID = new RegExp(`^${XAI_FILE_ID_PATTERN}$`);

export function xaiFileNotFound(): HttpError {
  return new HttpError(404, "xAI file not found", "invalid_request_error", "xai_file_not_found");
}

export function xaiFileIdFromPath(request: Request): string {
  const pathname = new URL(request.url).pathname;
  const suffix = pathname.endsWith("/content") ? "/content" : "";
  const fileId = pathname.slice("/v1/files/".length, suffix ? -suffix.length : undefined);
  if (!XAI_FILE_ID.test(fileId)) {
    throw xaiFileNotFound();
  }
  return fileId;
}

export async function xaiFileIdHash(env: Env, fileId: string): Promise<string> {
  return await hmacSha256Hex(env.API_KEY_HASH_PEPPER, `xai-file:v1:${fileId}`);
}

export async function bindFileId(
  env: Env,
  fileId: string,
  userId: string,
  source: "upload" | "image_output" | "video_output",
  expiresAt: string | null,
  now: Date
): Promise<boolean> {
  return await bindXaiFileOwner(env, {
    file_id_hash: await xaiFileIdHash(env, fileId),
    user_id: userId,
    source,
    expires_at: expiresAt
  }, now);
}

export function parseXaiFileMetadata(bytes: Uint8Array): {
  fileId: string;
  expiresAt: string | null;
} | null {
  const value = parseJsonObject(bytes);
  const fileId = value?.id;
  if (typeof fileId !== "string" || !XAI_FILE_ID.test(fileId)) {
    return null;
  }
  return { fileId, expiresAt: unixSecondsToIso(value?.expires_at) };
}
