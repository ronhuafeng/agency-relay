import { expect, it } from "vitest";
import { HOST, call, codexLanguageModel, env } from "../support";

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
});

it("accepts a unary Codex response or a controlled 400", async () => {
  const key = env("MINI_CODEX_API_KEY");
  const model = await codexLanguageModel(key);
  const response = await call(`${HOST.codex}/v1/responses`, key, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      instructions: "Reply concisely.",
      input: [{ role: "user", content: [{ type: "input_text", text: "Reply exactly OK." }] }],
      store: false,
      stream: false
    })
  }, 180_000);
  expect([200, 400]).toContain(response.status);
  if (response.status === 200) {
    expect(response.contentType.toLowerCase()).toContain("application/json");
  }
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
