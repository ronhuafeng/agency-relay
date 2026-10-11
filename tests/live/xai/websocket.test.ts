import { expect, it } from "vitest";
import { isRecord, languageModel, parseJson, requireEnv } from "../runtime";
import { bytesToUtf8 } from "../support";
import { StorySocket, type SocketMessage } from "../websocket";

const HOST = "https://xai.trustedtunnel.app";

it("completes xAI Responses over a real WebSocket", async () => {
  const key = requireEnv("MINI_XAI_API_KEY");
  await responsesSocket(key, await languageModel(HOST, key));
}, 240_000);

it("completes xAI TTS over a real WebSocket", async () => {
  const key = requireEnv("MINI_XAI_API_KEY");
  await ttsSocket(key, await voiceId(key));
}, 180_000);

it("completes xAI STT over a real WebSocket", async () => {
  await sttSocket(requireEnv("MINI_XAI_API_KEY"));
}, 180_000);

it("completes xAI Realtime over a real WebSocket", async () => {
  const key = requireEnv("MINI_XAI_API_KEY");
  await realtimeSocket(key, await voiceModel(key), await voiceId(key));
}, 300_000);

async function voiceId(key: string): Promise<string> {
  const catalog = await send(`${HOST}/v1/tts/voices`, key);
  expect(catalog.status).toBe(200);
  const body = parseJson(catalog.text);
  expect(body).toMatchObject({ voices: [expect.objectContaining({ voice_id: expect.any(String) })] });
  return ((body as { voices: Array<{ voice_id: string }> }).voices[0] ?? { voice_id: "" }).voice_id;
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
    await socket.waitFor((message) => eventType(message, key) === "response.completed", 180_000);
  } finally {
    socket.close();
  }
}

async function ttsSocket(key: string, voice: string): Promise<void> {
  const socket = await StorySocket.connect(`wss://xai.trustedtunnel.app/v1/tts?voice=${encodeURIComponent(voice)}&language=en`, { Authorization: `Bearer ${key}` });
  try {
    socket.sendText(JSON.stringify({ type: "text.delta", delta: "OK" }));
    socket.sendText(JSON.stringify({ type: "text.done" }));
    await socket.waitFor((message) => eventType(message, key) === "audio.done", 120_000);
  } finally {
    socket.close();
  }
}

async function sttSocket(key: string): Promise<void> {
  const socket = await StorySocket.connect("wss://xai.trustedtunnel.app/v1/stt?sample_rate=8000&encoding=pcm", { Authorization: `Bearer ${key}` });
  try {
    await socket.waitFor((message) => eventType(message, key) === "transcript.created", 60_000);
    socket.sendBinary(tone());
    socket.sendText(JSON.stringify({ type: "audio.done" }));
    await socket.waitFor((message) => eventType(message, key) === "transcript.done", 120_000);
  } finally {
    socket.close();
  }
}

async function realtimeSocket(key: string, model: string, voice: string): Promise<void> {
  const socket = await StorySocket.connect(`wss://xai.trustedtunnel.app/v1/realtime?model=${encodeURIComponent(model)}`, { Authorization: `Bearer ${key}` });
  try {
    await socket.waitFor((message) => eventType(message, key) === "session.created", 60_000);
    socket.sendText(JSON.stringify({ type: "session.update", session: { voice, instructions: "Reply briefly.", turn_detection: { type: "server_vad" } } }));
    await socket.waitFor((message) => eventType(message, key) === "session.updated", 60_000);
    socket.sendText(JSON.stringify({ type: "conversation.item.create", item: { type: "message", role: "user", content: [{ type: "input_text", text: "Say OK." }] } }));
    socket.sendText(JSON.stringify({ type: "response.create" }));
    await socket.waitFor((message) => eventType(message, key) === "response.done", 180_000);
  } finally {
    socket.close();
  }
}

function eventType(message: SocketMessage, key: string): string | null {
  if (message.kind !== "text") {
    return null;
  }
  const text = bytesToUtf8(message.data);
  expect(text).not.toContain(key);
  let body: unknown;
  try {
    body = parseJson(text);
  } catch {
    return null;
  }
  if (!isRecord(body) || typeof body.type !== "string") {
    return null;
  }
  expect(body.type).not.toBe("error");
  return body.type;
}

function tone(): Buffer {
  const data = Buffer.alloc(1600 * 2);
  for (let index = 0; index < 1600; index += 1) {
    data.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * index) / 8000) * 8000), index * 2);
  }
  return data;
}
