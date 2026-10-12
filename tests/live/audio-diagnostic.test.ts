import { it } from "vitest";
import { readFileSync } from "node:fs";
import { env } from "./support";
import { isRecord, parseJson, assertNoSecret } from "./runtime";
import { assertTranscript, SocketOutcome, waveAudio } from "./oracles";
import { StorySocket } from "./websocket";

// One focused STT proof. This does not establish full Audio or Live acceptance.
it("transcribes the normal spoken fixture through a completed STT WebSocket", async () => {
  const fixture = waveAudio(readFileSync(new URL("./codex/fixtures/probe.wav", import.meta.url)));
  const spoken = "agency relay";
  const phraseMatches = (text: string) => {
    try { assertTranscript({ text }, spoken); return true; } catch { return false; }
  };
  const key = env("MINI_ONLY_XAI_SURFACE_API_KEY");
  const socket = await StorySocket.connect(`wss://xai.trustedtunnel.app/v1/stt?sample_rate=${fixture.sampleRate}&encoding=pcm`, { Authorization: `Bearer ${key}` });
  try {
    const body = (message: { kind: string; data: Buffer }): Record<string, unknown> | null => {
      if (message.kind !== "text") return null;
      const text = message.data.toString("utf8"); assertNoSecret(text, key);
      const parsed = parseJson(text);
      if (!isRecord(parsed)) return null;
      if (parsed.type === "error") throw new Error("diagnostic STT provider error");
      return parsed;
    };
    await socket.waitFor(message => body(message)?.type === "transcript.created", 60_000);
    const chunkSize = Math.floor(fixture.sampleRate / 10) * 2;
    let sent = 0;
    for (let offset = 0; offset < fixture.pcm.length; offset += chunkSize) {
      const chunk = fixture.pcm.subarray(offset, offset + chunkSize);
      socket.sendBinary(chunk); sent += chunk.length;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    socket.sendText(JSON.stringify({ type: "audio.done" }));
    const outcome = new SocketOutcome("stt", spoken);
    let partials = 0, locked = 0, lockedCharacters = 0, lockedPhraseMatch = false;
    await socket.waitFor(message => {
      const event = body(message);
      if (event?.type === "transcript.partial") {
        partials += 1;
        if (event.is_final === true && typeof event.text === "string") {
          locked += 1;
          lockedCharacters += event.text.length;
          lockedPhraseMatch ||= phraseMatches(event.text);
        }
      }
      if (event?.type === "transcript.done") {
        const text = typeof event.text === "string" ? event.text : "";
        console.log(JSON.stringify({ diagnostic: "stt-fixture", terminal_received: true,
          text_present: typeof event.text === "string", characters: text.length,
          expected_phrase_match: phraseMatches(text), partial_events: partials,
          locked_partial_events: locked, locked_partial_characters_total: lockedCharacters,
          locked_partial_phrase_match: lockedPhraseMatch, pcm_bytes_sent: sent,
          fixture_pcm_bytes: fixture.pcm.length, sample_rate: fixture.sampleRate }));
      }
      return outcome.observe(event);
    }, 120_000);
  } finally { socket.close(); }
}, 180_000);
