import { expect, it } from "vitest";
import { HOST, assertJsonShape, call, catalogModel, env, expectJson, isRecord } from "../support";
import { assertResponseHasText } from "../oracles";
import { withCleanup } from "../runtime";

/** These are real shared-team xAI API operations, not a Grok owner-isolated surface. */
it("retrieves and deletes a stored xAI response produced by the real Provider", async () => {
  const apiKey = env("MINI_ONLY_XAI_SURFACE_API_KEY");
  const model = await catalogModel(HOST.xai, apiKey, "/v1/language-models", /voice|imagine|embedding/i);
  const created = expectJson(await call(`${HOST.xai}/v1/responses`, apiKey, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, input: "Reply exactly OK.", store: true, stream: false })
  }, 180_000));
  const id = isRecord(created) && typeof created.id === "string" ? created.id : "";
  expect(/^(?:resp_[A-Za-z0-9_-]+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.test(id)).toBe(true);
  await withCleanup(async () => {
    assertJsonShape(created, { status: "completed", id: expect.any(String) });
    assertResponseHasText(created);
    const found = expectJson(await call(`${HOST.xai}/v1/responses/${encodeURIComponent(id)}`, apiKey));
    assertJsonShape(found, { id, status: "completed" });
  }, [{ message: "owned stored response deletion failed", run: async () => {
    const removed = await call(`${HOST.xai}/v1/responses/${encodeURIComponent(id)}`, apiKey, { method: "DELETE" });
    expect([200, 204]).toContain(removed.status);
    const missing = await call(`${HOST.xai}/v1/responses/${encodeURIComponent(id)}`, apiKey);
    expect(missing.status).toBe(404);
  } }]);
}, 360_000);

it("lists live xAI batches and shared files using the delegated xAI key", async () => {
  const apiKey = env("MINI_ONLY_XAI_SURFACE_API_KEY");
  for (const path of ["/v1/batches", "/v1/files"]) {
    const response = expectJson(await call(`${HOST.xai}${path}`, apiKey));
    expect(isRecord(response)).toBe(true);
  }
}, 180_000);
