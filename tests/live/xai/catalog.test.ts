import { it } from "vitest";
import { HOST, call, catalogModel, env, expectJson, firstDataId, voiceId } from "../support";

const NONE = /$^/;

it("reads one xAI model and its media catalogs", async () => {
  const key = env("MINI_ONLY_XAI_SURFACE_API_KEY");
  const listed = await call(`${HOST.xai}/v1/models`, key);
  const id = firstDataId(expectJson(listed));
  expectJson(await call(`${HOST.xai}/v1/models/${encodeURIComponent(id)}`, key));
  await catalogModel(HOST.xai, key, "/v1/language-models", /voice|imagine|embedding/i);
  await catalogModel(HOST.xai, key, "/v1/image-generation-models", NONE);
  await catalogModel(HOST.xai, key, "/v1/video-generation-models", NONE);
  await voiceId(HOST.xai, key);
  expectJson(await call(`${HOST.xai}/v1/custom-voices`, key));
});
