import { expect, it } from "vitest";
import { HOST, call, codexLanguageModel, env, expectErrorCode, parseJson, upgrade } from "../support";

it("rejects a Codex websocket upgrade on Responses", async () => {
  const response = await upgrade(`${HOST.codex}/v1/responses`, env("MINI_CODEX_API_KEY"), {}, 60_000);
  expect(response.status).toBe(426);
  expect(response.contentType.toLowerCase()).toContain("application/json");
  expectErrorCode(parseJson(response.text), "responses_websocket_not_supported");
});

it("rejects a Codex response with an unknown stream option", async () => {
  const model = await codexLanguageModel(env("MINI_CODEX_API_KEY"));
  const response = await call(`${HOST.codex}/v1/responses`, env("MINI_CODEX_API_KEY"), {
    method: "POST",
    headers: {
      Accept: "text/event-stream",
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model,
      instructions: "Reply concisely.",
      input: [{ role: "user", content: [{ type: "input_text", text: "ignored" }] }],
      store: false,
      stream_options: { reasoning_summary_delivery: "sequential_cutoff", extra: true }
    })
  });
  expect(response.status).toBe(400);
});

it("rejects malformed Codex response JSON", async () => {
  const response = await call(`${HOST.codex}/v1/responses`, env("MINI_CODEX_API_KEY"), {
    method: "POST",
    headers: {
      Accept: "text/event-stream",
      "Content-Type": "application/json"
    },
    body: Uint8Array.from([0xff])
  });
  expect(response.status).toBe(400);
});
