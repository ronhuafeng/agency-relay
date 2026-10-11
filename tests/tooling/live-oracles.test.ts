import { describe, expect, it } from "vitest";
import { expectTerminal } from "../live/runtime";
import { assertCompletedSse, assertResponseHasText } from "../live/oracles";

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
