import { Readable } from "node:stream";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";
import { SseDecoder, SseDecoderError, type SseEvent } from "./sse-decoder";
import type { CapturedProviderUsage, CapturedResponseUsage, CodexTransportObservation } from "../types";

type JsonObject = Record<string, unknown>;
type ObservationErrorCode = Exclude<CodexTransportObservation["observation_error_code"], null>;

const MAX_UNARY_OBSERVATION_BYTES = 16 * 1024 * 1024;
export const MAX_RESPONSE_OBSERVATION_LAG_BYTES = 1024 * 1024;

export class ResponseObservationError extends Error {
  constructor(
    readonly code: ObservationErrorCode,
    readonly stage: CodexTransportObservation["observation_stage"]
  ) {
    super(code ?? "response_observation_failed");
    this.name = "ResponseObservationError";
  }
}

export async function observeCodexResponse(
  body: ReadableStream<Uint8Array>,
  observation: CodexTransportObservation,
  now: () => Date,
  startedAt: number,
  signal: AbortSignal
): Promise<CapturedResponseUsage | null> {
  if (observation.transport === "http_other") {
    return null;
  }

  if (observation.content_encoding === "multiple" || observation.content_encoding === "unsupported") {
    throw new ResponseObservationError("response_observation_unsupported_encoding", "response_decompression");
  }

  const chunks = decodedChunks(body, observation, now, startedAt, signal);

  return observation.transport === "http_sse"
    ? observeSseResponse(chunks, observation, now, startedAt, signal)
    : observeUnaryResponse(chunks, observation, signal);
}

async function observeSseResponse(
  chunks: AsyncIterable<Uint8Array>,
  observation: CodexTransportObservation,
  now: () => Date,
  startedAt: number,
  signal: AbortSignal
): Promise<CapturedResponseUsage | null> {
  const decoder = new SseDecoder();
  let capture: CapturedResponseUsage | null = null;

  try {
    for await (const chunk of chunks) {
      for (const event of decoder.push(chunk)) {
        capture ??= observeSseEvent(event, observation, now, startedAt);
      }
    }
    for (const event of decoder.finish()) {
      capture ??= observeSseEvent(event, observation, now, startedAt);
    }
  } catch (error) {
    if (signal.aborted) {
      throw new ResponseObservationError("client_request_aborted", "response_body");
    }
    if (error instanceof ResponseObservationError) {
      throw error;
    }
    if (error instanceof SseDecoderError) {
      throw new ResponseObservationError("response_observation_limit", "response_parse");
    }
    throw new ResponseObservationError("response_observation_parse_failed", "response_parse");
  }

  if (signal.aborted) {
    throw new ResponseObservationError("client_request_aborted", "response_body");
  }
  if (observation.terminal_event === null) {
    throw new ResponseObservationError("response_observation_premature_eof", "response_body");
  }
  return capture;
}

async function observeUnaryResponse(
  body: AsyncIterable<Uint8Array>,
  observation: CodexTransportObservation,
  signal: AbortSignal
): Promise<CapturedResponseUsage | null> {
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    for await (const chunk of body) {
      totalBytes += chunk.byteLength;
      if (totalBytes > MAX_UNARY_OBSERVATION_BYTES) {
        throw new ResponseObservationError("response_observation_limit", "response_parse");
      }
      chunks.push(chunk);
    }
  } catch (error) {
    if (signal.aborted) {
      throw new ResponseObservationError("client_request_aborted", "response_body");
    }
    if (error instanceof ResponseObservationError) {
      throw error;
    }
    throw new ResponseObservationError("response_observation_parse_failed", "response_parse");
  }
  if (signal.aborted) {
    throw new ResponseObservationError("client_request_aborted", "response_body");
  }
  if (totalBytes === 0) {
    throw new ResponseObservationError("response_observation_premature_eof", "response_body");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(concatBytes(chunks, totalBytes)));
  } catch {
    throw new ResponseObservationError("response_observation_parse_failed", "response_parse");
  }
  if (!isJsonObject(parsed)) {
    throw new ResponseObservationError("response_observation_parse_failed", "response_parse");
  }
  const terminal = unaryTerminalEvent(parsed);
  if (terminal === null) {
    throw new ResponseObservationError("response_observation_premature_eof", "response_parse");
  }
  observation.terminal_event = terminal;
  return captureResponseUsage(parsed);
}

async function* decodedChunks(
  body: ReadableStream<Uint8Array>,
  observation: CodexTransportObservation,
  now: () => Date,
  startedAt: number,
  signal: AbortSignal
): AsyncGenerator<Uint8Array> {
  const raw = rawChunks(body, observation, now, startedAt, signal);
  if (observation.content_encoding === null || observation.content_encoding === "identity") {
    yield* raw;
    return;
  }

  const decompressor = observation.content_encoding === "gzip"
    ? createGunzip()
    : observation.content_encoding === "deflate"
      ? createInflate()
      : createBrotliDecompress();
  const decoded = Readable.from(raw, { signal }).pipe(decompressor);
  try {
    for await (const chunk of decoded as AsyncIterable<unknown>) {
      if (!(chunk instanceof Uint8Array)) {
        throw new Error("Unexpected decompressor output");
      }
      yield chunk;
    }
  } catch (error) {
    if (error instanceof ResponseObservationError) {
      throw error;
    }
    if (signal.aborted) {
      throw new ResponseObservationError("client_request_aborted", "response_body");
    }
    throw new ResponseObservationError("response_observation_decompression_failed", "response_decompression");
  }
}

async function* rawChunks(
  body: ReadableStream<Uint8Array>,
  observation: CodexTransportObservation,
  now: () => Date,
  startedAt: number,
  signal: AbortSignal
): AsyncGenerator<Uint8Array> {
  const reader = body.getReader();
  let completed = false;
  const cancel = () => {
    void reader.cancel(signal.reason).catch(() => undefined);
  };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) {
        completed = true;
        return;
      }
      observeChunk(observation, result.value, now, startedAt);
      yield result.value;
    }
  } catch (error) {
    if (signal.aborted) {
      throw new ResponseObservationError("client_request_aborted", "response_body");
    }
    if (error instanceof ResponseObservationError) {
      throw error;
    }
    throw new ResponseObservationError("response_observation_read_failed", "response_body");
  } finally {
    signal.removeEventListener("abort", cancel);
    if (!completed) {
      await reader.cancel().catch(() => undefined);
    }
    reader.releaseLock();
  }
}

function observeChunk(
  observation: CodexTransportObservation,
  chunk: Uint8Array,
  now: () => Date,
  startedAt: number
): void {
  if (observation.transport === "http_sse" && observation.first_sse_chunk_ms === null) {
    observation.first_sse_chunk_ms = elapsedMs(now, startedAt);
  }
  observation.stream_bytes += chunk.byteLength;
  observation.stream_chunks += 1;
}

function unaryTerminalEvent(response: JsonObject): CodexTransportObservation["terminal_event"] {
  const terminal = terminalEventType(response);
  if (terminal !== null) {
    return terminal;
  }
  if (response.status === "failed") {
    return "response.failed";
  }
  if (response.status === "incomplete") {
    return "response.incomplete";
  }
  if (response.status === "completed" || response.object === "response") {
    return "response.completed";
  }
  return null;
}

function observeSseEvent(
  event: SseEvent,
  observation: CodexTransportObservation,
  now: () => Date,
  startedAt: number
): CapturedResponseUsage | null {
  const data = event.data.trim();
  if (!data || data === "[DONE]") {
    return null;
  }
  if (observation.first_sse_event_ms === null) {
    observation.first_sse_event_ms = elapsedMs(now, startedAt);
  }
  const namedTerminal = namedSseTerminalEvent(event.event);
  if (event.event !== undefined && namedTerminal === null) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    throw new ResponseObservationError("response_observation_parse_failed", "response_parse");
  }
  if (!isJsonObject(parsed)) {
    throw new ResponseObservationError("response_observation_parse_failed", "response_parse");
  }
  const terminal = namedTerminal ?? terminalEventType(parsed);
  if (terminal === null || observation.terminal_event !== null) {
    return null;
  }
  observation.terminal_event = terminal;
  return captureResponseUsage(parsed);
}

function namedSseTerminalEvent(event: string | undefined): CodexTransportObservation["terminal_event"] {
  return event === "response.completed"
    || event === "response.failed"
    || event === "response.incomplete"
    || event === "error"
    ? event
    : null;
}

function terminalEventType(event: JsonObject): CodexTransportObservation["terminal_event"] {
  const type = event.type;
  return type === "response.completed" || type === "response.failed" || type === "response.incomplete" || type === "error"
    ? type
    : event.error
      ? "error"
      : null;
}

function captureResponseUsage(value: JsonObject): CapturedResponseUsage | null {
  const response = isJsonObject(value.response) ? value.response : value;
  const usageObject = isJsonObject(response.usage)
    ? response.usage
    : isJsonObject(value.usage)
      ? value.usage
      : null;
  const responseId = stringOrNull(response.id);
  const model = stringOrNull(response.model);
  if (responseId === null && model === null && usageObject === null) {
    return null;
  }
  return {
    response_id: responseId,
    model,
    usage: usageObject ? normalizeUsage(usageObject) : null
  };
}

function normalizeUsage(usage: JsonObject): CapturedProviderUsage {
  const inputDetails = isJsonObject(usage.input_tokens_details) ? usage.input_tokens_details : undefined;
  const outputDetails = isJsonObject(usage.output_tokens_details) ? usage.output_tokens_details : undefined;
  return {
    input_tokens: nonNegativeIntegerOrNull(usage.input_tokens),
    cached_input_tokens: nonNegativeIntegerOrNull(inputDetails?.cached_tokens ?? usage.cached_input_tokens),
    output_tokens: nonNegativeIntegerOrNull(usage.output_tokens),
    reasoning_tokens: nonNegativeIntegerOrNull(outputDetails?.reasoning_tokens ?? usage.reasoning_tokens),
    total_tokens: nonNegativeIntegerOrNull(usage.total_tokens),
    provider_cost_usd_ticks: nonNegativeIntegerOrNull(usage.cost_in_usd_ticks)
  };
}

function isJsonObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function nonNegativeIntegerOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function concatBytes(chunks: Uint8Array[], totalBytes: number): Uint8Array {
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

function elapsedMs(now: () => Date, startedAt: number): number {
  return Math.max(0, now().getTime() - startedAt);
}
