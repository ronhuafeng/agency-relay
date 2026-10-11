import { it } from "vitest";
import { HOST, assertImage, bytesToBase64, call, catalogModel, env, generatedImage, imageType } from "../support";

const NONE = /$^/;
it("generates and edits one Grok image", async () => {
  const key = env("MINI_GROK_API_KEY");
  const model = await catalogModel(HOST.grok, key, "/v1/image-generation-models", NONE);
  const created = await generatedImage(await call(`${HOST.grok}/v1/images/generations`, key, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, prompt: "A red circle on a white background.", response_format: "b64_json", n: 1 })
  }, 180_000));
  const edited = await generatedImage(await call(`${HOST.grok}/v1/images/edits`, key, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      prompt: "Add a thin blue border.",
      response_format: "b64_json",
      n: 1,
      image: { url: `data:${imageType(created)};base64,${bytesToBase64(created)}` }
    })
  }, 180_000));
  assertImage(edited);
});
