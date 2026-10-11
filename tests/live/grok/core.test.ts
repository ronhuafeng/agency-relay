import { expect, it } from "vitest";
import { HOST, call, catalogModel, env, expectJson, grokGatewayModel, parseJson } from "../support";
import { assertCompletedSse, assertResponseHasText } from "../oracles";
import { expectTerminal, requireEnv, send } from "../runtime";

it("completes one Grok production response", async () => {
  const key = requireEnv("MINI_GROK_API_KEY");
  const model = grokGatewayModel(expectJson(await call(`${HOST.grok}/v1/models`, key)));
  const response = await send(`${HOST.grok}/v1/responses`, key, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, input: "Reply exactly OK.", stream: false })
  }, 180_000);
  expectTerminal(response);
  assertResponseHasText(parseJson(response.text));
}, 180_000);

it("uses a real Grok key for Chat Completions", async () => {
  const key = env("MINI_GROK_API_KEY");
  const model = await catalogModel(HOST.grok, key, "/v1/language-models", /voice|imagine|embedding/i);
  const body = expectJson(await call(`${HOST.grok}/v1/chat/completions`, key, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, messages: [{ role: "user", content: "Reply exactly OK." }], stream: false })
  }, 180_000));
  expect(body).toMatchObject({ choices: expect.arrayContaining([expect.objectContaining({ message: expect.objectContaining({ content: expect.any(String) }) })]) });
}, 180_000);

it("tokenizes Grok text with a real key", async () => {
  const key = env("MINI_GROK_API_KEY");
  const model = await catalogModel(HOST.grok, key, "/v1/language-models", /voice|imagine|embedding/i);
  expectJson(await call(`${HOST.grok}/v1/tokenize-text`, key, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model, text: "OK" })
  }));
});

it("streams a completed Grok response through the real CLI gateway", async () => {
  const key = env("MINI_GROK_API_KEY");
  const model = grokGatewayModel(expectJson(await call(`${HOST.grok}/v1/models`, key)));
  const response = await call(`${HOST.grok}/v1/responses`, key, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
    body: JSON.stringify({ model, input: "Reply exactly OK.", stream: true })
  }, 180_000);
  expect(response.status).toBe(200);
  expect(response.contentType.toLowerCase()).toContain("text/event-stream");
  assertCompletedSse(response.text);
}, 180_000);
