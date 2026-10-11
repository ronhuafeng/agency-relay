import { it } from "vitest";
import { codexLanguageModel, env } from "../support";

it("lists Codex models with an etag and a priced language model", async () => {
  await codexLanguageModel(env("MINI_ONLY_CODEX_SURFACE_API_KEY"));
});
