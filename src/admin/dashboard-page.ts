export const DASHBOARD_PAGE_SIZE = 40;

export function isDashboardPageToken(value: string): boolean {
  return /^[1-9]\d*$/.test(value) && Number.isSafeInteger(Number(value) * DASHBOARD_PAGE_SIZE);
}
