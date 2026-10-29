/** Dashboard addresses. Callers pass raw query strings. React and escapeHtml encode them. */
export const DASHBOARD_PEOPLE_PAGE_SIZE = 20;
export const DASHBOARD_PEOPLE_PAGE_SIZES = [10, 20, 40] as const;

export function inventoryUrl(base: string, changes: Record<string, string | null> = {}, anchor = ""): string {
  const url = new URL(base, "https://dashboard.invalid");
  for (const [field, value] of Object.entries(changes)) {
    if (value === null) url.searchParams.delete(field);
    else url.searchParams.set(field, value);
  }
  const view = url.searchParams.get("view");
  if (view !== "overview" && view !== "usage") url.searchParams.delete("range");
  const query = [...url.searchParams].map(([field, value]) => `${encodeURIComponent(field)}=${encodeURIComponent(value)}`).join("&");
  return `${url.pathname}?${query}${anchor ? `#${anchor}` : ""}`;
}

export function accountDashboardUrl(currentUrl: string, account: string): string {
  const selected = new URL(currentUrl, "https://dashboard.invalid").searchParams.get("account");
  return inventoryUrl(currentUrl, { view: "credentials", account, task: null, ...(selected !== account ? { page: null } : {}) });
}

export function viewHref(view: string, range?: string): string {
  if (view !== "overview" && view !== "usage") return `/admin?view=${view}`;
  const key = range === "1d" || range === "7d" || range === "30d" ? range : "7d";
  return `/admin?view=${view}&range=${key}`;
}
