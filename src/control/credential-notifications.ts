/** Resolve the console's channel without importing its Workers-only class into
 * HTTP handlers or local metadata previews. */
export function credentialEvents(env: Env) {
  return env.CREDENTIAL_EVENTS.get(env.CREDENTIAL_EVENTS.idFromName(env.ADMIN_DASHBOARD_HOST));
}

/** Best effort after metadata commit; never replaces a provider or write result. */
export async function notifyCredentialChange(env: Env): Promise<void> {
  if (!env.CREDENTIAL_EVENTS) return; // Local metadata preview has no persistent sockets.
  try { await credentialEvents(env).publish(); }
  catch { console.error(JSON.stringify({ event: "credential_notification_unavailable" })); }
}
