import { expect, it } from "vitest";
import { HOST, assertJsonShape, call, env, expectJson, isRecord } from "../support";
import { providerUrl, withCleanup } from "../runtime";

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
  expect(/^file_[A-Za-z0-9_-]{1,200}$/.test(id)).toBe(true);
  let urlActive = true;
  await withCleanup(async () => {
    const issued = expectJson(await call(`${HOST.xai}/v1/files/${encodeURIComponent(id)}/public-url`, apiKey, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ expires_after: 3600 })
    }));
    assertJsonShape(issued, { public_url: expect.any(String) });
    const publicUrl = providerUrl((issued as { public_url: string }).public_url);
    expect(publicUrl.protocol).toBe("https:");
    // Revoke promptly; do not print or retain the secret-bearing public URL.
    const revoked = expectJson(await call(`${HOST.xai}/v1/files/${encodeURIComponent(id)}/public-url/revoke`, apiKey, {
      method: "POST"
    }));
    assertJsonShape(revoked, { revoked: true });
    urlActive = false;
  }, [{ message: "owned public URL revocation failed", run: async () => {
    if (urlActive) {
      const revoked = await call(`${HOST.xai}/v1/files/${encodeURIComponent(id)}/public-url/revoke`, apiKey, { method: "POST" });
      expect(revoked.status).toBe(200);
      assertJsonShape(expectJson(revoked), { revoked: true });
    }
  } }, { message: "owned public file deletion failed", run: async () => {
    const deleted = await call(`${HOST.xai}/v1/files/${encodeURIComponent(id)}`, apiKey, { method: "DELETE" });
    expect([200, 204]).toContain(deleted.status);
    expect((await call(`${HOST.xai}/v1/files/${encodeURIComponent(id)}`, apiKey)).status).toBe(404);
  } }]);
}, 360_000);
