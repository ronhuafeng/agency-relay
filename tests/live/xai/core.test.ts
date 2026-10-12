import { randomBytes } from "node:crypto";
import { expect, it } from "vitest";
import { HOST, assertJsonShape, call, catalogModel, env, expectJson, isRecord, parseJson } from "../support";
import { languageModel, requireEnv, send } from "../runtime";
import { assertResponseHasText, assertTokenization, assertTranscript, compactOutput, responseText } from "../oracles";

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
  assertJsonShape(parseJson(response.text), { status: "completed" });
  assertResponseHasText(parseJson(response.text));
  const denied = await send(`${HOST.xai}/v1/models`, control);
  expect(denied.status).toBe(403);
  assertJsonShape(parseJson(denied.text), { error: { code: "scope_denied" } });
  const missing = await send(`${HOST.xai}/v1/not-a-mini-plan`, key);
  expect(missing.status).toBe(404);
  assertJsonShape(parseJson(missing.text), { error: { code: "not_found" } });
}, 600_000);

it("uses a real xAI key for Chat Completions and Responses compact", async () => {
  const key = env("MINI_ONLY_XAI_SURFACE_API_KEY");
  const model = await catalogModel(HOST.xai, key, "/v1/language-models", /voice|imagine|embedding/i);
  const chat = expectJson(await call(`${HOST.xai}/v1/chat/completions`, key, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, messages: [{ role: "user", content: "Reply exactly OK." }], stream: false })
  }, 180_000));
  assertJsonShape(chat, { choices: expect.arrayContaining([expect.objectContaining({ message: expect.objectContaining({ content: expect.any(String) }) })]) });
  expect(isRecord(chat) && Array.isArray(chat.choices) && chat.choices.some(choice => isRecord(choice)
    && isRecord(choice.message) && typeof choice.message.content === "string" && choice.message.content.trim().length > 0)).toBe(true);
  const remembered = randomBytes(12).toString("hex");
  const compacted = expectJson(await call(`${HOST.xai}/v1/responses/compact`, key, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, input: [{ role: "user", content: `Remember this verification word: ${remembered}.` }] })
  }, 180_000));
  const output = compactOutput(compacted);
  const continuation = expectJson(await call(`${HOST.xai}/v1/responses`, key, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, store: false, stream: false, input: [...output, {
      role: "user", content: "Return only the verification word I previously asked you to remember."
    }] })
  }, 180_000));
  assertJsonShape(continuation, { status: "completed" });
  assertTranscript({ text: responseText(continuation) }, remembered);
}, 660_000);

it("tokenizes xAI text with a real key", async () => {
  const key = env("MINI_ONLY_XAI_SURFACE_API_KEY");
  const model = await catalogModel(HOST.xai, key, "/v1/language-models", /voice|imagine|embedding/i);
  assertTokenization(expectJson(await call(`${HOST.xai}/v1/tokenize-text`, key, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model, text: "OK" })
  })), "OK");
});
