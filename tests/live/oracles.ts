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

/** A completed SSE frame must be observed, with actual model text produced. */
export function assertCompletedSse(text: string): void {
  const events = text.split(/\r?\n\r?\n/).flatMap((block) => {
    const lines = block.split(/\r?\n/);
    const event = lines.find((line) => line.startsWith("event:"))?.slice(6).trim();
    const data = lines.filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim()).join("\n");
    return event ? [{ event, data }] : [];
  });
  if (events.some((e) => ["error", "response.failed", "response.incomplete"].includes(e.event))) {
    throw new Error("provider SSE stream failed");
  }
  const completed = [...events].reverse().find((e) => e.event === "response.completed");
  if (!completed) throw new Error("provider SSE stream missing completed event");
  let payload: unknown;
  try { payload = JSON.parse(completed.data) as unknown; }
  catch { throw new Error("completed SSE payload is not JSON"); }
  const result = isRecord(payload) ? payload.response : undefined;
  if (!isRecord(result) || result.status !== "completed") {
    throw new Error("provider SSE terminal status is not completed");
  }
  const streamedText = events.some((e) => {
    if (e.event !== "response.output_text.delta" || !e.data) return false;
    try {
      const data: unknown = JSON.parse(e.data);
      return isRecord(data) && typeof data.delta === "string" && data.delta.length > 0;
    } catch { return false; }
  });
  if (!streamedText && !responseText(result).trim()) throw new Error("completed SSE had no model output");
}
