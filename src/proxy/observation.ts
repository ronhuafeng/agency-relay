import { Readable } from "node:stream";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";
import { copyBytes } from "./byte-stream";
import { isRecord, nonNegativeIntegerOrNull } from "../records";
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

export function noteObservedUsage(observation: CodexTransportObservation, usage: CapturedResponseUsage | null): void {
  observation.usage_captured = usage?.usage !== null && usage?.usage !== undefined;
  observation.observation_status = "ok";
  observation.observation_error_code = null;
}

export function noteObservationParseFailure(observation: CodexTransportObservation, error: unknown): void {
  observation.observation_status = "error";
  if (error instanceof ResponseObservationError) {
    observation.observation_error_code = error.code;
    observation.observation_stage = error.stage;
  } else {
    observation.observation_error_code = "response_observation_parse_failed";
    observation.observation_stage = "response_parse";
  }
}

/** Copies response bytes for observation and closes when the queue cannot take the next chunk. */
export class ResponseObservationTap {
  readonly stream: ReadableStream<Uint8Array>;
  private controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  private stopped = false;

  constructor() {
    this.stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        this.controller = controller;
      },
      cancel: () => {
        this.stopped = true;
      }
    }, new ByteLengthQueuingStrategy({ highWaterMark: MAX_RESPONSE_OBSERVATION_LAG_BYTES }));
  }

  push(chunk: Uint8Array): void {
    if (this.stopped || !this.controller) return;
    if ((this.controller.desiredSize ?? 0) < chunk.byteLength) {
      this.fail(new ResponseObservationError("response_observation_limit", "response_body"));
      return;
    }
    this.controller.enqueue(chunk);
  }

  end(): void {
    if (this.stopped || !this.controller) return;
    this.stopped = true;
    this.controller.close();
  }

  stop(): void {
    if (this.stopped || !this.controller) return;
    this.stopped = true;
    this.controller.close();
  }

  fail(error: unknown): void {
    if (this.stopped || !this.controller) return;
    this.stopped = true;
    this.controller.error(error);
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

function observationParseFailed(): ResponseObservationError {
  return new ResponseObservationError("response_observation_parse_failed", "response_parse");
}

function throwIfClientAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new ResponseObservationError("client_request_aborted", "response_body");
  }
}

function parseObservationRecord(text: string): JsonObject {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = null;
  }
  if (!isRecord(parsed)) {
    throw observationParseFailed();
  }
  return parsed;
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
    throwIfClientAborted(signal);
    if (error instanceof ResponseObservationError) {
      throw error;
    }
    if (error instanceof SseDecoderError) {
      throw new ResponseObservationError("response_observation_limit", "response_parse");
    }
    throw observationParseFailed();
  }

  throwIfClientAborted(signal);
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
    throwIfClientAborted(signal);
    if (error instanceof ResponseObservationError) {
      throw error;
    }
    throw observationParseFailed();
  }
  throwIfClientAborted(signal);
  if (totalBytes === 0) {
    throw new ResponseObservationError("response_observation_premature_eof", "response_body");
  }

  const parsed = parseObservationRecord(new TextDecoder().decode(concatBytes(chunks, totalBytes)));
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
    throwIfClientAborted(signal);
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
    throwIfClientAborted(signal);
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
  const parsed = parseObservationRecord(data);
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
  const response = isRecord(value.response) ? value.response : value;
  const usageObject = isRecord(response.usage)
    ? response.usage
    : isRecord(value.usage)
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
  const inputDetails = isRecord(usage.input_tokens_details) ? usage.input_tokens_details : undefined;
  const outputDetails = isRecord(usage.output_tokens_details) ? usage.output_tokens_details : undefined;
  const cacheWrites = nonNegativeIntegerOrNull(inputDetails?.cache_write_tokens);
  return {
    input_tokens: nonNegativeIntegerOrNull(usage.input_tokens),
    cached_input_tokens: nonNegativeIntegerOrNull(inputDetails?.cached_tokens ?? usage.cached_input_tokens),
    ...(cacheWrites !== null ? { cache_write_input_tokens: cacheWrites } : {}),
    output_tokens: nonNegativeIntegerOrNull(usage.output_tokens),
    reasoning_tokens: nonNegativeIntegerOrNull(outputDetails?.reasoning_tokens ?? usage.reasoning_tokens),
    total_tokens: nonNegativeIntegerOrNull(usage.total_tokens),
    provider_cost_usd_ticks: nonNegativeIntegerOrNull(usage.cost_in_usd_ticks)
  };
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function concatBytes(chunks: Uint8Array[], totalBytes: number): Uint8Array {
  if (chunks.length === 1) return chunks[0];
  return copyBytes(chunks, totalBytes);
}

function elapsedMs(now: () => Date, startedAt: number): number {
  return Math.max(0, now().getTime() - startedAt);
}
