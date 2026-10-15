import { describe, expect, it } from "vitest";
import { assertJsonShape, expectTerminal, fetchLive, providerUrl, withCleanup } from "../live/runtime";
import { assertCompletedSse, assertPcmAudio, assertResponseHasText, assertTokenization, assertTranscript, completedSseText, compactionItem, compactOutput, SocketOutcome, waveAudio } from "../live/oracles";

describe("Live Responses success oracle", () => {
  const response = (status: string) => ({
    status: 200,
    contentType: "application/json",
    text: JSON.stringify({ status })
  });

  it("accepts a completed provider response", () => {
    expect(() => expectTerminal(response("completed"))).not.toThrow();
  });

  it.each(["incomplete", "failed", "cancelled", "canceled", "queued", "in_progress"])(
    "never reports %s as a completed task",
    (status) => {
      expect(() => expectTerminal(response(status))).toThrow();
    }
  );

  it("requires HTTP 200 and JSON, not merely a completed-looking payload", () => {
    expect(() => expectTerminal({ ...response("completed"), status: 401 })).toThrow();
    expect(() => expectTerminal({ ...response("completed"), contentType: "text/plain" })).toThrow();
  });

  it("does not attach provider content to a failed terminal assertion", () => {
    const privateValue = "SYNTHETIC_PRIVATE_PROVIDER_CONTENT";
    let failure: unknown;
    try {
      expectTerminal(response(privateValue));
    } catch (error) {
      failure = error;
    }
    expect(failure instanceof Error).toBe(true);
    const record = failure as Record<string, unknown>;
    const serialized = JSON.stringify(Object.fromEntries(Object.getOwnPropertyNames(record).map(name => [name, record[name]])));
    expect(serialized.includes(privateValue)).toBe(false);
  });
});

it("checks live JSON shape without attaching a newly issued key to failure evidence", () => {
  expect(() => assertJsonShape({ key: { id: "synthetic" }, api_key: "synthetic", extra: true }, {
    key: { id: expect.any(String) }, api_key: expect.any(String)
  })).not.toThrow();
  const privateValue = "SYNTHETIC_NEW_KEY";
  let failure: unknown;
  try {
    assertJsonShape({ api_key: privateValue }, { key: { id: expect.any(String) }, api_key: expect.any(String) });
  } catch (error) {
    failure = error;
  }
  expect(failure instanceof Error).toBe(true);
  const record = failure as Record<string, unknown>;
  expect(JSON.stringify(Object.fromEntries(Object.getOwnPropertyNames(record).map(name => [name, record[name]]))).includes(privateValue)).toBe(false);
});

it("does not retain private URLs in parse failures", () => {
  try {
    providerUrl("SYNTHETIC_PRIVATE_URL");
    expect.fail("invalid URL accepted");
  } catch (error) {
    expect(error).toEqual(new Error("provider URL rejected"));
    expect(Object.hasOwn(error as object, "input")).toBe(false);
  }
});

it("does not retain external request failures or their causes", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("SYNTHETIC_PRIVATE_URL", { cause: "SYNTHETIC_PRIVATE_SECRET" }); };
  try {
    await expect(fetchLive("https://example.invalid")).rejects.toEqual(new Error("live HTTP transport failed"));
  } finally {
    globalThis.fetch = original;
  }
});

it("retains task failure and still performs every cleanup without exposing cleanup payload", async () => {
  const primary = new Error("synthetic primary failure");
  let second = false;
  let failure: unknown;
  try {
    await withCleanup(async () => { throw primary; }, [
      { message: "first cleanup failed", run: async () => { throw new Error("SYNTHETIC_PRIVATE_CLEANUP_BODY"); } },
      { message: "second cleanup failed", run: async () => { second = true; } }
    ]);
  } catch (error) { failure = error; }
  expect(second).toBe(true);
  expect(failure).toBeInstanceOf(AggregateError);
  expect((failure as AggregateError).errors).toEqual([primary, new Error("first cleanup failed")]);
});

describe("Live compaction result oracle", () => {
  const item = { type: "compaction", id: "synthetic-compaction", encrypted_content: "synthetic-opaque-content" };
  const event = (type: string, payload: unknown) => `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`;
  const completed = (output: unknown[] = [], status = "completed") => event("response.completed", { response: { status, output } });

  it("accepts an item completed in-stream even when final output is empty", () => {
    expect(compactionItem(event("response.output_item.done", { item }) + completed())).toEqual(item);
  });

  it("accepts the equivalent final-output representation without rebuilding opaque content", () => {
    expect(compactionItem(completed([item]))).toEqual(item);
  });

  it("accepts data-only event types and ignores unrelated SSE keepalive frames", () => {
    const text = "event: heartbeat\ndata: alive\n\n"
      + `data: ${JSON.stringify({ type: "response.output_item.done", item })}\n\n`
      + `data: ${JSON.stringify({ type: "response.completed", response: { status: "completed", output: [] } })}\n\n`;
    expect(compactionItem(text)).toEqual(item);
  });

  it("rejects trigger-only, empty encrypted content, incomplete and failed streams", () => {
    expect(() => compactionItem(event("response.compaction.compacting", {}) + completed())).toThrow();
    expect(() => compactionItem(completed([{ ...item, encrypted_content: "" }]))).toThrow();
    expect(() => compactionItem(event("response.output_item.done", { item }))).toThrow();
    expect(() => compactionItem(completed([item], "failed"))).toThrow();
    expect(() => compactionItem(event("response.failed", {}) + completed([item]))).toThrow();
  });

  it("extracts continuation text from deltas or final output under the same completion guard", () => {
    expect(completedSseText(event("response.output_text.delta", { delta: "known-fact" }) + completed())).toBe("known-fact");
    expect(completedSseText(completed([{ type: "message", content: [{ type: "output_text", text: "known-fact" }] }]))).toBe("known-fact");
    expect(() => completedSseText(event("response.output_text.delta", { delta: "known-fact" }))).toThrow();
  });
});

describe("Live SSE and output oracles", () => {
  const sse = (status: string, delta = "OK") => [
    "event: response.output_text.delta",
    "data: " + JSON.stringify({ delta }),
    "",
    "event: response.completed",
    "data: " + JSON.stringify({ response: { status, output: [] } }),
    "",
    ""
  ].join("\n");

  it("accepts a completed stream with model text", () => {
    expect(() => assertCompletedSse(sse("completed"))).not.toThrow();
  });

  it("rejects missing completion, unsuccessful terminal state, or absent text", () => {
    expect(() => assertCompletedSse("event: response.created\ndata: {}\n\n")).toThrow();
    expect(() => assertCompletedSse(sse("failed"))).toThrow();
    expect(() => assertCompletedSse(sse("completed", ""))).toThrow();
    expect(() => assertCompletedSse("event: response.failed\ndata: {}\n\n" + sse("completed"))).toThrow();
  });

  it("rejects completed JSON responses without generated output text", () => {
    expect(() => assertResponseHasText({ status: "completed", output: [] })).toThrow();
    expect(() => assertResponseHasText({
      status: "completed",
      output: [{ type: "message", content: [{ type: "output_text", text: "OK" }] }]
    })).not.toThrow();
  });
});

describe("Live speech and compact result contracts", () => {
  const wave = () => {
    const bytes = Buffer.alloc(48);
    bytes.write("RIFF", 0); bytes.writeUInt32LE(40, 4); bytes.write("WAVEfmt ", 8);
    bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
    bytes.writeUInt32LE(16000, 24); bytes.writeUInt32LE(32000, 28);
    bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34);
    bytes.write("data", 36); bytes.writeUInt32LE(4, 40); bytes.writeInt16LE(123, 44);
    return bytes;
  };
  it("requires actual PCM audio, not an empty, silent or truncated WAV", () => {
    expect(waveAudio(wave()).pcm.length).toBe(4);
    expect(() => waveAudio(wave().subarray(0, 46))).toThrow();
    const empty = wave(); empty.writeUInt32LE(36, 4); empty.writeUInt32LE(0, 40);
    expect(() => waveAudio(empty.subarray(0, 44))).toThrow();
    expect(() => assertPcmAudio(Buffer.alloc(4))).toThrow();
    expect(() => assertPcmAudio(Buffer.from([1]))).toThrow();
    expect(() => assertPcmAudio(Buffer.from([1, 0]))).not.toThrow();
  });
  it("reads observed streaming data-size placeholders without accepting ordinary truncation", () => {
    for (const placeholder of [0x7fffffff, 0xffffffff]) {
      const bytes = wave();
      bytes.writeUInt32LE(placeholder, 40);
      expect(waveAudio(bytes).pcm).toEqual(bytes.subarray(44));
      expect(() => waveAudio(bytes.subarray(0, 44))).toThrow();
    }
    const truncated = wave();
    truncated.writeUInt32LE(8, 40);
    expect(() => waveAudio(truncated)).toThrow();
  });
  it("matches known spoken words while tolerating punctuation, case and whitespace", () => {
    expect(() => assertTranscript({ text: "AGENCY,  relay voice probe!" }, "Agency relay voice probe.")).not.toThrow();
    for (const body of [{}, { text: "" }, { text: "unrelated words" }]) {
      expect(() => assertTranscript(body, "Agency relay voice probe.")).toThrow();
    }
    expect(() => assertTranscript({ text: "broken" }, "OK")).toThrow();
    expect(() => assertTranscript({ text: "The verification word is `a1b2c3`." }, "a1b2c3")).not.toThrow();
    expect(() => assertTranscript({ text: "xa1b2c3y" }, "a1b2c3")).toThrow();
  });
  it("keeps the complete compact output unchanged, rejecting empty or absent opaque content", () => {
    const output = [{ type: "message", unknown: true }, { type: "compaction", encrypted_content: "synthetic-opaque" }];
    expect(compactOutput({ output })).toBe(output);
    expect(() => compactOutput({ output: [] })).toThrow();
    expect(() => compactOutput({ output: [{ type: "compaction", encrypted_content: "" }] })).toThrow();
  });
});

it("requires actual tokenization, accepting equivalent token splits without fixed ids", () => {
  const token = (text: string, id: number) => ({ token_id: id, string_token: text, token_bytes: [...Buffer.from(text)] });
  expect(() => assertTokenization({ token_ids: [token("OK", 17)] }, "OK")).not.toThrow();
  expect(() => assertTokenization({ token_ids: [token("O", 100), token("K", 200)] }, "OK")).not.toThrow();
  for (const body of [{}, { token_ids: [] }, { token_ids: [token("wrong", 17)] }, { token_ids: [{ ...token("OK", 17), token_bytes: [999] }] }]) {
    expect(() => assertTokenization(body, "OK")).toThrow("tokenization result mismatch");
  }
});

describe("Live WebSocket terminal outcomes", () => {
  const audio = Buffer.from([1, 0]).toString("base64");
  it("requires text and a successful Responses terminal, accepting both text carriers", () => {
    expect(() => new SocketOutcome("responses").observe({ type: "response.completed", response: { status: "completed", output: [] } })).toThrow();
    const deltas = new SocketOutcome("responses");
    expect(deltas.observe({ type: "response.output_text.delta", delta: "OK" })).toBe(false);
    expect(deltas.observe({ type: "response.completed", response: { status: "completed", output: [] } })).toBe(true);
    const final = new SocketOutcome("responses");
    expect(final.observe({ type: "response.completed", response: { status: "completed", output_text: "OK" } })).toBe(true);
    expect(() => new SocketOutcome("responses").observe({ type: "response.completed", response: { status: "failed", output_text: "OK" } })).toThrow();
  });
  it("rejects TTS completion without audio and STT completion without the spoken words", () => {
    expect(() => new SocketOutcome("tts").observe({ type: "audio.done" })).toThrow();
    const tts = new SocketOutcome("tts");
    tts.observe({ type: "audio.delta", delta: audio });
    expect(tts.observe({ type: "audio.done" })).toBe(true);
    expect(() => new SocketOutcome("stt", "agency relay").observe({ type: "transcript.done", text: "" })).toThrow();
    expect(new SocketOutcome("stt", "agency relay").observe({ type: "transcript.done", text: "Agency Relay." })).toBe(true);
  });
  it("accepts a locked STT transcript only when the same session completes", () => {
    const stt = new SocketOutcome("stt", "agency relay");
    expect(stt.observe({ type: "transcript.partial", is_final: true, text: "Agency Relay." })).toBe(false);
    expect(stt.observe({ type: "transcript.done", text: "" })).toBe(true);
  });
  it("rejects unlocked, wrong or separately split STT phrases even after completion", () => {
    const cases = [
      [{ type: "transcript.partial", is_final: false, text: "Agency Relay." }],
      [{ type: "transcript.partial", is_final: "true", text: "Agency Relay." }],
      [{ type: "transcript.partial", is_final: true, text: "unrelated words" }],
      [{ type: "transcript.partial", is_final: true, text: "Agency" },
        { type: "transcript.partial", is_final: true, text: "Relay" }]
    ];
    for (const events of cases) {
      const stt = new SocketOutcome("stt", "agency relay");
      for (const event of events) expect(stt.observe(event)).toBe(false);
      expect(() => stt.observe({ type: "transcript.done", text: "" })).toThrow("spoken fixture transcript mismatch");
    }
  });
  it("does not turn a locked STT match into success before completion or after an error", () => {
    const stt = new SocketOutcome("stt", "agency relay");
    expect(stt.observe({ type: "transcript.partial", is_final: true, text: "Agency Relay." })).toBe(false);
    expect(stt.observe({ type: "transcript.created" })).toBe(false);
    expect(() => stt.observe({ type: "error", message: "SYNTHETIC_PRIVATE_TRANSCRIPT" })).toThrow("provider WebSocket operation failed");
  });
  it.each(["response.audio.delta", "response.output_audio.delta"])("accepts documented voice audio %s only with transcript and completion", type => {
    const voice = new SocketOutcome("voice", "OK");
    voice.observe({ type, delta: audio });
    voice.observe({ type: "response.output_audio_transcript.delta", delta: "OK." });
    expect(voice.observe({ type: "response.done" })).toBe(true);
    expect(() => new SocketOutcome("voice", "OK").observe({ type: "response.done" })).toThrow();
  });
  it("rejects provider errors without retaining their private payload", () => {
    const secret = "SYNTHETIC_PRIVATE_SOCKET_CONTENT";
    expect(() => new SocketOutcome("voice").observe({ type: "error", message: secret })).toThrow("provider WebSocket operation failed");
    expect(() => new SocketOutcome("tts").observe({ type: "audio.delta", delta: "invalid***" })).toThrow();
  });
  it("does not combine different response identities into one successful turn", () => {
    const result = new SocketOutcome("responses");
    result.observe({ type: "response.created", response: { id: "first" } });
    result.observe({ type: "response.created", response: { id: "other" } });
    result.observe({ type: "response.output_text.delta", response_id: "other", delta: "OK" });
    expect(result.observe({ type: "response.completed", response: { id: "other", status: "completed", output_text: "OK" } })).toBe(false);
    expect(() => result.observe({ type: "response.completed", response: { id: "first", status: "completed", output: [] } })).toThrow();
  });
  it("accepts PCM samples split across audio chunks, but rejects an explicitly failed voice result", () => {
    const result = new SocketOutcome("tts");
    result.observe({ type: "audio.delta", delta: Buffer.from([1]).toString("base64") });
    result.observe({ type: "audio.delta", delta: Buffer.from([0]).toString("base64") });
    expect(result.observe({ type: "audio.done" })).toBe(true);
    const voice = new SocketOutcome("voice", "OK");
    voice.observe({ type: "response.audio.delta", delta: audio });
    voice.observe({ type: "response.audio_transcript.delta", delta: "OK" });
    expect(() => voice.observe({ type: "response.done", response: { status: "failed" } })).toThrow();
  });
});
