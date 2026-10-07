import { expect, it } from "vitest";
import { codexTaskSucceeded, run } from "../live/clients/run";

it("reports process failure metadata without command arguments or client output", () => {
  const marker = "SYNTHETIC_PRIVATE_CLIENT_CONTENT";
  let message = "";
  try {
    run(process.execPath, ["-e", `process.stdout.write('${marker}'); process.stderr.write('${marker}'); process.exit(2)`], {env: process.env, timeout: 5_000});
  } catch (error) { message = (error as Error).message; }
  expect(message.includes(marker)).toBe(false);
  expect(message).toContain("status=2");
});

it("requires the expected reply and a completed turn instead of a successful process alone", () => {
  const empty = run(process.execPath, ["-e", ""], {env: process.env, timeout: 5_000});
  expect(codexTaskSucceeded(empty)).toBe(false);
  const reply = {type: "item.completed", item: {type: "agent_message", text: "OK"}};
  const transcript = (...events: unknown[]) => events.map(event => JSON.stringify(event)).join("\n");
  expect(codexTaskSucceeded(transcript(reply))).toBe(false);
  expect(codexTaskSucceeded(transcript(reply, {type: "turn.failed"}))).toBe(false);
  expect(codexTaskSucceeded(transcript({...reply, item: {...reply.item, text: "Unexpected reply"}}, {type: "turn.completed"}))).toBe(false);
  expect(codexTaskSucceeded(transcript(reply, {type: "turn.completed"}))).toBe(true);
});
