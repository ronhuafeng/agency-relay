export type RuntimeSection = "settings" | "members" | "tools";

export function runtimeAdminHref(id?: string, section: RuntimeSection = "settings", search = "", page = 1): string {
  const params = new URLSearchParams({view: "runtime"});
  if (id) params.set("installation", id);
  if (section !== "settings") params.set("section", section);
  if (search) params.set("q", search);
  if (page > 1) params.set("page", String(page));
  return `/admin?${params}`;
}

export function isRuntimeSection(value: string): value is RuntimeSection {
  return value === "settings" || value === "members" || value === "tools";
}
