/**
 * Exact legacy Codex path aliases.
 * One canonical Execution Plan stays the authority. This map does not
 * parse bodies, invent upstreams, or match prefixes.
 */
import { CODEX_API_HOSTNAME } from "./execution-plans";

const CODEX_LEGACY_PATH_ALIASES: ReadonlyMap<string, string> = new Map([
  ["/v1/models", "/backend-api/codex/models"],
  ["/v1/responses", "/backend-api/codex/responses"],
  ["/v1/realtime/calls", "/backend-api/codex/realtime/calls"],
  ["/v1/live", "/backend-api/codex/live"],
  ["/v1/audio/transcriptions", "/backend-api/transcribe"]
]);

/**
 * On the Codex host only, rewrite an exact historical pathname onto its
 * canonical plan path. Method and Upgrade stay on the request so plan
 * matching still rejects the wrong combination. Other hosts are unchanged.
 */
export function codexIngressRequest(request: Request): Request {
  const url = new URL(request.url);
  if (url.hostname.toLowerCase() !== CODEX_API_HOSTNAME) {
    return request;
  }
  const canonical = CODEX_LEGACY_PATH_ALIASES.get(url.pathname);
  if (!canonical) {
    return request;
  }
  url.pathname = canonical;
  return new Request(url, request);
}
