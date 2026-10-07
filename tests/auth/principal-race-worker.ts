import { writeFileSync } from "node:fs";
import { parentPort, workerData } from "node:worker_threads";
import { HttpError } from "../../src/errors";
import { commitUserRole, commitUserStatus, resolveConsolePrincipal, type LifecycleActor } from "../../src/auth/principal";
import { createTestD1 } from "../support/sqlite-d1";

interface RaceData {
  file: string;
  mode: "role" | "status" | "jit";
  delayMs: number;
  holdFile: string;
  targetId?: string;
  email?: string;
}

const data = workerData as RaceData;
const actor: LifecycleActor = {
  kind: "admin_secret",
  email: null,
  subject: null,
  userId: null,
  role: null,
  requestId: "race"
};
const db = createTestD1({
  file: data.file,
  migrations: "none",
  timeout: 8_000,
  beforeRun: async (sql) => {
    const watched = data.mode !== "jit" ? sql.startsWith("UPDATE users") : sql.startsWith("INSERT INTO users");
    if (data.delayMs > 0 && watched) {
      writeFileSync(data.holdFile, "held");
      await new Promise((resolve) => setTimeout(resolve, data.delayMs));
    }
  }
});

const started = Date.now();
try {
  if (data.mode !== "jit") {
    const result = data.mode === "status" ? await commitUserStatus(
      { DB: db.binding, CONSOLE_EMAIL_DOMAIN: "example.com" } as Env, actor, data.targetId ?? "", "disabled", new Date("2026-09-30T00:00:00.000Z")
    ) : await commitUserRole(
      { DB: db.binding, CONSOLE_EMAIL_DOMAIN: "example.com" } as Env,
      actor,
      data.targetId ?? "",
      "user",
      new Date("2026-09-30T00:00:00.000Z")
    );
    parentPort?.postMessage({ ok: true, elapsed: Date.now() - started, id: result.id, role: "role" in result ? result.role : undefined });
  } else {
    const result = await resolveConsolePrincipal(
      { DB: db.binding, CONSOLE_EMAIL_DOMAIN: "example.com" } as Env,
      data.email ?? "",
      new Date("2026-09-30T00:00:00.000Z"),
      { subject: `sub-${data.delayMs}`, requestId: "race" }
    );
    parentPort?.postMessage({ ok: true, elapsed: Date.now() - started, id: result.id, role: "role" in result ? result.role : undefined });
  }
} catch (error) {
  parentPort?.postMessage({
    ok: false,
    elapsed: Date.now() - started,
    status: error instanceof HttpError ? error.status : 0,
    code: error instanceof HttpError ? error.code ?? "error" : "error"
  });
} finally {
  db.close();
}
