import { expect, it } from "vitest";
import { HOST, call, codexLanguageModel, env } from "../support";

it("lists Codex models with an etag and a priced language model", async () => {
  const key = env("MINI_ONLY_CODEX_SURFACE_API_KEY");
  const clientBase = await call(`${HOST.codex}/backend-api/codex/models`, key);
  const publicBase = await call(`${HOST.codex}/v1/models`, key);
  expect(clientBase.status).toBe(200);
  expect(publicBase.status).toBe(200);
  expect(clientBase.headers.get("etag")).toBeTruthy();
  expect(clientBase.text === publicBase.text).toBe(true);
  await codexLanguageModel(key);
});
