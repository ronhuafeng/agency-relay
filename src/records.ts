export function isConfirmValue(value: unknown): boolean {
  return value === true || value === 1 || value === "1" || value === "true" || value === "on" || value === "yes";
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

export function headerMediaType(value: string | null | undefined): string {
  return value?.split(";", 1)[0]?.trim() ?? "";
}

export function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

export function utcDay(value: Date): string {
  return value.toISOString().slice(0, 10);
}

export function isUtcCalendarDay(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && utcDay(parsed) === value;
}

export function nonNegativeIntegerOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

export function firstString(...candidates: unknown[]): string {
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim();
    }
  }
  return "";
}

export function looksLikeJson(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.startsWith("{") || trimmed.startsWith("[");
}
