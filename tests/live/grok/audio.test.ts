import { expect, it } from "vitest";
import { HOST, call, env, expectJson, voiceId } from "../support";
import { assertTranscript, waveAudio } from "../oracles";

it("completes Grok TTS and transcribes that spoken fixture with a real key", async () => {
  const origin = HOST.grok, apiKey = env("MINI_ONLY_GROK_SURFACE_API_KEY");
  const voice = await voiceId(origin, apiKey);
  const spoken = "Agency relay voice probe.";
  const synthesized = await call(`${origin}/v1/tts`, apiKey, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: spoken, voice_id: voice, language: "en", output_format: { codec: "wav", sample_rate: 16000 } })
  });
  expect(synthesized.status).toBe(200);
  waveAudio(synthesized.bytes);
  const audio = new FormData();
  audio.append("file", new Blob([Uint8Array.from(synthesized.bytes)], { type: "audio/wav" }), "probe.wav");
  assertTranscript(expectJson(await call(`${origin}/v1/stt`, apiKey, { method: "POST", body: audio })), spoken);
});
