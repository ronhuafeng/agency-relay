import { expect, it } from "vitest";
import { withCreditCleanup } from "../live/credit-cleanup";

it("attempts every owned cleanup and preserves the primary failure when revocation fails", async () => {
  const actions: string[] = [];
  const primary = new Error("primary assertion failed");
  let caught: unknown;
  try {
    await withCreditCleanup("owned-user", [
      { id: "first", token: "synthetic-first" },
      { id: "second", token: "synthetic-second" }
    ], async () => { throw primary; }, {
      admin: async (method, path) => {
        actions.push(`${method} ${path}`);
        if (path === "/admin/keys/first") throw new Error("private transport value");
        return { status: 200, json: { states: [
          { surface_grant: "surface:codex:production", source: "organization" },
          { surface_grant: "surface:grok:production", source: "unconfigured" }
        ] } };
      },
      send: async () => ({ status: 401, contentType: "application/json", text: '{"error":{"code":"invalid_api_key"}}' })
    });
  } catch (error) {
    caught = error;
  }
  expect(actions).toContain("DELETE /admin/keys/second");
  expect(actions).toContain("DELETE /admin/users/owned-user/credits/codex");
  expect(actions).toContain("DELETE /admin/users/owned-user/credits/grok");
  expect(caught).toBeInstanceOf(AggregateError);
  expect((caught as AggregateError).errors).toContain(primary);
  expect(String(caught)).not.toContain("private transport value");
  expect((caught as AggregateError).errors.map(String).join("\n")).not.toContain("private transport value");
});

it("accepts verified revocation and inherited policy sources without removing retained usage", async () => {
  const keys: Array<{ id: string; token: string }> = [];
  const deleted: string[] = [];
  let readback = false;
  await withCreditCleanup("owned-user", keys, async () => {
    keys.push({ id: "created-during-task", token: "synthetic-token" });
  }, {
    admin: async (method, path) => {
      if (method === "DELETE") deleted.push(path);
      if (method === "GET") readback = true;
      return { status: 200, json: { states: [
        { surface_grant: "surface:codex:production", source: "organization", consumed_credits: 1 },
        { surface_grant: "surface:grok:production", source: "unconfigured", consumed_credits: 1 }
      ] } };
    },
    send: async (url, token, init) => {
      expect(url).toBe("https://api.trustedtunnel.app/backend-api/codex/responses");
      expect(token).toBe("synthetic-token");
      expect(init?.method ?? "GET").toBe("GET");
      return { status: 401, contentType: "application/json", text: '{"error":{"code":"invalid_api_key"}}' };
    }
  });
  expect(deleted).toEqual([
    "/admin/keys/created-during-task",
    "/admin/users/owned-user/credits/codex",
    "/admin/users/owned-user/credits/grok"
  ]);
  expect(readback).toBe(true);
});

it("rejects successful mutation responses when key or credit readback does not confirm cleanup", async () => {
  let caught: unknown;
  try {
    await withCreditCleanup("owned-user", [{ id: "owned-key", token: "synthetic-token" }], async () => {}, {
      admin: async () => ({ status: 200, json: { states: [
        { surface_grant: "surface:codex:production", source: "organization" },
        { surface_grant: "surface:grok:production", source: "personal" }
      ] } }),
      send: async () => ({ status: 405, contentType: "application/json", text: '{"error":{"code":"method_not_allowed"}}' })
    });
  } catch (error) { caught = error; }
  expect(caught).toBeInstanceOf(AggregateError);
  expect((caught as AggregateError).errors.map((error: Error) => error.message)).toEqual([
    "owned credit key revocation readback failed",
    "owned credit policy readback failed"
  ]);
});

it("continues after a credit removal failure and reports missing policy readback safely", async () => {
  const deletes: string[] = [];
  let caught: unknown;
  try {
    await withCreditCleanup("owned-user", [], async () => {}, {
      admin: async (method, path) => {
        if (method === "DELETE") deletes.push(path);
        if (path.endsWith("/codex")) throw new Error("private upstream body");
        return { status: 200, json: { states: [] } };
      },
      send: async () => { throw new Error("no owned key expected"); }
    });
  } catch (error) { caught = error; }
  expect(deletes).toContain("/admin/users/owned-user/credits/grok");
  expect(caught).toBeInstanceOf(AggregateError);
  expect((caught as AggregateError).errors.map((error: Error) => error.message)).toEqual([
    "owned codex credit policy removal failed",
    "owned credit policy readback failed"
  ]);
});
