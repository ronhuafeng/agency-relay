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
  if (!Number.isSafeInteger(ticks) || ticks < 0) return "超出精确范围";
  const scale = 10_000_000_000n;
  const amount = BigInt(ticks);
  const whole = amount / scale;
  const fractional = String(amount % scale).padStart(10, "0").replace(/0+$/, "");
  return fractional ? `$${whole}.${fractional}` : `$${whole}`;
}

/** One column width. Exact tick text stays on formatUsdTicks. */
export function formatUsdColumn(ticks: number): string {
  if (!Number.isSafeInteger(ticks) || ticks < 0) return "超出精确范围";
  const scale = 10_000_000_000n;
  const places = 4n;
  const unit = scale / 10n ** places;
  const amount = BigInt(ticks);
  const rounded = (amount + unit / 2n) / unit;
  if (amount > 0n && rounded === 0n) return "<$0.0001";
  const whole = rounded / 10n ** places;
  const fraction = String(rounded % 10n ** places).padStart(Number(places), "0");
  return `$${whole}.${fraction}`;
}

const USAGE_SECONDS_FORMAT = new Intl.NumberFormat("en-US", {maximumFractionDigits: 3});
export function formatUsageSeconds(value: number): string { return `${USAGE_SECONDS_FORMAT.format(value)} 秒`; }
