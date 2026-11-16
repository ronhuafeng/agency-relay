import { bytesToHex, parseIsoMillis } from "../crypto";

/** Read-model identity for quiet console updates, not HTTP caching or authority.
 * Read clocks and transient write acknowledgements are not business changes.
 * An expiry that has passed is one: pages derive key state from it at render time,
 * so an unchanged row must still produce a new revision once it expires. */
export async function consoleDataRevision(model: unknown, nowMs?: number): Promise<string> {
  const value = JSON.stringify(model, (key, value: unknown) => {
    if (["asOf", "dataAsOf", "nowMs", "mutationFlash"].includes(key)) return undefined;
    if (nowMs !== undefined && key === "expires_at" && typeof value === "string") {
      const expiry = parseIsoMillis(value);
      return expiry !== undefined && expiry <= nowMs ? {at: value, expired: true} : value;
    }
    return value;
  });
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return bytesToHex(new Uint8Array(digest));
}

/** Empty fresh-read acknowledgement; never a reusable browser/cache response. */
export function unchangedConsoleRead(requested: string | null | undefined, revision: string | undefined, actorId: string | null | undefined): Response | null {
  if (!revision || !actorId || requested !== revision) return null;
  return new Response(null, {status: 204, headers: {
    "Cache-Control": "private, no-store",
    "X-Console-Revision": revision,
    "X-Console-Actor-Id": actorId,
    "Referrer-Policy": "no-referrer"
  }});
}
