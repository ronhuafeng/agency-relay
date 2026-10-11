import { expect, it } from "vitest";
import { HOST, bytesEqual, call, env, expectJson, isRecord } from "../support";

it("round-trips one xai file with its real user key", async () => {
  const origin = HOST.xai, apiKey = env("MINI_ONLY_XAI_SURFACE_API_KEY");
  const sample = Buffer.from("mini-live-file\\n");
  const form = new FormData();
  form.append("file", new Blob([Uint8Array.from(sample)], { type: "text/plain" }), "mini-live.txt");
  const uploaded = expectJson(await call(`${origin}/v1/files`, apiKey, { method: "POST", body: form }, 120_000));
  const fileId = isRecord(uploaded) && typeof uploaded.id === "string" ? uploaded.id : "";
  expect(fileId).toMatch(/^file_[A-Za-z0-9_-]{1,200}$/);
  try {
    expectJson(await call(`${origin}/v1/files/${fileId}`, apiKey));
    const content = await call(`${origin}/v1/files/${fileId}/content`, apiKey);
    expect(content.status).toBe(200);
    expect(bytesEqual(content.bytes, sample)).toBe(true);
  } finally {
    const removed = await call(`${origin}/v1/files/${fileId}`, apiKey, { method: "DELETE" });
    expect(removed.status).toBe(200);
  }
}, 300_000);
