import { HttpError } from "../errors";
import type { UpstreamClientIdentity } from "./execution-plans";
import type { AppDependencies } from "../types";
import {
  projectUpstreamClientIdentity,
  type ProjectedUpstreamClientIdentity
} from "./client-identity";

const STABLE_VERSION = /^\d+\.\d+\.\d+$/;
const CODEX_STABLE_RELEASE_URL = "https://api.github.com/repos/openai/codex/releases/latest";
const GROK_STABLE_CHANNEL_URL = "https://storage.googleapis.com/grok-build-public-artifacts/cli/stable";

export const IDENTITY_VERSION_CRON = "17 * * * *";

type ChannelIdentity = "codex_cli" | "grok_build";
type AdoptionResult = "adopted" | "kept";

/** Return the stored fallback version, or null when no fallback is needed. Fail before credit admission. */
export async function requireFallbackIdentityVersion(
  env: Env,
  identity: UpstreamClientIdentity,
  request: Request
): Promise<string | null> {
  if (projectUpstreamClientIdentity(identity, request, request.headers, null)) return null;
  const version = await readIdentityVersion(env, channelIdentity(identity));
  if (!version) throw unavailable();
  return version;
}

/** Project an already chosen version. Does not read D1. */
export function projectRequiredUpstreamClientIdentity(
  identity: UpstreamClientIdentity,
  request: Request,
  sanitizedHeaders: Headers,
  fallbackVersion: string | null
): ProjectedUpstreamClientIdentity {
  const projected = projectUpstreamClientIdentity(
    identity,
    request,
    sanitizedHeaders,
    fallbackVersion
  );
  if (!projected) throw unavailable();
  return projected;
}

export async function adoptIdentityVersions(
  env: Env,
  fetchImpl: AppDependencies["fetch"]
): Promise<Record<ChannelIdentity, AdoptionResult>> {
  return {
    codex_cli: await adoptChannel(env, "codex_cli", () => readCodexStableVersion(fetchImpl)),
    grok_build: await adoptChannel(env, "grok_build", () => readGrokStableVersion(fetchImpl))
  };
}

async function readIdentityVersion(env: Env, identity: ChannelIdentity): Promise<string | null> {
  const row = await env.DB.prepare(
    "SELECT version FROM upstream_identity_version WHERE identity = ?"
  ).bind(identity).first<{ version: string }>();
  if (!row || !STABLE_VERSION.test(row.version)) return null;
  return row.version;
}

async function adoptChannel(
  env: Env,
  identity: ChannelIdentity,
  read: () => Promise<string | null>
): Promise<AdoptionResult> {
  let version: string | null;
  try {
    version = await read();
  } catch (error) {
    console.error(JSON.stringify({
      event: "identity_version_channel_failed",
      identity,
      error: error instanceof Error ? error.message : "unknown"
    }));
    return "kept";
  }
  if (!version || !STABLE_VERSION.test(version)) return "kept";
  await env.DB.prepare(
    `INSERT INTO upstream_identity_version (identity, version) VALUES (?, ?)
     ON CONFLICT(identity) DO UPDATE SET version = excluded.version`
  ).bind(identity, version).run();
  return "adopted";
}

async function readCodexStableVersion(fetchImpl: AppDependencies["fetch"]): Promise<string | null> {
  const response = await fetchImpl(CODEX_STABLE_RELEASE_URL, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "mini-proxy-core",
      "X-GitHub-Api-Version": "2022-11-28"
    }
  });
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    return null;
  }
  const release = await response.json() as {
    draft?: unknown;
    prerelease?: unknown;
    tag_name?: unknown;
  };
  if (release.draft !== false || release.prerelease !== false || typeof release.tag_name !== "string") {
    return null;
  }
  return /^rust-v(\d+\.\d+\.\d+)$/.exec(release.tag_name)?.[1] ?? null;
}

async function readGrokStableVersion(fetchImpl: AppDependencies["fetch"]): Promise<string | null> {
  const response = await fetchImpl(GROK_STABLE_CHANNEL_URL);
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    return null;
  }
  const version = (await response.text()).trim();
  return STABLE_VERSION.test(version) ? version : null;
}

function channelIdentity(identity: UpstreamClientIdentity): ChannelIdentity {
  if (identity === "codex_cli" || identity === "grok_build") return identity;
  throw new Error(`Unsupported upstream client identity: ${identity}`);
}

function unavailable(): HttpError {
  return new HttpError(
    503,
    "Upstream client identity version is unavailable",
    "server_error",
    "upstream_identity_unavailable"
  );
}
