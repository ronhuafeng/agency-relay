import { expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { assertJsonShape, assertNoSecret, isRecord, languageModel, parseJson, requireEnv, send } from "../runtime";
import { bytesToUtf8 } from "../support";
import { SocketOutcome, waveAudio } from "../oracles";
import { StorySocket, type SocketMessage } from "../websocket";

const HOST = "https://xai.trustedtunnel.app";

it("completes xAI Responses over a real WebSocket", async () => {
  const key = requireEnv("MINI_ONLY_XAI_SURFACE_API_KEY");
  await responsesSocket(key, await languageModel(HOST, key));
}, 240_000);

it("completes xAI TTS over a real WebSocket", async () => {
  const key = requireEnv("MINI_ONLY_XAI_SURFACE_API_KEY");
  await ttsSocket(key, await voiceId(key));
}, 180_000);

it("completes xAI STT over a real WebSocket", async () => {
  await sttSocket(requireEnv("MINI_ONLY_XAI_SURFACE_API_KEY"));
}, 180_000);

it("completes xAI Realtime over a real WebSocket", async () => {
  const key = requireEnv("MINI_ONLY_XAI_SURFACE_API_KEY");
  await realtimeSocket(key, await voiceModel(key), await voiceId(key));
}, 300_000);

async function voiceId(key: string): Promise<string> {
  const catalog = await send(`${HOST}/v1/tts/voices`, key);
  expect(catalog.status).toBe(200);
  const body = parseJson(catalog.text);
  const voices = isRecord(body) && Array.isArray(body.voices) ? body.voices : [];
  expect(voices.length).toBeGreaterThan(0);
  assertJsonShape(voices[0], { voice_id: expect.any(String) });
  const voice = (voices[0] as { voice_id: string }).voice_id;
  expect(/^[A-Za-z0-9_-]{1,200}$/.test(voice)).toBe(true);
  return voice;
}

async function voiceModel(key: string): Promise<string> {
  const catalog = await send(`${HOST}/v1/models`, key);
  const body = parseJson(catalog.text);
  const rows = isRecord(body) && Array.isArray(body.data) ? body.data : isRecord(body) && Array.isArray(body.models) ? body.models : [];
  const ids = rows.flatMap((row) => {
    const id = typeof row === "string" ? row : isRecord(row) && typeof row.id === "string" ? row.id : "";
    return id.startsWith("grok-voice") && !id.includes("transcribe") ? [id] : [];
  });
  return ids.find((id) => id === "grok-voice-latest") ?? ids[0] ?? "grok-voice-latest";
}

async function responsesSocket(key: string, model: string): Promise<void> {
  const socket = await StorySocket.connect("wss://xai.trustedtunnel.app/v1/responses", { Authorization: `Bearer ${key}` });
  try {
    socket.sendText(JSON.stringify({
      type: "response.create",
      model,
      store: false,
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "Reply exactly OK." }] }],
      tools: []
    }));
    const outcome = new SocketOutcome("responses");
    await socket.waitFor(message => outcome.observe(eventBody(message, key)), 180_000);
  } finally {
    socket.close();
  }
}

async function ttsSocket(key: string, voice: string): Promise<void> {
  const socket = await StorySocket.connect(`wss://xai.trustedtunnel.app/v1/tts?voice=${encodeURIComponent(voice)}&language=en&codec=pcm&sample_rate=16000`, { Authorization: `Bearer ${key}` });
  try {
    socket.sendText(JSON.stringify({ type: "text.delta", delta: "OK" }));
    socket.sendText(JSON.stringify({ type: "text.done" }));
    const outcome = new SocketOutcome("tts");
    await socket.waitFor(message => outcome.observe(eventBody(message, key)), 120_000);
  } finally {
    socket.close();
  }
}

async function sttSocket(key: string): Promise<void> {
  const fixture = waveAudio(readFileSync(new URL("../codex/fixtures/probe.wav", import.meta.url)));
  const socket = await StorySocket.connect(`wss://xai.trustedtunnel.app/v1/stt?sample_rate=${fixture.sampleRate}&encoding=pcm`, { Authorization: `Bearer ${key}` });
  try {
    await socket.waitFor(message => eventBody(message, key)?.type === "transcript.created", 60_000);
    const chunkSize = Math.floor(fixture.sampleRate / 10) * 2;
    for (let offset = 0; offset < fixture.pcm.length; offset += chunkSize) {
      socket.sendBinary(fixture.pcm.subarray(offset, offset + chunkSize));
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    socket.sendText(JSON.stringify({ type: "audio.done" }));
    const outcome = new SocketOutcome("stt", "agency relay");
    await socket.waitFor(message => outcome.observe(eventBody(message, key)), 120_000);
  } finally {
    socket.close();
  }
}

async function realtimeSocket(key: string, model: string, voice: string): Promise<void> {
  const socket = await StorySocket.connect(`wss://xai.trustedtunnel.app/v1/realtime?model=${encodeURIComponent(model)}`, { Authorization: `Bearer ${key}` });
  try {
    await socket.waitFor(message => eventBody(message, key)?.type === "session.created", 60_000);
    socket.sendText(JSON.stringify({ type: "session.update", session: { voice, instructions: "Reply briefly.", turn_detection: { type: "server_vad" } } }));
    await socket.waitFor(message => eventBody(message, key)?.type === "session.updated", 60_000);
    socket.sendText(JSON.stringify({ type: "conversation.item.create", item: { type: "message", role: "user", content: [{ type: "input_text", text: "Say OK." }] } }));
    socket.sendText(JSON.stringify({ type: "response.create" }));
    const outcome = new SocketOutcome("voice", "OK");
    await socket.waitFor(message => outcome.observe(eventBody(message, key)), 180_000);
  } finally {
    socket.close();
  }
}

function eventBody(message: SocketMessage, key: string): Record<string, unknown> | null {
  if (message.kind !== "text") {
    return null;
  }
  const text = bytesToUtf8(message.data);
  assertNoSecret(text, key);
  let body: unknown;
  try {
    body = parseJson(text);
  } catch {
    return null;
  }
  if (!isRecord(body) || typeof body.type !== "string") {
    return null;
  }
  if (body.type === "error") throw new Error("provider WebSocket operation failed");
  return body;
}
