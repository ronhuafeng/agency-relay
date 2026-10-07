import { describe, expect, it } from "vitest";
import {
  MAX_PENDING_SSE_BUFFER_BYTES,
  MAX_SSE_EVENT_BYTES,
  SseDecoder,
  SseDecoderError
} from "../../src/proxy/sse-decoder";

const encoder = new TextEncoder();

describe("SseDecoder", () => {
  it("decodes LF and CRLF events, optional event names, comments, empty data, and multiple data lines", () => {
    const decoder = new SseDecoder();
    const events = decoder.push(encoder.encode([
      ": comment\r\n",
      "event: response.output_text.delta\r\n",
      "data: first\r\n",
      "data: second\r\n",
      "\r\n",
      "data:\n",
      "\n",
      "data: [DONE]\n",
      "\n"
    ].join("")));

    expect(events).toEqual([
      { event: "response.output_text.delta", data: "first\nsecond" },
      { data: "" },
      { data: "[DONE]" }
    ]);
  });

  it("decodes UTF-8 and delimiters split at every byte boundary", () => {
    const wire = encoder.encode("event: message\r\ndata: 跨界🙂\r\n\r\n");
    for (let split = 0; split <= wire.length; split += 1) {
      const decoder = new SseDecoder();
      const events = [
        ...decoder.push(wire.slice(0, split)),
        ...decoder.push(wire.slice(split)),
        ...decoder.finish()
      ];
      expect(events, `split=${split}`).toEqual([{ event: "message", data: "跨界🙂" }]);
    }
  });

  it("handles one-byte chunks, multiple events per chunk, and EOF without a blank line", () => {
    const decoder = new SseDecoder();
    const wire = encoder.encode("data: one\n\ndata: two\n\ndata: tail");
    const events = [];
    for (const byte of wire) {
      events.push(...decoder.push(Uint8Array.of(byte)));
    }
    events.push(...decoder.finish());
    expect(events).toEqual([{ data: "one" }, { data: "two" }, { data: "tail" }]);
  });

  it("handles a 64 KiB chunk without retaining completed events", () => {
    const decoder = new SseDecoder();
    const data = "x".repeat(64 * 1024 - 16);
    const events = decoder.push(encoder.encode(`data: ${data}\n\n`));
    expect(events).toEqual([{ data }]);
    expect(decoder.finish()).toEqual([]);
  });

  it("rejects a delimiter-free pending line above 1 MiB", () => {
    const decoder = new SseDecoder();
    expect(() => decoder.push(new Uint8Array(MAX_PENDING_SSE_BUFFER_BYTES + 1).fill(97))).toThrowError(
      expect.objectContaining({ code: "malformed_upstream_sse" }) as SseDecoderError
    );
  });

  it("rejects a single event above 16 MiB while allowing bounded complete lines", () => {
    const decoder = new SseDecoder();
    const line = encoder.encode(`data: ${"x".repeat(MAX_PENDING_SSE_BUFFER_BYTES - 16)}\n`);
    expect(line.byteLength).toBeLessThanOrEqual(MAX_PENDING_SSE_BUFFER_BYTES);
    let thrown: unknown;
    try {
      while (true) {
        decoder.push(line);
      }
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({ code: "oversized_upstream_event" });
    expect((thrown as SseDecoderError).eventBytes).toBeGreaterThan(MAX_SSE_EVENT_BYTES);
  });
});
