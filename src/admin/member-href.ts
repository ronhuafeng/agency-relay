/** Stable personal HTML locations, including for administrators. /me remains JSON. */
export function memberHref(view: "home" | "keys" | "usage" | "quota" | "setup", key?: string, serviceId?: string): string {
  const query = new URLSearchParams({ area: "me", view });
  if (key !== undefined) query.set("key", key);
  if (serviceId) { query.delete("area"); return `/me/service-accounts/${encodeURIComponent(serviceId)}?${query}`; }
  return `/admin?${query}`;
}
