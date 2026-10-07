import { HttpError } from "../errors";

const SAFE_READS = new Set(["GET", "HEAD"]);

/**
 * One browser-write boundary for every console-session mutation.
 * The trusted origin is the configured dashboard host, not a forwarded host.
 */
export function assertConsoleBrowserWrite(request: Request, env: Env, url: URL): void {
  if (SAFE_READS.has(request.method)) {
    return;
  }
  const host = env.ADMIN_DASHBOARD_HOST;
  const origin = request.headers.get("Origin");
  if (
    url.hostname !== host
    || origin !== `https://${host}`
    || request.headers.get("Sec-Fetch-Site") === "cross-site"
  ) {
    throw new HttpError(403, "Admin authentication required", "authentication_error", "browser_write_rejected");
  }
}
