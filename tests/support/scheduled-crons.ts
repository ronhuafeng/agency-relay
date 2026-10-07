import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function scheduledCrons(): readonly string[] {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const wrangler = JSON.parse(readFileSync(resolve(root, "wrangler.jsonc"), "utf8")) as {
    triggers?: { crons?: unknown };
  };
  const crons = wrangler.triggers?.crons;
  if (!Array.isArray(crons) || crons.some((cron) => typeof cron !== "string")) {
    throw new Error("wrangler triggers.crons must be an array of strings");
  }
  return crons;
}
