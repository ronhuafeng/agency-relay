import { expect, it } from "vitest";
import { HOST, call, catalogModel, env, expectJson } from "../support";
import { expectTerminal, languageModel, requireEnv, send } from "../runtime";

it("completes one Grok production response", async () => {
  const key = requireEnv("MINI_GROK_API_KEY");
  const model = await languageModel("https://grok.trustedtunnel.app", key);
  expectTerminal(await send("https://grok.trustedtunnel.app/v1/responses", key, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, input: "Reply exactly OK.", stream: false })
  }, 180_000));
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
