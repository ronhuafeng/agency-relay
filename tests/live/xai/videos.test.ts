import { expect, it } from "vitest";
import { HOST, assertVideo, call, catalogModel, env, expectJson, isRecord, pollVideo, verifyVideoTransformations } from "../support";
import { fetchLive, providerUrl } from "../runtime";

const NONE = /$^/;
it("generates, edits, extends, and downloads xAI video", async () => {
  const key = env("MINI_ONLY_XAI_SURFACE_API_KEY");
  const model = await catalogModel(HOST.xai, key, "/v1/video-generation-models", NONE);
  const started = expectJson(await call(`${HOST.xai}/v1/videos/generations`, key, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, prompt: "A red circle on a white background." })
  }, 180_000));
  const jobId = isRecord(started) && typeof started.request_id === "string" ? started.request_id : "";
  expect(/^[A-Za-z0-9_-]{1,200}$/.test(jobId)).toBe(true);
  const finished = await pollVideo(HOST.xai, key, jobId);
  if (!isRecord(finished) || !isRecord(finished.video) || typeof finished.video.url !== "string") {
    throw new Error("media reference rejected");
  }
  const url = providerUrl(finished.video.url);
  expect(url.protocol).toBe("https:");
  const media = await fetchLive(url, { signal: AbortSignal.timeout(180_000) });
  expect(media.ok).toBe(true);
  expect(media.headers.get("content-type") ?? "").toMatch(/^video\/mp4/i);
  assertVideo(Buffer.from(await media.arrayBuffer()));
  await verifyVideoTransformations(HOST.xai, key, url.href);
}, 5_700_000);
