import { it } from "vitest";
import { HOST, assertNotClosed, call, env, expectJson, voiceId, wavProbe } from "../support";

it("probes xai TTS and completes STT with a real key", async () => {
  const origin = HOST.xai, apiKey = env("MINI_XAI_API_KEY");
  const voice = await voiceId(origin, apiKey);
  assertNotClosed(await call(`${origin}/v1/tts`, apiKey, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: "OK.", voice_id: voice, language: "en" })
  }));
  const audio = new FormData();
  audio.append("file", new Blob([Uint8Array.from(wavProbe())], { type: "audio/wav" }), "probe.wav");
  expectJson(await call(`${origin}/v1/stt`, apiKey, { method: "POST", body: audio }));
});
