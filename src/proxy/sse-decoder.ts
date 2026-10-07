export const MAX_PENDING_SSE_BUFFER_BYTES = 1024 * 1024;
export const MAX_SSE_EVENT_BYTES = 16 * 1024 * 1024;

export interface SseEvent {
  event?: string;
  data: string;
}

export class SseDecoderError extends Error {
  readonly code: "malformed_upstream_sse" | "oversized_upstream_event";
  readonly pendingBytes?: number;
  readonly eventBytes?: number;

  constructor(
    code: "malformed_upstream_sse" | "oversized_upstream_event",
    message: string,
    details: { pendingBytes?: number; eventBytes?: number } = {}
  ) {
    super(message);
    this.name = "SseDecoderError";
    this.code = code;
    this.pendingBytes = details.pendingBytes;
    this.eventBytes = details.eventBytes;
  }
}

export class SseDecoder {
  private readonly textDecoder = new TextDecoder();
  private pendingLineChunks: Uint8Array[] = [];
  private pendingLineBytes = 0;
  private eventBytes = 0;
  private eventName: string | undefined;
  private dataLines: string[] = [];
  private hasData = false;
  private finished = false;

  push(chunk: Uint8Array): SseEvent[] {
    if (this.finished) {
      throw new Error("SseDecoder is already finished");
    }
    const events: SseEvent[] = [];
    let segmentStart = 0;
    for (let index = 0; index < chunk.byteLength; index += 1) {
      if (chunk[index] !== 0x0a) {
        continue;
      }
      this.appendPendingLine(chunk.subarray(segmentStart, index));
      this.processPendingLine(events, true);
      segmentStart = index + 1;
    }
    this.appendPendingLine(chunk.subarray(segmentStart));
    return events;
  }

  finish(): SseEvent[] {
    if (this.finished) {
      return [];
    }
    this.finished = true;
    const events: SseEvent[] = [];
    if (this.pendingLineBytes > 0) {
      this.processPendingLine(events, false);
    }
    this.dispatch(events);
    return events;
  }

  private appendPendingLine(bytes: Uint8Array): void {
    if (bytes.byteLength === 0) {
      return;
    }
    this.pendingLineChunks.push(bytes);
    this.pendingLineBytes += bytes.byteLength;
    if (this.pendingLineBytes > MAX_PENDING_SSE_BUFFER_BYTES) {
      throw new SseDecoderError(
        "malformed_upstream_sse",
        "Upstream SSE contains an unterminated line larger than the pending buffer limit",
        { pendingBytes: this.pendingLineBytes }
      );
    }
  }

  private processPendingLine(events: SseEvent[], hadLf: boolean): void {
    let lineBytes = concatBytes(this.pendingLineChunks, this.pendingLineBytes);
    const rawLineBytes = this.pendingLineBytes + (hadLf ? 1 : 0);
    this.pendingLineChunks = [];
    this.pendingLineBytes = 0;
    if (lineBytes.at(-1) === 0x0d) {
      lineBytes = lineBytes.subarray(0, lineBytes.byteLength - 1);
    }

    this.eventBytes += rawLineBytes;
    if (this.eventBytes > MAX_SSE_EVENT_BYTES) {
      throw new SseDecoderError(
        "oversized_upstream_event",
        "Upstream SSE event exceeds the event size limit",
        { eventBytes: this.eventBytes }
      );
    }

    if (lineBytes.byteLength === 0) {
      this.dispatch(events);
      return;
    }

    const line = this.textDecoder.decode(lineBytes);
    if (line.startsWith(":")) {
      return;
    }
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) {
      value = value.slice(1);
    }
    if (field === "event") {
      this.eventName = value || undefined;
    } else if (field === "data") {
      this.hasData = true;
      this.dataLines.push(value);
    }
  }

  private dispatch(events: SseEvent[]): void {
    if (this.hasData) {
      events.push({
        ...(this.eventName ? { event: this.eventName } : {}),
        data: this.dataLines.join("\n")
      });
    }
    this.eventBytes = 0;
    this.eventName = undefined;
    this.dataLines = [];
    this.hasData = false;
  }
}

function concatBytes(chunks: Uint8Array[], totalBytes: number): Uint8Array {
  if (chunks.length === 0) {
    return new Uint8Array();
  }
  if (chunks.length === 1) {
    return chunks[0];
  }
  const result = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}
