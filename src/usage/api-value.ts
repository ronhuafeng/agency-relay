import type { CapturedResponseUsage } from "../types";

// Standard text-token rates, checked 2026-10-07. This is not subscription spend.
// https://developers.openai.com/api/docs/pricing
// https://developers.openai.com/api/docs/guides/prompt-caching
export const OPENAI_PRICE_VERSION = "openai-standard-2026-10-07";
type Rates = readonly [input: number, cacheRead: number | null, output: number, cacheWrite?: number];
type Price = { short: Rates; long?: Rates };
// Integer USD ticks per token: USD per million tokens * 10,000.
const PRICES: Readonly<Record<string, Price>> = {
  "gpt-6-astra": { short: [100000, 10000, 500000, 125000], long: [200000, 20000, 750000, 250000] },
  "gpt-6.1-sol": { short: [20000, 1000, 100000, 25000], long: [40000, 2000, 150000, 50000] },
  "gpt-6-luna": { short: [1000, 100, 5000, 1250], long: [2000, 200, 7500, 2500] },
  "gpt-6-sol": { short: [20000, 2000, 100000, 25000], long: [40000, 4000, 150000, 50000] },
  "gpt-5.6-sol": { short: [40000, 4000, 200000, 50000], long: [80000, 8000, 300000, 100000] },
  "gpt-5.6-terra": { short: [20000, 2000, 120000, 25000], long: [40000, 4000, 180000, 50000] },
  "gpt-5.6-luna": { short: [2000, 200, 12000, 2500], long: [4000, 400, 18000, 5000] },
  "gpt-5.5": { short: [50000, 5000, 300000], long: [100000, 10000, 450000] },
  "gpt-5.5-pro": { short: [300000, null, 1800000], long: [600000, null, 2700000] },
  "gpt-5.4": { short: [25000, 2500, 150000], long: [50000, 5000, 225000] },
  "gpt-5.4-pro": { short: [300000, null, 1800000], long: [600000, null, 2700000] },
  "gpt-5.4-mini": { short: [7500, 750, 45000] },
  "gpt-5.4-nano": { short: [2000, 200, 12500] },
  "gpt-5.3-codex": { short: [17500, 1750, 140000] },
  "chat-latest": { short: [50000, 5000, 300000] },
  "gpt-5.2": { short: [17500, 1750, 140000] },
  "gpt-5.2-pro": { short: [210000, null, 1680000] },
  "gpt-5.1": { short: [12500, 1250, 100000] },
  "gpt-5": { short: [12500, 1250, 100000] },
  "gpt-5-mini": { short: [2500, 250, 20000] },
  "gpt-5-nano": { short: [500, 50, 4000] },
  "gpt-5-pro": { short: [150000, null, 1200000] },
  "gpt-4.1": { short: [20000, 5000, 80000] },
  "gpt-4.1-mini": { short: [4000, 1000, 16000] },
  "gpt-4.1-nano": { short: [1000, 250, 4000] },
  "gpt-4o": { short: [25000, 12500, 100000] },
  "gpt-4o-mini": { short: [1500, 750, 6000] },
  "o1": { short: [150000, 75000, 600000] },
  "o3": { short: [20000, 5000, 80000] },
  "o4-mini": { short: [11000, 2750, 44000] }
};
function count(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** Price one physical request. Missing buckets and unknown models stay unpriced. */
export function apiEquivalentValue(capture: CapturedResponseUsage | null): { ticks: number; version: string } | null {
  const price = capture?.model && Object.hasOwn(PRICES, capture.model) ? PRICES[capture.model] : undefined;
  const usage = capture?.usage;
  if (!price || !usage || !count(usage.input_tokens) || !count(usage.cached_input_tokens)
    || !count(usage.output_tokens)) return null;
  const [inputRate, readRate, outputRate, writeRate] = usage.input_tokens > 272000 && price.long
    ? price.long : price.short;
  const writes = writeRate === undefined ? 0 : usage.cache_write_input_tokens;
  if (!count(writes) || usage.cached_input_tokens > usage.input_tokens - writes
    || (usage.cached_input_tokens > 0 && readRate === null)) return null;
  const ticks = BigInt(usage.input_tokens - usage.cached_input_tokens - writes) * BigInt(inputRate)
    + BigInt(usage.cached_input_tokens) * BigInt(readRate ?? 0)
    + BigInt(writes) * BigInt(writeRate ?? 0)
    + BigInt(usage.output_tokens) * BigInt(outputRate);
  if (ticks > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return { ticks: Number(ticks), version: OPENAI_PRICE_VERSION };
}
