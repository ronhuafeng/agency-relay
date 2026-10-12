import { readFileSync } from "node:fs";
import { it } from "vitest";
import { HOST, call, env, voiceId } from "./support";
import { isRecord, parseJson, assertNoSecret } from "./runtime";
import { waveAudio } from "./oracles";
import { StorySocket } from "./websocket";

// Diagnostic evidence only. Completion of this job is not Audio acceptance.
it("inspects two TTS containers and one STT fixture without persisting content", async () => {
  for (const surface of ["grok", "xai"] as const) {
    const key = env(surface === "grok" ? "MINI_ONLY_GROK_SURFACE_API_KEY" : "MINI_ONLY_XAI_SURFACE_API_KEY");
    const voice = await voiceId(HOST[surface], key);
    const result = await call(`${HOST[surface]}/v1/tts`, key, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "Agency relay voice probe.", voice_id: voice, language: "en", output_format: { codec: "wav", sample_rate: 16000 } })
    });
    const bytes = result.bytes;
    const riff = bytes.length >= 12 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WAVE";
    const chunks: Array<{ kind: string; offset: number; declared: number; available: number; exceeds: boolean; format?: number; channels?: number; sample_rate?: number; bits?: number }> = [];
    if (riff) {
      for (let offset = 12; offset + 8 <= bytes.length && chunks.length < 16;) {
        const name = bytes.toString("ascii", offset, offset + 4);
        const declared = bytes.readUInt32LE(offset + 4), start = offset + 8;
        const chunk = { kind: ["fmt ", "data", "LIST", "JUNK", "fact"].includes(name) ? name.trim() : "other",
          offset, declared, available: bytes.length - start, exceeds: declared > bytes.length - start };
        chunks.push(name === "fmt " && declared >= 16 && bytes.length - start >= 16 ? {
          ...chunk, format: bytes.readUInt16LE(start), channels: bytes.readUInt16LE(start + 2),
          sample_rate: bytes.readUInt32LE(start + 4), bits: bytes.readUInt16LE(start + 14)
        } : chunk);
        if (chunk.exceeds) break;
        offset = start + declared + (declared & 1);
      }
    }
    let currentOracleAccepts = false;
    try { waveAudio(bytes); currentOracleAccepts = true; } catch { /* Fixed diagnostic classification only. */ }
    const length = result.headers.get("content-length");
    console.log(JSON.stringify({ diagnostic: "audio-container", surface, http_status: result.status, bytes: bytes.length,
      riff_wave: riff, riff_declared: riff ? bytes.readUInt32LE(4) : null, chunks,
      current_oracle_accepts: currentOracleAccepts, content_length_present: length !== null,
      content_length_matches: length === null || result.headers.has("content-encoding") ? null : Number(length) === bytes.length }));
  }
  const fixture = waveAudio(readFileSync(new URL("./codex/fixtures/probe.wav", import.meta.url)));
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
    await socket.waitFor(message => {
      const event = body(message);
      if (event?.type !== "transcript.done") return false;
      const text = typeof event.text === "string" ? event.text : "";
      const words = text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().split(/\s+/).filter(Boolean);
      console.log(JSON.stringify({ diagnostic: "stt-fixture", terminal_received: true, text_present: typeof event.text === "string",
        characters: text.length, words: words.length, expected_phrase_match: (` ${words.join(" ")} `).includes(" agency relay "),
        agency_word_match: words.includes("agency"), relay_word_match: words.includes("relay"),
        pcm_bytes_sent: sent, fixture_pcm_bytes: fixture.pcm.length, sample_rate: fixture.sampleRate }));
      return true;
    }, 120_000);
  } finally { socket.close(); }
}, 360_000);
