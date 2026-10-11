import { expect, it } from "vitest";
import { HOST, call, catalogModel, env, expectJson, isRecord } from "../support";
import { assertResponseHasText } from "../oracles";

/** These are real shared-team xAI API operations, not a Grok owner-isolated surface. */
it("retrieves and deletes a stored xAI response produced by the real Provider", async () => {
  const apiKey = env("MINI_XAI_API_KEY");
  const model = await catalogModel(HOST.xai, apiKey, "/v1/language-models", /voice|imagine|embedding/i);
  const created = expectJson(await call(`${HOST.xai}/v1/responses`, apiKey, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, input: "Reply exactly OK.", store: true, stream: false })
  }, 180_000));
  expect(created).toMatchObject({ status: "completed", id: expect.any(String) });
  assertResponseHasText(created);
  const id = isRecord(created) && typeof created.id === "string" ? created.id : "";
  expect(id).toMatch(/^resp_[A-Za-z0-9_-]+$/);
  try {
    const found = expectJson(await call(`${HOST.xai}/v1/responses/${encodeURIComponent(id)}`, apiKey));
    expect(found).toMatchObject({ id, status: "completed" });
  } finally {
    const removed = await call(`${HOST.xai}/v1/responses/${encodeURIComponent(id)}`, apiKey, { method: "DELETE" });
    expect([200, 204]).toContain(removed.status);
  }
}, 360_000);

it("lists live xAI batches and shared files using the delegated xAI key", async () => {
  const apiKey = env("MINI_XAI_API_KEY");
  for (const path of ["/v1/batches", "/v1/files"]) {
    const response = expectJson(await call(`${HOST.xai}${path}`, apiKey));
    expect(isRecord(response)).toBe(true);
  }
}, 180_000);
