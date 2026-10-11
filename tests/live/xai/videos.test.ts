import { expect, it } from "vitest";
import { HOST, assertVideo, call, catalogModel, env, expectJson, isRecord, pollVideo } from "../support";

const NONE = /$^/;
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
