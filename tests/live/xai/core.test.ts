import { expect, it } from "vitest";
import { HOST, call, catalogModel, env, expectJson, parseJson } from "../support";
import { languageModel, requireEnv, send } from "../runtime";
import { assertResponseHasText } from "../oracles";

it("completes an xAI HTTP response and enforces surface isolation", async () => {
  const key = requireEnv("MINI_ONLY_XAI_SURFACE_API_KEY");
  const control = requireEnv("MINI_ONLY_GROK_SURFACE_API_KEY");
  const model = await languageModel(HOST.xai, key);
  const models = await send(`${HOST.xai}/v1/models`, key);
  expect(models.status).toBe(200);
  expect(models.contentType.toLowerCase()).toContain("application/json");
  const response = await send(`${HOST.xai}/v1/responses`, key, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, input: "Reply exactly OK.", stream: false })
  }, 180_000);
  expect(response.status).toBe(200);
  expect(parseJson(response.text)).toMatchObject({ status: "completed" });
  assertResponseHasText(parseJson(response.text));
  const denied = await send(`${HOST.xai}/v1/models`, control);
  expect(denied.status).toBe(403);
  expect(parseJson(denied.text)).toMatchObject({ error: { code: "scope_denied" } });
  const missing = await send(`${HOST.xai}/v1/not-a-mini-plan`, key);
  expect(missing.status).toBe(404);
  expect(parseJson(missing.text)).toMatchObject({ error: { code: "not_found" } });
}, 600_000);

it("uses a real xAI key for Chat Completions and Responses compact", async () => {
  const key = env("MINI_ONLY_XAI_SURFACE_API_KEY");
  const model = await catalogModel(HOST.xai, key, "/v1/language-models", /voice|imagine|embedding/i);
  const chat = expectJson(await call(`${HOST.xai}/v1/chat/completions`, key, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, messages: [{ role: "user", content: "Reply exactly OK." }], stream: false })
  }, 180_000));
  expect(chat).toMatchObject({ choices: expect.arrayContaining([expect.objectContaining({ message: expect.objectContaining({ content: expect.any(String) }) })]) });
  expectJson(await call(`${HOST.xai}/v1/responses/compact`, key, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, input: "Remember the word amber." })
  }, 180_000));
}, 450_000);

it("tokenizes xAI text with a real key", async () => {
  const key = env("MINI_ONLY_XAI_SURFACE_API_KEY");
  const model = await catalogModel(HOST.xai, key, "/v1/language-models", /voice|imagine|embedding/i);
  expectJson(await call(`${HOST.xai}/v1/tokenize-text`, key, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model, text: "OK" })
  }));
});
