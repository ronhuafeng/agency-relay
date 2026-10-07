import { parseIsoMillis } from "../crypto";

const NUMBER_FORMAT = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
const PRESENTATION_CODE_POINT_LIMIT = 256;

/** Visible text limit. Does not escape HTML. */
export function presentText(value: string): string {
  const codePoints = Array.from(value);
  if (codePoints.length <= PRESENTATION_CODE_POINT_LIMIT) return value;
  return `${codePoints.slice(0, PRESENTATION_CODE_POINT_LIMIT - 1).join("")}…`;
}

export function formatNumber(value: number): string {
  return NUMBER_FORMAT.format(value);
}

/** Operator-facing instant. Invalid values stay as stored. */
export function formatOperatorInstant(value: string): string {
  const millis = parseIsoMillis(value);
  if (millis === undefined) return value;
  const iso = new Date(millis).toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

export function formatOperatorInstantOrDash(value: string | null | undefined): string {
  if (!value) return "—";
  return formatOperatorInstant(value);
}

/** Visible person. Service labels are display metadata; human mailboxes remain login identities. */
export function personLabel(person: { readonly id: string; readonly email?: string | null; readonly account_kind?: string; readonly display_name?: string | null } | null | undefined, fallback = "未记录账号"): string {
  if (person?.account_kind === "service" && person.display_name) return person.display_name;
  const email = person?.email?.trim();
  if (email) return email;
  const id = person?.id.trim();
  return id || fallback;
}

export function formatUsdTicks(ticks: number): string {
  const scale = 10_000_000_000;
  const whole = Math.floor(ticks / scale);
  const fractional = String(ticks % scale).padStart(10, "0").replace(/0+$/, "");
  return fractional ? `$${whole}.${fractional}` : `$${whole}`;
}

const USAGE_SECONDS_FORMAT = new Intl.NumberFormat("en-US", {maximumFractionDigits: 3});
export function formatUsageSeconds(value: number): string { return `${USAGE_SECONDS_FORMAT.format(value)} 秒`; }
