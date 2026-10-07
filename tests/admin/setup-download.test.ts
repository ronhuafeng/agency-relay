import { describe, expect, it } from "vitest";
import { adminDashboardResponse } from "../../src/admin/dashboard";

import { buildClientSetupFiles } from "../../src/admin/client-setup";
import { createTestD1 } from "../support/sqlite-d1";

describe("one-time setup downloads", () => {
  it.each([
    ["surface:codex:production"],
    ["surface:grok:production"],
    ["surface:xai:production"],
    ["surface:codex:production", "surface:grok:production", "surface:xai:production"]
  ].map(scopes => [scopes]))("delivers every byte of the granted client files for %j", async scopes => {
    const db = createTestD1();
    try {
      const token = "cfwd_" + "synthetic_only_".repeat(8);
      const response = await adminDashboardResponse({
        env: { DB: db.binding, ADMIN_DASHBOARD_HOST: "admin.example.test" } as Env,
        url: new URL("https://admin.example.test/admin?view=setup"),
        identity: { kind: "console", email: "operator@example.test", subject: "test" },
        now: new Date("2026-09-12T09:00:00Z"), requestId: "download-integrity",
        loadCodexAccount: async () => { throw new Error("No provider read expected"); },
        mutationFlash: { kind: "key_created", token, key_id: "new-key", key_prefix: "cfwd_test", user_id: "Alex", scopes }
      });
      const html = await response.text();
      const downloads = [...html.matchAll(/href="(data:text\/plain[^\"]+)" download="([^\"]+)"/g)];
      const files = buildClientSetupFiles({ token, scopes });
      expect(downloads).toHaveLength(scopes.length);
      expect(downloads.map(match => match[2]).sort()).toEqual(files.map(file => file.filename).sort());
      for (const file of files) {
        const attribute = downloads.find(match => match[2] === file.filename)?.[1];
        if (!attribute) throw new Error(`Missing download ${file.filename}`);
        const entities: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', "#039": "'", "#39": "'", "#x27": "'" };
        const url = attribute.replace(/&(amp|lt|gt|quot|#039|#39|#x27);/g, (_match, entity: string) => { const decoded = entities[entity]; if (decoded === undefined) throw new Error("Unknown entity"); return decoded; });
        expect(url.length).toBeGreaterThan(256);
        const content = decodeURIComponent(url.slice("data:text/plain;charset=utf-8,".length));
        expect(Buffer.from(content)).toEqual(Buffer.from(file.content));
        expect(content).toContain(token);
      }
    } finally { db.close(); }
  });
});
