import { describe, expect, it } from "vitest";
import { expectTerminal } from "../live/runtime";

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
