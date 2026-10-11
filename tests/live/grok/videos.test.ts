import { expect, it } from "vitest";
import { admin, isRecord, newestModel, parseJson, requireEnv, send, sleep } from "../runtime";
import { verifyVideoTransformations } from "../support";

const HOST = "https://grok.trustedtunnel.app";

it("generates, edits, extends, and downloads Grok video with owner isolation", async () => {
  const key = requireEnv("MINI_ONLY_GROK_SURFACE_API_KEY");
  const catalog = await send(`${HOST}/v1/video-generation-models`, key);
  expect(catalog.status).toBe(200);
  const model = newestModel(parseJson(catalog.text), /$^/);
  const started = await send(`${HOST}/v1/videos/generations`, key, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, prompt: "A red circle on a white background." })
  }, 180_000);
  expect(started.status).toBe(200);
  const startedBody = parseJson(started.text);
  expect(startedBody).toMatchObject({ request_id: expect.stringMatching(/^[A-Za-z0-9_-]{1,200}$/) });
  const jobId = (startedBody as { request_id: string }).request_id;
  await expectOtherUserRejected(jobId);
  const completed = await poll(key, jobId);
  await download(completed);
  if (!isRecord(completed) || !isRecord(completed.video) || typeof completed.video.url !== "string") {
    throw new Error("source video reference missing");
  }
  await verifyVideoTransformations(HOST, key, completed.video.url);
}, 5_700_000);

async function expectOtherUserRejected(jobId: string): Promise<void> {
  const accounts = await admin("GET", "/admin/subscriptions");
  expect(accounts.status).toBe(200);
  expect(accounts.json).toEqual(expect.objectContaining({ accounts: expect.any(Array) }));
  const account = isRecord(accounts.json) && Array.isArray(accounts.json.accounts)
    ? accounts.json.accounts.filter(isRecord).find((row) => row.capability_source === "grok" && row.environment === "production" && row.status === "active")
    : undefined;
  expect(account).toEqual(expect.objectContaining({ id: expect.any(String) }));
  const accountId = (account as { id: string }).id;
  const created = await admin("POST", "/admin/users", {});
  expect(created.status).toBe(201);
  expect(created.json).toMatchObject({ user: { id: expect.any(String) } });
  const userId = ((created.json as { user: { id: string } }).user).id;
  let keyId = "";
  try {
    const credited = await admin("PUT", `/admin/users/${userId}/credits/grok`, { monthly_allowance: 1 });
    expect(credited.status).toBe(200);
    const issued = await admin("POST", `/admin/users/${userId}/keys`, {
      name: "Live key",
      scopes: ["surface:grok:production"],
      credential_bindings: [{ surface_grant: "surface:grok:production", credential_account_id: accountId }]
    });
    expect(issued.status).toBe(201);
    expect(issued.json).toMatchObject({ key: { id: expect.any(String) }, api_key: expect.any(String) });
    const issuedBody = issued.json as { key: { id: string }; api_key: string };
    keyId = issuedBody.key.id;
    const denied = await send(`${HOST}/v1/videos/${jobId}`, issuedBody.api_key);
    expect(denied.status).toBe(404);
    expect(parseJson(denied.text)).toMatchObject({ error: { code: "video_job_not_found" } });
  } finally {
    if (keyId) {
      await admin("DELETE", `/admin/keys/${keyId}`);
    }
    await admin("DELETE", `/admin/users/${userId}/credits/grok`);
  }
}

async function poll(key: string, jobId: string): Promise<unknown> {
  const deadline = Date.now() + 1_800_000;
  while (Date.now() < deadline) {
    const response = await send(`${HOST}/v1/videos/${jobId}`, key);
    expect(response.status).toBeGreaterThanOrEqual(200);
    expect(response.status).toBeLessThan(300);
    const body = parseJson(response.text);
    const state = isRecord(body) && typeof body.status === "string" ? body.status : response.status === 202 ? "pending" : "";
    if (state === "done") {
      return body;
    }
    expect(["pending", "queued", "processing", "in_progress"]).toContain(state);
    await sleep(15_000);
  }
  expect.fail("terminal not reached");
}

async function download(body: unknown): Promise<void> {
  expect(body).toMatchObject({ video: { url: expect.any(String) } });
  const url = new URL((body as { video: { url: string } }).video.url);
  expect(url.protocol).toBe("https:");
  expect(url.hostname === "trustedtunnel.app" || url.hostname.endsWith(".trustedtunnel.app")).toBe(false);
  const response = await fetch(url, { signal: AbortSignal.timeout(180_000) });
  expect(response.ok).toBe(true);
  const bytes = Buffer.from(await response.arrayBuffer());
  expect(response.headers.get("content-type") ?? "").toMatch(/^video\/mp4/);
  expect(bytes.length).toBeGreaterThanOrEqual(32);
  expect(bytes.subarray(4, 8).toString("ascii")).toBe("ftyp");
}
