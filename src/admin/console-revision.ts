/** Read-model identity for quiet console updates, not HTTP caching or authority.
 * Read clocks and transient write acknowledgements are not business changes. */
export async function consoleDataRevision(model: unknown): Promise<string> {
  const value = JSON.stringify(model, (key, value: unknown) =>
    ["asOf", "dataAsOf", "nowMs", "mutationFlash"].includes(key) ? undefined : value);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}
