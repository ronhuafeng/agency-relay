import { isRecord } from "./runtime";

/** A successful task must produce content; HTTP 200 is not sufficient. */
export function responseText(body: unknown): string {
  if (!isRecord(body)) return "";
  const parts: string[] = [];
  if (typeof body.output_text === "string") parts.push(body.output_text);
  if (!Array.isArray(body.output)) return parts.join("");
  for (const item of body.output) {
    if (!isRecord(item)) continue;
    if (item.type === "output_text" && typeof item.text === "string") parts.push(item.text);
    if (!Array.isArray(item.content)) continue;
    for (const content of item.content) {
      if (isRecord(content) && content.type === "output_text" && typeof content.text === "string") {
        parts.push(content.text);
      }
    }
  }
  return parts.join("");
}

export function assertResponseHasText(body: unknown): void {
  if (!responseText(body).trim()) throw new Error("completed response has no output text");
}

export function assertPcmAudio(bytes: Uint8Array): void {
  if (bytes.length < 2 || bytes.length % 2 !== 0 || !bytes.some(byte => byte !== 0)) {
    throw new Error("audio contains no usable PCM16 samples");
  }
}

/** Read the selected PCM16 WAV fixture, including non-audio chunks and padding. */
export function waveAudio(bytes: Buffer): { pcm: Buffer; sampleRate: number } {
  const invalid = () => { throw new Error("audio WAV contract mismatch"); };
  if (bytes.length < 44 || bytes.toString("ascii", 0, 4) !== "RIFF" || bytes.toString("ascii", 8, 12) !== "WAVE") return invalid();
  let sampleRate = 0;
  let pcm: Buffer | undefined;
  for (let offset = 12; offset + 8 <= bytes.length;) {
    const kind = bytes.toString("ascii", offset, offset + 4);
    const declared = bytes.readUInt32LE(offset + 4);
    const size = declared === 0xffffffff && kind === "data" ? bytes.length - offset - 8 : declared;
    const start = offset + 8;
    if (start + size > bytes.length) return invalid();
    if (kind === "fmt ") {
      if (size < 16 || bytes.readUInt16LE(start) !== 1 || bytes.readUInt16LE(start + 14) !== 16 || bytes.readUInt16LE(start + 2) < 1) return invalid();
      sampleRate = bytes.readUInt32LE(start + 4);
    } else if (kind === "data") {
      pcm = bytes.subarray(start, start + size);
    }
    offset = start + size + (size & 1);
  }
  if (!sampleRate || !pcm) return invalid();
  assertPcmAudio(pcm);
  return { pcm, sampleRate };
}

export function assertTranscript(body: unknown, expected: string): void {
  const normalize = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  if (!isRecord(body) || typeof body.text !== "string" || !normalize(expected)
    || !(` ${normalize(body.text)} `).includes(` ${normalize(expected)} `)) {
    throw new Error("spoken fixture transcript mismatch");
  }
}

export function compactOutput(body: unknown): unknown[] {
  if (!isRecord(body) || !Array.isArray(body.output) || !body.output.some(item => isRecord(item)
    && item.type === "compaction" && typeof item.encrypted_content === "string" && item.encrypted_content.trim().length > 0)) {
    throw new Error("compact result has no reusable opaque item");
  }
  return body.output;
}

/** One isolated request/turn; event names alone never establish completion. */
export class SocketOutcome {
  private text = "";
  private readonly audio: Buffer[] = [];
  private responseId: string | undefined;

  constructor(private readonly kind: "responses" | "tts" | "stt" | "voice", private readonly spoken = "") {}

  observe(body: unknown): boolean {
    if (!isRecord(body) || typeof body.type !== "string") return false;
    if (["error", "response.failed", "response.incomplete"].includes(body.type)) {
      throw new Error("provider WebSocket operation failed");
    }
    if (!this.responseId && body.type === "response.created" && isRecord(body.response) && typeof body.response.id === "string") {
      this.responseId = body.response.id;
    }
    const id = typeof body.response_id === "string" ? body.response_id
      : isRecord(body.response) && typeof body.response.id === "string" ? body.response.id : undefined;
    if (id && this.responseId && id !== this.responseId) return false;
    if (this.kind === "responses" && body.type === "response.output_text.delta" && typeof body.delta === "string") {
      this.text += body.delta;
    }
    const audioEvent = this.kind === "tts" ? body.type === "audio.delta"
      : this.kind === "voice" && ["response.audio.delta", "response.output_audio.delta"].includes(body.type);
    if (audioEvent) {
      if (typeof body.delta !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(body.delta)) throw new Error("provider audio encoding rejected");
      const bytes = Buffer.from(body.delta, "base64");
      if (bytes.toString("base64").replace(/=+$/, "") !== body.delta.replace(/=+$/, "")) throw new Error("provider audio encoding rejected");
      this.audio.push(bytes);
    }
    if (this.kind === "voice" && ["response.audio_transcript.delta", "response.output_audio_transcript.delta"].includes(body.type)
      && typeof body.delta === "string") this.text += body.delta;
    if (this.kind === "responses" && body.type === "response.completed") {
      if (!isRecord(body.response) || body.response.status !== "completed"
        || !(this.text || responseText(body.response)).trim()) throw new Error("WebSocket response has no completed text result");
      return true;
    }
    if (this.kind === "stt" && body.type === "transcript.done") {
      assertTranscript(body, this.spoken);
      return true;
    }
    if (this.kind === "tts" && body.type === "audio.done") {
      assertPcmAudio(Buffer.concat(this.audio));
      return true;
    }
    if (this.kind === "voice" && body.type === "response.done") {
      const response = isRecord(body.response) ? body.response : undefined;
      if (response && ["failed", "incomplete", "cancelled", "canceled"].includes(String(response.status))) {
        throw new Error("provider WebSocket operation failed");
      }
      assertPcmAudio(Buffer.concat(this.audio));
      assertTranscript({ text: this.text }, this.spoken);
      return true;
    }
    return false;
  }
}

function completedSse(text: string): { events: { event: string; payload: unknown }[]; result: Record<string, unknown> } {
  const relevant = ["error", "response.failed", "response.incomplete", "response.completed", "response.output_item.done", "response.output_text.delta"];
  const events = text.split(/\r?\n\r?\n/).flatMap((block) => {
    const lines = block.split(/\r?\n/);
    const event = lines.find((line) => line.startsWith("event:"))?.slice(6).trim();
    const data = lines.filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim()).join("\n");
    if ((event && !relevant.includes(event)) || !data || data === "[DONE]") return [];
    let payload: unknown;
    try { payload = JSON.parse(data); }
    catch {
      if (!event) return [];
      throw new Error("provider SSE payload is not JSON");
    }
    const type = event ?? (isRecord(payload) && typeof payload.type === "string" ? payload.type : "");
    return relevant.includes(type) ? [{ event: type, payload }] : [];
  });
  if (events.some((e) => ["error", "response.failed", "response.incomplete"].includes(e.event))) {
    throw new Error("provider SSE stream failed");
  }
  const completed = [...events].reverse().find((e) => e.event === "response.completed");
  if (!completed) throw new Error("provider SSE stream missing completed event");
  const payload = completed.payload;
  const result = isRecord(payload) ? payload.response : undefined;
  if (!isRecord(result) || result.status !== "completed") {
    throw new Error("provider SSE terminal status is not completed");
  }
  return { events, result };
}

export function completedSseText(text: string): string {
  const { events, result } = completedSse(text);
  const deltas = events.flatMap(({ event, payload }) => event === "response.output_text.delta"
    && isRecord(payload) && typeof payload.delta === "string" ? [payload.delta] : []).join("");
  const output = deltas || responseText(result);
  if (!output.trim()) throw new Error("completed SSE had no model output");
  return output;
}

/** A completed SSE frame must be observed, with actual model text produced. */
export function assertCompletedSse(text: string): void {
  completedSseText(text);
}

/** Keep the opaque item in memory, unchanged, for the continuation request. */
export function compactionItem(text: string): Record<string, unknown> {
  const { events, result } = completedSse(text);
  const items = events.flatMap(({ event, payload }) => event === "response.output_item.done"
    && isRecord(payload) ? [payload.item] : []);
  if (Array.isArray(result.output)) items.push(...result.output);
  const item = items.find(value => isRecord(value) && value.type === "compaction"
    && typeof value.encrypted_content === "string" && value.encrypted_content.length > 0);
  if (!isRecord(item)) throw new Error("completed stream has no reusable compaction item");
  return item;
}
