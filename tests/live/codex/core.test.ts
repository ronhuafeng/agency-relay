import { expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { HOST, call, codexLanguageModel, env } from "../support";
import { assertCompletedSse, completedSseText, compactionItem } from "../oracles";

it("streams a Codex response", async () => {
  const key = env("MINI_ONLY_CODEX_SURFACE_API_KEY");
  const model = await codexLanguageModel(key);
  const response = await call(`${HOST.codex}/backend-api/codex/responses`, key, {
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

it("keeps a legacy Responses stream on the same ChatGPT operation", async () => {
  const key = env("MINI_ONLY_CODEX_SURFACE_API_KEY");
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
  const key = env("MINI_ONLY_CODEX_SURFACE_API_KEY");
  const model = await codexLanguageModel(key);
  const remembered = `fact-${randomUUID()}`;
  const response = await call(`${HOST.codex}/backend-api/codex/responses`, key, {
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
        { role: "user", content: `Remember this codeword: ${remembered}` },
        { role: "assistant", content: "OK." },
        { type: "compaction_trigger" }
      ]
    })
  }, 180_000);
  expect(response.status).toBe(200);
  expect(response.contentType.toLowerCase()).toContain("text/event-stream");
  const item = compactionItem(response.text);
  const continuation = await call(`${HOST.codex}/backend-api/codex/responses`, key, {
    method: "POST",
    headers: { Accept: "text/event-stream", "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      instructions: "Answer from the supplied context. Reply with the remembered codeword only.",
      store: false,
      stream: true,
      input: [item, { role: "user", content: "What codeword did I ask you to remember?" }]
    })
  }, 180_000);
  expect(continuation.status).toBe(200);
  expect(continuation.contentType.toLowerCase()).toContain("text/event-stream");
  // Boolean assertion avoids persisting model output or opaque history on failure.
  expect(completedSseText(continuation.text).trim() === remembered).toBe(true);
});
