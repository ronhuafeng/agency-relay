import { expect, it } from "vitest";
import { HOST, call, env, expectErrorCode, parseJson } from "./support";

it.each([
  ["Codex", HOST.codex, "MINI_CODEX_API_KEY"],
  ["Grok", HOST.grok, "MINI_GROK_API_KEY"],
  ["xAI", HOST.xai, "MINI_XAI_API_KEY"]
])("rejects GET %s Responses", async (_name, origin, keyName) => {
  const response = await call(`${origin}/v1/responses`, env(keyName));
  expect(response.status).toBe(405);
  expect(response.contentType.toLowerCase()).toContain("application/json");
  expectErrorCode(parseJson(response.text), "method_not_allowed");
});

it.each([
  ["Codex", HOST.codex, "MINI_CODEX_API_KEY"],
  ["Grok", HOST.grok, "MINI_GROK_API_KEY"]
])("rejects an undeclared %s path", async (_name, origin, keyName) => {
  const response = await call(`${origin}/v1/not-a-mini-plan`, env(keyName));
  expect(response.status).toBe(404);
  expect(response.contentType.toLowerCase()).toContain("application/json");
  expectErrorCode(parseJson(response.text), "not_found");
});

it.each([
  ["Grok key on Codex", HOST.codex, "MINI_GROK_CONTROL_API_KEY"],
  ["Codex key on Grok", HOST.grok, "MINI_CODEX_API_KEY"],
  ["Codex key on xAI", HOST.xai, "MINI_CODEX_API_KEY"],
  ["xAI key on Codex", HOST.codex, "MINI_XAI_API_KEY"],
  ["xAI key on Grok", HOST.grok, "MINI_XAI_API_KEY"]
])("denies %s", async (_name, origin, keyName) => {
  const response = await call(`${origin}/v1/models`, env(keyName));
  expect(response.status).toBe(403);
  expect(response.contentType.toLowerCase()).toContain("application/json");
  expectErrorCode(parseJson(response.text), "scope_denied");
});
