import { describe, expect, it } from "vitest";
import { createTestD1 } from "../support/sqlite-d1";

describe("SQLite D1 test Adapter", () => {
  it("applies the production schema and executes bound D1 statements", async () => {
    const testDb = createTestD1();
    try {
      await testDb.binding.prepare(
        `INSERT INTO users (id, email, status, created_at, updated_at)
         VALUES (?, ?, 'active', ?, ?)`
      ).bind("user_test", "test@example.test", "2026-08-10T00:00:00.000Z", "2026-08-10T00:00:00.000Z").run();

      await expect(testDb.binding.prepare("SELECT id, status FROM users WHERE id = ?")
        .bind("user_test").first()).resolves.toEqual({ id: "user_test", status: "active" });
    } finally {
      testDb.close();
    }
  });

  it("rolls back the complete D1 batch when one statement fails", async () => {
    const testDb = createTestD1();
    try {
      const first = testDb.binding.prepare(
        `INSERT INTO users (id, email, status, created_at, updated_at)
         VALUES (?, ?, 'active', ?, ?)`
      ).bind("duplicate", "one@example.test", "2026-08-10T00:00:00.000Z", "2026-08-10T00:00:00.000Z");
      const second = testDb.binding.prepare(
        `INSERT INTO users (id, email, status, created_at, updated_at)
         VALUES (?, ?, 'active', ?, ?)`
      ).bind("duplicate", "two@example.test", "2026-08-10T00:00:00.000Z", "2026-08-10T00:00:00.000Z");

      await expect(testDb.binding.batch([first, second])).rejects.toThrow();
      expect(testDb.sqlite.prepare("SELECT count(*) AS count FROM users").get()).toEqual({ count: 0 });
    } finally {
      testDb.close();
    }
  });
});
