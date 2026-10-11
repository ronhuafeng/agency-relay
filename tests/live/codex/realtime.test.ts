import { it } from "vitest";
import { HOST, assertNotClosed, call, env, optionalUpgrade, realtimeCallBody, upgrade, wavProbe } from "../support";

it("probes declared Codex speech and realtime paths for reachability (not task success)", async () => {
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
