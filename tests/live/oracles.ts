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
