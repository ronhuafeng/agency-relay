import type { UpstreamClientIdentity } from "./execution-plans";

const CODEX_ORIGINATOR_HEADER = "originator";
const GROK_VERSION_HEADER = "x-grok-client-version";
const GROK_IDENTIFIER_HEADER = "x-grok-client-identifier";
const GROK_MODE_HEADER = "x-grok-client-mode";
const USER_AGENT_HEADER = "user-agent";
const SEMVER_IDENTIFIER = "[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*";
const SEMVER = `[0-9]+\\.[0-9]+\\.[0-9]+(?:-${SEMVER_IDENTIFIER})?(?:\\+${SEMVER_IDENTIFIER})?`;
const SEMVER_PATTERN = new RegExp(`^${SEMVER}$`);
const CODEX_USER_AGENT_PATTERN = new RegExp(
  `^([^/]+)/(${SEMVER}) \\([^()]+; [^()]+\\) \\S+(?: \\([^\\r\\n]*\\))?$`
);
const GROK_USER_AGENT_PATTERN = new RegExp(
  `(?:^|\\s)grok-shell/(${SEMVER}) \\([^();]+; [^()]+\\)$`
);

export interface ProjectedUpstreamClientIdentity {
  headers: Headers;
  search: string;
}

/**
 * Project one plan-selected Provider client identity after credential/header
 * isolation. A complete native identity is replayed as one bundle; otherwise
 * one verified fallback bundle is used. Identity is metadata, never authority.
 */
export function projectUpstreamClientIdentity(
  identity: UpstreamClientIdentity,
  request: Request,
  sanitizedHeaders: Headers,
  fallbackVersion: string | null = null
): ProjectedUpstreamClientIdentity | null {
  const headers = new Headers(sanitizedHeaders);
  const url = new URL(request.url);
  if (identity === "none") return { headers, search: url.search };
  if (identity === "codex_cli") {
    const native = nativeCodexIdentity(request, url);
    if (native) {
      stripCodexIdentity(headers);
      headers.set(CODEX_ORIGINATOR_HEADER, native.originator);
      headers.set(USER_AGENT_HEADER, native.userAgent);
      return { headers, search: url.search };
    }
    if (!fallbackVersion) return null;
    stripCodexIdentity(headers);
    headers.set(CODEX_ORIGINATOR_HEADER, "codex_cli_rs");
    headers.set(
      USER_AGENT_HEADER,
      `codex_cli_rs/${fallbackVersion} (Linux 6.6; x86_64) unknown`
    );
    if (url.pathname === "/v1/models") {
      return {
        headers,
        search: replaceRawQueryParameter(url.search, "client_version", fallbackVersion)
      };
    }
    return { headers, search: url.search };
  }

  if (identity !== "grok_build") return assertNever(identity);
  const native = nativeGrokIdentity(request);
  if (native) {
    stripGrokIdentity(headers);
    headers.set(GROK_VERSION_HEADER, native.version);
    headers.set(GROK_IDENTIFIER_HEADER, native.identifier);
    headers.set(USER_AGENT_HEADER, native.userAgent);
    if (native.mode !== null) headers.set(GROK_MODE_HEADER, native.mode);
    return { headers, search: url.search };
  }
  if (!fallbackVersion) return null;
  stripGrokIdentity(headers);
  headers.set(GROK_VERSION_HEADER, fallbackVersion);
  headers.set(GROK_IDENTIFIER_HEADER, "grok-shell");
  headers.set(GROK_MODE_HEADER, "headless");
  headers.set(USER_AGENT_HEADER, `grok-shell/${fallbackVersion} (linux; x86_64)`);
  return { headers, search: url.search };
}

function nativeCodexIdentity(
  request: Request,
  url: URL
): { originator: string; userAgent: string } | null {
  const originator = request.headers.get(CODEX_ORIGINATOR_HEADER);
  const userAgent = request.headers.get(USER_AGENT_HEADER);
  if (!originator || !userAgent || !isFirstPartyCodexOriginator(originator)) {
    return null;
  }
  const match = userAgent.match(CODEX_USER_AGENT_PATTERN);
  if (!match || !isFirstPartyCodexOriginator(match[1])) {
    return null;
  }
  if (url.pathname === "/v1/models") {
    const clientVersions = url.searchParams.getAll("client_version");
    if (clientVersions.length !== 1 || clientVersions[0] !== wholeVersion(match[2])) {
      return null;
    }
  }
  return { originator, userAgent };
}

function nativeGrokIdentity(
  request: Request
): { version: string; identifier: string; mode: string | null; userAgent: string } | null {
  const version = request.headers.get(GROK_VERSION_HEADER);
  const identifier = request.headers.get(GROK_IDENTIFIER_HEADER);
  const mode = request.headers.get(GROK_MODE_HEADER);
  const userAgent = request.headers.get(USER_AGENT_HEADER);
  if (
    !version
    || !SEMVER_PATTERN.test(version)
    || identifier !== "grok-shell"
    || !userAgent
    || (mode !== null && mode !== "headless" && mode !== "interactive")
  ) {
    return null;
  }
  const userAgentVersion = userAgent.match(GROK_USER_AGENT_PATTERN)?.[1];
  if (userAgentVersion !== version) {
    return null;
  }
  return { version, identifier, mode, userAgent };
}

function isFirstPartyCodexOriginator(value: string): boolean {
  return value === "codex_cli_rs"
    || value === "codex-tui"
    || value === "codex_vscode"
    || value.startsWith("Codex ");
}

function stripCodexIdentity(headers: Headers): void {
  headers.delete(CODEX_ORIGINATOR_HEADER);
  headers.delete(USER_AGENT_HEADER);
}

function stripGrokIdentity(headers: Headers): void {
  headers.delete(GROK_VERSION_HEADER);
  headers.delete(GROK_IDENTIFIER_HEADER);
  headers.delete(GROK_MODE_HEADER);
  headers.delete(USER_AGENT_HEADER);
}

function wholeVersion(version: string): string {
  return version.match(/^\d+\.\d+\.\d+/)?.[0] ?? version;
}

function replaceRawQueryParameter(search: string, name: string, value: string): string {
  const raw = search.startsWith("?") ? search.slice(1) : search;
  const segments = raw ? raw.split("&") : [];
  const retained = segments.filter((segment) => rawQueryName(segment) !== name);
  retained.push(`${encodeURIComponent(name)}=${encodeURIComponent(value)}`);
  return `?${retained.join("&")}`;
}

function rawQueryName(segment: string): string | null {
  const encoded = segment.split("=", 1)[0].replace(/\+/g, " ");
  try {
    return decodeURIComponent(encoded);
  } catch {
    return null;
  }
}

function assertNever(value: never): never {
  throw new Error(`Unsupported upstream client identity: ${String(value)}`);
}
