import { writeFileSync } from "node:fs";
import { parentPort, workerData } from "node:worker_threads";
import { HttpError } from "../../src/errors";
import { consumeSurfaceCredits } from "../../src/auth/credits";
import { createTestD1 } from "../support/sqlite-d1";

const data = workerData as { file: string; delayMs: number; holdFile: string };
const db = createTestD1({
  file: data.file,
  migrations: "none",
  timeout: 8_000,
  beforeRun: async (sql) => {
    if (data.delayMs > 0 && sql.startsWith("INSERT INTO user_surface_credit_usage")) {
      writeFileSync(data.holdFile, "held");
      await new Promise((resolve) => setTimeout(resolve, data.delayMs));
    }
  }
});
const started = Date.now();
try {
  await consumeSurfaceCredits({ DB: db.binding } as Env, {
    user_id: "sop-plus",
    surface_grant: "surface:grok:production",
    plan_id: "grok.production.responses",
    credit_charge: 1
  }, new Date("2026-08-10T12:00:00.000Z"));
  parentPort?.postMessage({ ok: true, elapsed: Date.now() - started });
} catch (error) {
  parentPort?.postMessage({
    ok: false,
    elapsed: Date.now() - started,
    code: error instanceof HttpError ? error.code : "error"
  });
} finally {
  db.close();
}
