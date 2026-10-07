import { expect, it } from "vitest";
import {
  HOST,
  assertNotClosed,
  call,
  catalogModel,
  codexLanguageModel,
  env,
  expectErrorCode,
  expectJson,
  firstDataId,
  optionalUpgrade,
  parseJson,
  realtimeCallBody,
  upgrade,
  voiceId,
  wavProbe
} from "./support";

const NONE = /$^/;

it("answers health checks as JSON", async () => {
  for (const origin of [HOST.codex, HOST.grok, HOST.xai]) {
    expectJson(await call(`${origin}/healthz`, undefined));
  }
});

it("lists Codex models with an etag and a priced language model", async () => {
  await codexLanguageModel(env("MINI_CODEX_API_KEY"));
});

it("lists Grok models", async () => {
  expectJson(await call(`${HOST.grok}/v1/models`, env("MINI_GROK_API_KEY")));
});

it("reads one Grok language, image, video, and voice model", async () => {
  const key = env("MINI_GROK_API_KEY");
  await catalogModel(HOST.grok, key, "/v1/language-models", /voice|imagine|embedding/i);
  await catalogModel(HOST.grok, key, "/v1/image-generation-models", NONE);
  await catalogModel(HOST.grok, key, "/v1/video-generation-models", NONE);
  await voiceId(HOST.grok, key);
});

it("reads one xAI model and its media catalogs", async () => {
  const key = env("MINI_XAI_API_KEY");
  const listed = await call(`${HOST.xai}/v1/models`, key);
  const id = firstDataId(expectJson(listed));
  expectJson(await call(`${HOST.xai}/v1/models/${encodeURIComponent(id)}`, key));
  await catalogModel(HOST.xai, key, "/v1/language-models", /voice|imagine|embedding/i);
  await catalogModel(HOST.xai, key, "/v1/image-generation-models", NONE);
  await catalogModel(HOST.xai, key, "/v1/video-generation-models", NONE);
  await voiceId(HOST.xai, key);
  expectJson(await call(`${HOST.xai}/v1/custom-voices`, key));
});

it("rejects a Codex websocket upgrade on Responses", async () => {
  const response = await upgrade(`${HOST.codex}/v1/responses`, env("MINI_CODEX_API_KEY"), {}, 60_000);
  expect(response.status).toBe(426);
  expect(response.contentType.toLowerCase()).toContain("application/json");
  expectErrorCode(parseJson(response.text), "responses_websocket_not_supported");
});

it.each([
  ["Codex", HOST.codex, "MINI_CODEX_API_KEY"],
  ["Grok", HOST.grok, "MINI_GROK_API_KEY"],
  ["xAI", HOST.xai, "MINI_XAI_API_KEY"]
])("rejects GET %s Responses", async (_name, origin, keyName) => {
  const response = await call(`${origin}/v1/responses`, env(keyName));
  expect(response.status).toBe(405);
  expect(response.contentType.toLowerCase()).toContain("application/json");
  expectErrorCode(parseJson(response.text), "method_not_allowed");
});

it.each([
  ["Codex", HOST.codex, "MINI_CODEX_API_KEY"],
  ["Grok", HOST.grok, "MINI_GROK_API_KEY"]
])("rejects an undeclared %s path", async (_name, origin, keyName) => {
  const response = await call(`${origin}/v1/not-a-mini-plan`, env(keyName));
  expect(response.status).toBe(404);
  expect(response.contentType.toLowerCase()).toContain("application/json");
  expectErrorCode(parseJson(response.text), "not_found");
});

it.each([
  ["Grok key on Codex", HOST.codex, "MINI_GROK_CONTROL_API_KEY"],
  ["Codex key on Grok", HOST.grok, "MINI_CODEX_API_KEY"],
  ["Codex key on xAI", HOST.xai, "MINI_CODEX_API_KEY"],
  ["xAI key on Codex", HOST.codex, "MINI_XAI_API_KEY"],
  ["xAI key on Grok", HOST.grok, "MINI_XAI_API_KEY"]
])("denies %s", async (_name, origin, keyName) => {
  const response = await call(`${origin}/v1/models`, env(keyName));
  expect(response.status).toBe(403);
  expect(response.contentType.toLowerCase()).toContain("application/json");
  expectErrorCode(parseJson(response.text), "scope_denied");
});

it("rejects a Codex response with an unknown stream option", async () => {
  const model = await codexLanguageModel(env("MINI_CODEX_API_KEY"));
  const response = await call(`${HOST.codex}/v1/responses`, env("MINI_CODEX_API_KEY"), {
    method: "POST",
    headers: {
      Accept: "text/event-stream",
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model,
      instructions: "Reply concisely.",
      input: [{ role: "user", content: [{ type: "input_text", text: "ignored" }] }],
      store: false,
      stream_options: { reasoning_summary_delivery: "sequential_cutoff", extra: true }
    })
  });
  expect(response.status).toBe(400);
});

it("rejects malformed Codex response JSON", async () => {
  const response = await call(`${HOST.codex}/v1/responses`, env("MINI_CODEX_API_KEY"), {
    method: "POST",
    headers: {
      Accept: "text/event-stream",
      "Content-Type": "application/json"
    },
    body: Uint8Array.from([0xff])
  });
  expect(response.status).toBe(400);
});

it("streams a Codex response", async () => {
  const key = env("MINI_CODEX_API_KEY");
  const model = await codexLanguageModel(key);
  const response = await call(`${HOST.codex}/v1/responses`, key, {
    method: "POST",
    headers: {
      Accept: "text/event-stream",
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model,
      instructions: "Reply concisely.",
      input: [{ role: "user", content: [{ type: "input_text", text: "Reply exactly OK." }] }],
      store: false,
      stream: true
    })
  }, 180_000);
  expect(response.status).toBe(200);
  expect(response.contentType.toLowerCase()).toContain("text/event-stream");
});

it("accepts a unary Codex response or a controlled 400", async () => {
  const key = env("MINI_CODEX_API_KEY");
  const model = await codexLanguageModel(key);
  const response = await call(`${HOST.codex}/v1/responses`, key, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      instructions: "Reply concisely.",
      input: [{ role: "user", content: [{ type: "input_text", text: "Reply exactly OK." }] }],
      store: false,
      stream: false
    })
  }, 180_000);
  expect([200, 400]).toContain(response.status);
  if (response.status === 200) {
    expect(response.contentType.toLowerCase()).toContain("application/json");
  }
});

it("compacts a Codex response", async () => {
  const key = env("MINI_CODEX_API_KEY");
  const model = await codexLanguageModel(key);
  const response = await call(`${HOST.codex}/v1/responses`, key, {
    method: "POST",
    headers: {
      Accept: "text/event-stream",
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model,
      store: false,
      stream: true,
      input: [
        { role: "user", content: "Remember the word amber." },
        { role: "assistant", content: "OK." },
        { type: "compaction_trigger" }
      ]
    })
  }, 180_000);
  expect(response.status).toBe(200);
  expect(response.contentType.toLowerCase()).toContain("text/event-stream");
  expect(response.text).toContain("event: response.compaction.compacting");
  expect(response.text).toContain("event: response.completed");
});

it("tokenizes Grok and xAI text", async () => {
  for (const [origin, keyName] of [[HOST.grok, "MINI_GROK_API_KEY"], [HOST.xai, "MINI_XAI_API_KEY"]] as const) {
    const key = env(keyName);
    const model = await catalogModel(origin, key, "/v1/language-models", /voice|imagine|embedding/i);
    expectJson(await call(`${origin}/v1/tokenize-text`, key, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, text: "OK" })
    }));
  }
});

it("keeps optional speech and realtime routes advertised", async () => {
  const key = env("MINI_CODEX_API_KEY");
  assertNotClosed(await call(`${HOST.codex}/v1/audio/speech`, key, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "gpt-4o-mini-tts", voice: "alloy", input: "." })
  }));
  const audio = new FormData();
  audio.append("model", "gpt-4o-mini-transcribe");
  audio.append("file", new Blob([Uint8Array.from(wavProbe())], { type: "audio/wav" }), "probe.wav");
  assertNotClosed(await call(`${HOST.codex}/v1/audio/transcriptions`, key, { method: "POST", body: audio }));
  await optionalUpgrade(
    `${HOST.codex}/v1/realtime?intent=quicksilver&model=gpt-realtime-1.5`,
    key,
    { "OpenAI-Alpha": "quicksilver=v1" }
  );
  assertNotClosed(await call(
    `${HOST.codex}/v1/realtime/calls?intent=quicksilver&architecture=avas`,
    key,
    {
      method: "POST",
      headers: {
        "Content-Type": "multipart/form-data; boundary=codex-realtime-call-boundary",
        "OpenAI-Alpha": "quicksilver=v1"
      },
      body: realtimeCallBody({
        type: "quicksilver",
        model: "gpt-realtime-1.5",
        audio: { input: { format: { type: "audio/pcm", rate: 24000 } }, output: { voice: "cove" } },
        instructions: "."
      })
    }
  ));
  assertNotClosed(await call(`${HOST.codex}/v1/live`, key, {
    method: "POST",
    headers: {
      "Content-Type": "multipart/form-data; boundary=codex-realtime-call-boundary",
      "OpenAI-Alpha": "quicksilver=v2"
    },
    body: realtimeCallBody({
      audio: { output: { voice: "cove" } },
      delegation: { ack_filler: false, type: "client" },
      instructions: ".",
      model: "gpt-live-1-codex"
    })
  }));
  await optionalUpgrade(
    `${HOST.codex}/v1/live?model=gpt-live-1-codex`,
    key,
    { "OpenAI-Alpha": "quicksilver=v2" }
  );
  assertNotClosed(await upgrade(`${HOST.codex}/v1/live/rtc_probe`, key, { "OpenAI-Alpha": "quicksilver=v2" }, 60_000));
});

it("keeps Grok and xAI speech routes advertised and transcribes audio", async () => {
  for (const [origin, keyName] of [[HOST.grok, "MINI_GROK_API_KEY"], [HOST.xai, "MINI_XAI_API_KEY"]] as const) {
    const key = env(keyName);
    const voice = await voiceId(origin, key);
    assertNotClosed(await call(`${origin}/v1/tts`, key, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "OK.", voice_id: voice, language: "en" })
    }));
    const audio = new FormData();
    audio.append("file", new Blob([Uint8Array.from(wavProbe())], { type: "audio/wav" }), "probe.wav");
    expectJson(await call(`${origin}/v1/stt`, key, { method: "POST", body: audio }));
  }
});

it("completes Grok and xAI chat and compact responses", async () => {
  for (const [origin, keyName] of [[HOST.grok, "MINI_GROK_API_KEY"], [HOST.xai, "MINI_XAI_API_KEY"]] as const) {
    const key = env(keyName);
    const model = await catalogModel(origin, key, "/v1/language-models", /voice|imagine|embedding/i);
    expectJson(await call(`${origin}/v1/chat/completions`, key, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: "Reply exactly OK." }],
        stream: false
      })
    }, 180_000));
    if (origin === HOST.xai) {
      expectJson(await call(`${origin}/v1/responses/compact`, key, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model, input: "Remember the word amber." })
      }, 180_000));
    }
  }
});
