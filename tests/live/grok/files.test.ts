import { expect, it } from "vitest";
import { HOST, bytesEqual, call, env, expectJson, isRecord } from "../support";
import { withCleanup } from "../runtime";

it("round-trips one Grok file with its real user key", async () => {
  const origin = HOST.grok, apiKey = env("MINI_ONLY_GROK_SURFACE_API_KEY");
  const sample = Buffer.from("mini-live-file\\n");
  const form = new FormData();
  form.append("file", new Blob([Uint8Array.from(sample)], { type: "text/plain" }), "mini-live.txt");
  const uploaded = expectJson(await call(`${origin}/v1/files`, apiKey, { method: "POST", body: form }, 120_000));
  const fileId = isRecord(uploaded) && typeof uploaded.id === "string" ? uploaded.id : "";
  expect(/^file_[A-Za-z0-9_-]{1,200}$/.test(fileId)).toBe(true);
  await withCleanup(async () => {
    expectJson(await call(`${origin}/v1/files/${fileId}`, apiKey));
    const content = await call(`${origin}/v1/files/${fileId}/content`, apiKey);
    expect(content.status).toBe(200);
    expect(bytesEqual(content.bytes, sample)).toBe(true);
  }, [{ message: "owned Grok file deletion failed", run: async () => {
    const removed = await call(`${origin}/v1/files/${fileId}`, apiKey, { method: "DELETE" });
    expect(removed.status).toBe(200);
    expect((await call(`${origin}/v1/files/${fileId}`, apiKey)).status).toBe(404);
  } }]);
}, 300_000);
