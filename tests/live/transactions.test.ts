import { expect, it } from "vitest";
import {
  HOST,
  assertImage,
  bytesToBase64,
  bytesEqual,
  imageType,
  assertVideo,
  call,
  catalogModel,
  env,
  expectJson,
  generatedImage,
  isRecord,
  pollVideo
} from "./support";

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

it("generates and edits one xAI image", async () => {
  const key = env("MINI_XAI_API_KEY");
  const model = await catalogModel(HOST.xai, key, "/v1/image-generation-models", NONE);
  const created = await generatedImage(await call(`${HOST.xai}/v1/images/generations`, key, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, prompt: "A red circle on a white background.", response_format: "b64_json", n: 1 })
  }, 180_000));
  assertImage(await generatedImage(await call(`${HOST.xai}/v1/images/edits`, key, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      prompt: "Add a thin blue border.",
      response_format: "b64_json",
      n: 1,
      image: { url: `data:${imageType(created)};base64,${bytesToBase64(created)}` }
    })
  }, 180_000)));
});

it.each([
  ["Grok", HOST.grok, "MINI_GROK_API_KEY"],
  ["xAI", HOST.xai, "MINI_XAI_API_KEY"]
])("round-trips one %s file", async (_name, origin, keyName) => {
  const key = env(keyName);
  const sample = Buffer.from("mini-live-file\n");
  const form = new FormData();
  form.append("file", new Blob([Uint8Array.from(sample)], { type: "text/plain" }), "mini-live.txt");
  const uploaded = expectJson(await call(`${origin}/v1/files`, key, { method: "POST", body: form }, 120_000));
  const fileId = isRecord(uploaded) && typeof uploaded.id === "string" ? uploaded.id : "";
  expect(fileId).toMatch(/^file_[A-Za-z0-9_-]{1,200}$/);
  expectJson(await call(`${origin}/v1/files/${fileId}`, key));
  const content = await call(`${origin}/v1/files/${fileId}/content`, key);
  expect(content.status).toBe(200);
  expect(bytesEqual(content.bytes, sample)).toBe(true);
  expect((await call(`${origin}/v1/files/${fileId}`, key, { method: "DELETE" })).status).toBe(200);
});

it("downloads one completed xAI video", async () => {
  const key = env("MINI_XAI_API_KEY");
  const model = await catalogModel(HOST.xai, key, "/v1/video-generation-models", NONE);
  const started = expectJson(await call(`${HOST.xai}/v1/videos/generations`, key, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, prompt: "A red circle on a white background." })
  }, 180_000));
  const jobId = isRecord(started) && typeof started.request_id === "string" ? started.request_id : "";
  expect(jobId).toMatch(/^[A-Za-z0-9_-]{1,200}$/);
  const finished = await pollVideo(HOST.xai, key, jobId);
  if (!isRecord(finished) || !isRecord(finished.video) || typeof finished.video.url !== "string") {
    throw new Error("media reference rejected");
  }
  const url = new URL(finished.video.url);
  expect(url.protocol).toBe("https:");
  const media = await fetch(url, { signal: AbortSignal.timeout(180_000) });
  expect(media.ok).toBe(true);
  expect(media.headers.get("content-type") ?? "").toMatch(/^video\/mp4/i);
  assertVideo(Buffer.from(await media.arrayBuffer()));
}, 1_860_000);
