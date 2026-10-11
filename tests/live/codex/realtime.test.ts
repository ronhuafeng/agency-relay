import { it } from "vitest";
import { HOST, assertNotClosed, call, env, wavProbe } from "../support";

const AUDIO_OFFER = [
  "v=0",
  "o=- 0 0 IN IP4 127.0.0.1",
  "s=-",
  "t=0 0",
  "m=audio 9 UDP/TLS/RTP/SAVPF 111",
  "c=IN IP4 0.0.0.0",
  "a=rtpmap:111 opus/48000/2",
  "a=sendrecv",
  "a=rtcp-mux"
].join("\r\n");

it("probes Codex ChatGPT-backend voice paths through Agency Relay", async () => {
  const key = env("MINI_ONLY_CODEX_SURFACE_API_KEY");
  const audio = new FormData();
  audio.append("file", new Blob([Uint8Array.from(wavProbe())], { type: "audio/wav" }), "probe.wav");
  assertNotClosed(await call(`${HOST.codex}/v1/audio/transcriptions`, key, { method: "POST", body: audio }));
  assertNotClosed(await call(`${HOST.codex}/v1/realtime/calls`, key, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      sdp: AUDIO_OFFER,
      session: {
        type: "realtime",
        model: "gpt-realtime-1.5",
        audio: { input: { format: { type: "audio/pcm", rate: 24000 } }, output: { voice: "cove" } },
        instructions: "."
      }
    })
  }));
  assertNotClosed(await call(`${HOST.codex}/v1/live`, key, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      sdp: AUDIO_OFFER,
      session: {
        audio: { output: { voice: "cove" } },
        delegation: { ack_filler: false, type: "client" },
        instructions: ".",
        model: "gpt-live-1-codex"
      }
    })
  }));
}, 180_000);
