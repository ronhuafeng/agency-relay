import { parentPort, workerData } from "node:worker_threads";
import { renameSync, writeFileSync } from "node:fs";
import { commitServiceAccount } from "../../src/auth/service-accounts";
import { HttpError } from "../../src/errors";
import { createTestD1 } from "../support/sqlite-d1";

const input = workerData as { file: string; hold: string };
const actor = { kind: "admin_secret" as const, email: null, subject: null, userId: null, role: null, requestId: "service-race" };
const db = createTestD1({ file: input.file, migrations: "none", beforeRun: async (sql) => {
  if (sql.startsWith("INSERT INTO user_surface_credit_modes")) {
    const row = db.sqlite.prepare("SELECT id FROM users WHERE account_kind = 'service'").get()!;
    writeFileSync(`${input.hold}.tmp`, String(row.id));
    renameSync(`${input.hold}.tmp`, input.hold);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Creation race release timed out")), 10_000);
      parentPort?.once("message", () => { clearTimeout(timer); resolve(); });
    });
  }
} });
const env = { DB: db.binding, API_KEY_HASH_PEPPER: "synthetic", CONSOLE_EMAIL_DOMAIN: "example.com" } as Env;
try {
  const result = await commitServiceAccount(env, actor, "Build agent");
  parentPort?.postMessage({ ok: true, id: result.id });
} catch (error) {
  parentPort?.postMessage({ ok: false, code: error instanceof HttpError ? error.code : "error" });
} finally { db.close(); }
