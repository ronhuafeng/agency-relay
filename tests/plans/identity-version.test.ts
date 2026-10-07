import { describe, expect, it, vi } from "vitest";
import { HttpError } from "../../src/errors";
import { handleScheduled } from "../../src/router";
import type { AppDependencies } from "../../src/types";
import {
  adoptIdentityVersions,
  IDENTITY_VERSION_CRON,
  requireFallbackIdentityVersion
} from "../../src/plans/identity-version";
import { seedIdentityVersions, TEST_IDENTITY_VERSION } from "../support/identity-version";
import { scheduledCrons } from "../support/scheduled-crons";
import { createTestD1 } from "../support/sqlite-d1";

function env(db: ReturnType<typeof createTestD1>["binding"]): Env {
  return { DB: db } as Env;
}

describe("upstream identity version", () => {
  it("reads one stored version for an incomplete bundle and does not read D1 when no fallback is needed", async () => {
    const nativeDb = createTestD1({
      onPrepare(sql) {
        if (sql.includes("upstream_identity_version")) throw new Error("native identity read D1");
      }
    });
    const nativeRequest = new Request("https://api.trustedtunnel.app/v1/responses", {
      method: "POST",
      headers: {
        Originator: "codex_cli_rs",
        "User-Agent": "codex_cli_rs/0.149.0 (Linux 6.6; x86_64) unknown"
      }
    });
    await expect(requireFallbackIdentityVersion(
      env(nativeDb.binding),
      "codex_cli",
      nativeRequest
    )).resolves.toBeNull();
    const noneRequest = new Request("https://xai.trustedtunnel.app/v1/models");
    await expect(requireFallbackIdentityVersion(
      env(nativeDb.binding),
      "none",
      noneRequest
    )).resolves.toBeNull();
    nativeDb.close();

    const empty = createTestD1();
    const incomplete = new Request("https://api.trustedtunnel.app/v1/models");
    await expect(requireFallbackIdentityVersion(
      env(empty.binding),
      "codex_cli",
      incomplete
    )).rejects.toMatchObject({
      status: 503,
      code: "upstream_identity_unavailable"
    } satisfies Partial<HttpError>);
    empty.close();

    const stored = createTestD1();
    seedIdentityVersions(stored.sqlite);
    await expect(requireFallbackIdentityVersion(
      env(stored.binding),
      "codex_cli",
      incomplete
    )).resolves.toBe(TEST_IDENTITY_VERSION);
    stored.sqlite.prepare(
      "UPDATE upstream_identity_version SET version = 'not-a-version' WHERE identity = 'codex_cli'"
    ).run();
    await expect(requireFallbackIdentityVersion(
      env(stored.binding),
      "codex_cli",
      incomplete
    )).rejects.toMatchObject({
      status: 503,
      code: "upstream_identity_unavailable"
    } satisfies Partial<HttpError>);
    stored.close();
  });

  it("adopts a valid stable version and keeps the previous row when the channel is unusable", async () => {
    const db = createTestD1();
    seedIdentityVersions(db.sqlite, "1.0.0");
    const fetchOk: AppDependencies["fetch"] = async (input) => {
      const url = String(input);
      if (url.includes("api.github.com")) {
        return Response.json({
          draft: false,
          prerelease: false,
          tag_name: "rust-v9.8.7"
        });
      }
      return new Response("4.5.6\n");
    };
    await expect(adoptIdentityVersions(env(db.binding), fetchOk)).resolves.toEqual({
      codex_cli: "adopted",
      grok_build: "adopted"
    });
    expect(db.sqlite.prepare(
      "SELECT identity, version FROM upstream_identity_version ORDER BY identity"
    ).all()).toEqual([
      { identity: "codex_cli", version: "9.8.7" },
      { identity: "grok_build", version: "4.5.6" }
    ]);

    const fetchBad: AppDependencies["fetch"] = async (input) => {
      const url = String(input);
      if (url.includes("api.github.com")) {
        return Response.json({ draft: false, prerelease: true, tag_name: "rust-v9.9.0" });
      }
      return new Response("not-a-version");
    };
    await expect(adoptIdentityVersions(env(db.binding), fetchBad)).resolves.toEqual({
      codex_cli: "kept",
      grok_build: "kept"
    });
    expect(db.sqlite.prepare(
      "SELECT version FROM upstream_identity_version WHERE identity = 'codex_cli'"
    ).get()).toEqual({ version: "9.8.7" });
    db.close();
  });

  it("runs identity adoption on the hourly cron without retention cleanup", async () => {
    const crons = scheduledCrons();
    expect(crons.filter((cron) => cron === IDENTITY_VERSION_CRON)).toEqual([IDENTITY_VERSION_CRON]);
    expect(crons.filter((cron) => cron !== IDENTITY_VERSION_CRON)).toHaveLength(1);

    const db = createTestD1();
    seedIdentityVersions(db.sqlite);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const promises: Promise<unknown>[] = [];
    try {
      handleScheduled({
        cron: IDENTITY_VERSION_CRON,
        scheduledTime: Date.parse("2026-09-29T03:17:00.000Z"),
        noRetry() {}
      } as unknown as ScheduledController, env(db.binding), {
        waitUntil(promise) {
          promises.push(promise);
        }
      }, {
        fetch: async () => new Response("nope", { status: 503 }),
        now: () => new Date("2026-09-29T03:17:00.000Z")
      });
      await Promise.all(promises);
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("scheduled_identity_version"));
      expect(logSpy).not.toHaveBeenCalledWith(expect.stringContaining("scheduled_retention_cleanup"));
      expect(db.sqlite.prepare(
        "SELECT version FROM upstream_identity_version WHERE identity = 'grok_build'"
      ).get()).toEqual({ version: TEST_IDENTITY_VERSION });
    } finally {
      logSpy.mockRestore();
      db.close();
    }
  });
});
