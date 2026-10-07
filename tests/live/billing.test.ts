import { expect, it } from "vitest";
import { admin, expectTerminal, isRecord, languageModel, newestModel, parseJson, requireEnv, send, sleep } from "./runtime";

it("records provider-reported provisional billing", async () => {
  const codexKey = requireEnv("MINI_CODEX_API_KEY");
  const grokKey = requireEnv("MINI_GROK_API_KEY");
  const codex = await send("https://api.trustedtunnel.app/v1/responses", codexKey, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: await codexModelId(codexKey), input: "Reply exactly OK.", stream: false })
  }, 180_000);
  expectTerminal(codex);
  const codexBody = parseJson(codex.text);
  if (isRecord(codexBody) && isRecord(codexBody.usage)) {
    expect(codexBody.usage.cost_in_usd_ticks).not.toEqual(expect.any(Number));
  }
  const grokModel = await languageModel("https://grok.trustedtunnel.app", grokKey);
  expectTerminal(await send("https://grok.trustedtunnel.app/v1/responses", grokKey, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: grokModel, input: "Reply exactly OK.", stream: false })
  }, 180_000));
  await image(grokKey);
  await video(grokKey);
  const failed = await send("https://grok.trustedtunnel.app/v1/responses", grokKey, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "not-a-provider-model", input: "Reply exactly OK.", stream: false })
  }, 60_000);
  expect(failed.status).toBeGreaterThanOrEqual(400);
  const usage = await admin("GET", `/admin/usage?day=${new Date().toISOString().slice(0, 10)}&limit=1000`);
  expect(usage.status).toBe(200);
  expect(usage.json).toEqual(expect.objectContaining({
    rows: expect.any(Array),
    media_rows: expect.any(Array)
  }));
}, 1_860_000);

async function codexModelId(key: string): Promise<string> {
  const catalog = await send("https://api.trustedtunnel.app/v1/models", key);
  const body = parseJson(catalog.text);
  expect(catalog.status).toBe(200);
  expect(body).toEqual(expect.objectContaining({ models: expect.any(Array) }));
  const slug = isRecord(body) && Array.isArray(body.models)
    ? body.models.filter(isRecord).map((model) => model.slug).find((id) => typeof id === "string" && !/audio|realtime|transcribe|tts|whisper|image|embedding|moderation/i.test(id))
    : undefined;
  expect(slug).toEqual(expect.any(String));
  return slug as string;
}

async function image(key: string): Promise<void> {
  const catalog = await send("https://grok.trustedtunnel.app/v1/image-generation-models", key);
  expect(catalog.status).toBe(200);
  const model = newestModel(parseJson(catalog.text), /voice|embedding/i);
  const response = await send("https://grok.trustedtunnel.app/v1/images/generations", key, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, prompt: "A red circle on a white background.", response_format: "b64_json", n: 1 })
  }, 180_000);
  expect(response.status).toBe(200);
  const body = parseJson(response.text);
  expect(body).toMatchObject({ data: [expect.objectContaining({ b64_json: expect.any(String) })] });
  const bytes = Buffer.from((body as { data: Array<{ b64_json: string }> }).data[0]?.b64_json ?? "", "base64");
  expect(bytes.length).toBeGreaterThanOrEqual(32);
  expect(["ffd8ff", "89504e", "524946"]).toContain(bytes.subarray(0, 3).toString("hex"));
}

async function video(key: string): Promise<void> {
  const catalog = await send("https://grok.trustedtunnel.app/v1/video-generation-models", key);
  expect(catalog.status).toBe(200);
  const model = newestModel(parseJson(catalog.text), /$^/);
  const started = await send("https://grok.trustedtunnel.app/v1/videos/generations", key, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, prompt: "A red circle on a white background." })
  }, 180_000);
  expect(started.status).toBe(200);
  const body = parseJson(started.text);
  expect(body).toMatchObject({ request_id: expect.any(String) });
  const jobId = (body as { request_id: string }).request_id;
  const deadline = Date.now() + 1_800_000;
  while (Date.now() < deadline) {
    const polled = await send(`https://grok.trustedtunnel.app/v1/videos/${jobId}`, key);
    const pollBody = parseJson(polled.text);
    const state = isRecord(pollBody) && typeof pollBody.status === "string" ? pollBody.status : polled.status === 202 ? "pending" : "";
    if (state === "done") {
      return;
    }
    expect(state).toBe("pending");
    await sleep(15_000);
  }
  expect.fail("video terminal not reached");
}
