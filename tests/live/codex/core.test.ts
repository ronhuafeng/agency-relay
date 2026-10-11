import { expect, it } from "vitest";
import { HOST, call, codexLanguageModel, env, expectJson } from "../support";
import { assertCompletedSse } from "../oracles";

it("streams a Codex response", async () => {
  const key = env("MINI_CODEX_API_KEY");
  const model = await codexLanguageModel(key);
  const response = await call(`${HOST.codex}/v1/responses`, key, {
    method: "POST",
    headers: {
      Accept: "text/event-stream",
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model,
      instructions: "Reply concisely.",
      input: [{ role: "user", content: [{ type: "input_text", text: "Reply exactly OK." }] }],
      store: false,
      stream: true
    })
  }, 180_000);
  expect(response.status).toBe(200);
  expect(response.contentType.toLowerCase()).toContain("text/event-stream");
  assertCompletedSse(response.text);
});

it("compacts a Codex response", async () => {
  const key = env("MINI_CODEX_API_KEY");
  const model = await codexLanguageModel(key);
  const response = await call(`${HOST.codex}/v1/responses`, key, {
    method: "POST",
    headers: {
      Accept: "text/event-stream",
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model,
      store: false,
      stream: true,
      input: [
        { role: "user", content: "Remember the word amber." },
        { role: "assistant", content: "OK." },
        { type: "compaction_trigger" }
      ]
    })
  }, 180_000);
  expect(response.status).toBe(200);
  expect(response.contentType.toLowerCase()).toContain("text/event-stream");
  expect(response.text).toContain("event: response.compaction.compacting");
  expect(response.text).toContain("event: response.completed");
});

it("compacts context through the dedicated /v1/responses/compact endpoint", async () => {
  const key = env("MINI_CODEX_API_KEY");
  const model = await codexLanguageModel(key);
  const body = expectJson(await call(`${HOST.codex}/v1/responses/compact`, key, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      input: [{ role: "user", content: "Remember amber." }, { role: "assistant", content: "Amber remembered." }]
    })
  }, 180_000));
  expect(body).toMatchObject({
    object: "response.compaction",
    output: expect.arrayContaining([expect.objectContaining({ type: "compaction", encrypted_content: expect.any(String) })])
  });
}, 180_000);
