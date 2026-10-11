import { it } from "vitest";
import { HOST, call, catalogModel, env, expectJson, voiceId } from "../support";

const NONE = /$^/;

it("lists Grok models", async () => {
  expectJson(await call(`${HOST.grok}/v1/models`, env("MINI_GROK_API_KEY")));
});

it("reads one Grok language, image, video, and voice model", async () => {
  const key = env("MINI_GROK_API_KEY");
  await catalogModel(HOST.grok, key, "/v1/language-models", /voice|imagine|embedding/i);
  await catalogModel(HOST.grok, key, "/v1/image-generation-models", NONE);
  await catalogModel(HOST.grok, key, "/v1/video-generation-models", NONE);
  await voiceId(HOST.grok, key);
});
