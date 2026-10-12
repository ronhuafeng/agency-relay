import { describe, expect, it } from "vitest";
import { expectTerminal } from "../live/runtime";
import { assertCompletedSse, assertResponseHasText, completedSseText, compactionItem } from "../live/oracles";

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
