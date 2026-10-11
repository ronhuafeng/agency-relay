import { expect, it } from "vitest";
import { assertCompletedSse } from "./oracles";
import { codexLanguageModel } from "./support";
import { admin, expectTerminal, isRecord, languageModel, newestModel, parseJson, requireEnv, send, sleep } from "./runtime";

it("records attributed Responses and media usage from real provider calls", async () => {
  const before = await usageCounts();
  const codexKey = requireEnv("MINI_ONLY_CODEX_SURFACE_API_KEY");
  const grokKey = requireEnv("MINI_ONLY_GROK_SURFACE_API_KEY");
  const codex = await send("https://api.trustedtunnel.app/v1/responses", codexKey, {
    method: "POST",
    headers: { Accept: "text/event-stream", "Content-Type": "application/json" },
    body: JSON.stringify({
      model: await codexLanguageModel(codexKey),
      instructions: "Reply concisely.",
      input: [{ role: "user", content: [{ type: "input_text", text: "Reply exactly OK." }] }],
      store: false,
      stream: true
    })
  }, 180_000);
  expect(codex.status).toBe(200);
  expect(codex.contentType.toLowerCase()).toContain("text/event-stream");
  assertCompletedSse(codex.text);
  const completed = [...codex.text.split(/\r?\n\r?\n/)].reverse().map((block) => {
    const data = block.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("\n");
    return block.includes("event: response.completed") ? data : "";
  }).find((data) => data.length > 0);
  const completedBody = completed ? parseJson(completed) : null;
  const completedResponse = isRecord(completedBody) ? completedBody.response : null;
  const usage = isRecord(completedResponse) ? completedResponse.usage : null;
  if (isRecord(usage)) {
    expect(usage.cost_in_usd_ticks).not.toEqual(expect.any(Number));
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
  // Billing records are grouped by exact Execution Plan, not combined
  // across Grok and xAI or inferred from a 200 status.
  let observed = false;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const after = await usageCounts();
    observed = (
      after.codexResponses >= before.codexResponses + 1 &&
      after.grokResponses >= before.grokResponses + 1 &&
      after.grokImages >= before.grokImages + 1 &&
      after.grokVideos >= before.grokVideos + 1
    );
    if (observed) break;
    await sleep(3_000);
  }
  expect(observed).toBe(true);
}, 1_920_000);

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

interface UsageCounts {
  codexResponses: number;
  grokResponses: number;
  grokImages: number;
  grokVideos: number;
}

async function usageCounts(): Promise<UsageCounts> {
  const totals = async (plan: string, ledger: "rows" | "media_rows", field: "requests" | "started_jobs"): Promise<number> => {
    const response = await admin("GET", `/admin/usage?scope=all&route_profile_id=${encodeURIComponent(plan)}&limit=1000`);
    expect(response.status).toBe(200);
    const list = isRecord(response.json) && Array.isArray(response.json[ledger]) ? response.json[ledger] : undefined;
    expect(list).toEqual(expect.any(Array));
    return (list ?? []).filter(isRecord).reduce<number>((total, row) => {
      expect(row.route_profile_id).toBe(plan);
      const count = row[field];
      expect(typeof count).toBe("number");
      return total + (count as number);
    }, 0);
  };
  return {
    codexResponses: await totals("codex.responses", "rows", "requests"),
    grokResponses: await totals("grok.production.responses", "rows", "requests"),
    grokImages: await totals("grok.production.images_generations", "media_rows", "started_jobs"),
    grokVideos: await totals("grok.production.videos_generations", "media_rows", "started_jobs")
  };
}
