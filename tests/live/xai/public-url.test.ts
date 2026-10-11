import { expect, it } from "vitest";
import { HOST, call, env, expectJson, isRecord } from "../support";

it("creates and revokes a public URL only for a temporary synthetic xAI image file", async () => {
  const apiKey = env("MINI_ONLY_XAI_SURFACE_API_KEY");
  // Minimal valid 1x1 GIF; no real user document or upstream content is exposed.
  const pixel = Buffer.from("R0lGODlhAQABAAD/ACwAAAAAAQABAAACAUwAOw==", "base64");
  const form = new FormData();
  form.append("file", new Blob([Uint8Array.from(pixel)], { type: "image/gif" }), "mini-live-probe.gif");
  form.append("purpose", "assistants");
  const uploaded = expectJson(await call(`${HOST.xai}/v1/files`, apiKey, {
    method: "POST", body: form
  }, 120_000));
  const id = isRecord(uploaded) && typeof uploaded.id === "string" ? uploaded.id : "";
  expect(id).toMatch(/^file_[A-Za-z0-9_-]{1,200}$/);
  let urlActive = false;
  try {
    const issued = expectJson(await call(`${HOST.xai}/v1/files/${encodeURIComponent(id)}/public-url`, apiKey, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ expires_after: 3600 })
    }));
    expect(issued).toMatchObject({ public_url: expect.any(String) });
    urlActive = true;
    const publicUrl = new URL((issued as { public_url: string }).public_url);
    expect(publicUrl.protocol).toBe("https:");
    // Revoke promptly; do not print or retain the secret-bearing public URL.
    const revoked = expectJson(await call(`${HOST.xai}/v1/files/${encodeURIComponent(id)}/public-url/revoke`, apiKey, {
      method: "POST"
    }));
    expect(revoked).toMatchObject({ revoked: true });
    urlActive = false;
  } finally {
    if (urlActive) {
      const revoked = await call(`${HOST.xai}/v1/files/${encodeURIComponent(id)}/public-url/revoke`, apiKey, { method: "POST" });
      expect(revoked.status).toBe(200);
    }
    const deleted = await call(`${HOST.xai}/v1/files/${encodeURIComponent(id)}`, apiKey, { method: "DELETE" });
    expect([200, 204]).toContain(deleted.status);
  }
}, 360_000);
