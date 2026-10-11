import { join } from "node:path";
import { expect, it } from "vitest";
import { createHome, grokEnv, installGrok, run, selectGrokModel, writeGrokConfig } from "./run";

it("completes a Grok CLI text reply through Agency Relay", async () => {
  const client = createHome("mini-grok-text-");
  try {
    const model = await selectGrokModel();
    installGrok(client);
    writeGrokConfig(client, model);
    const output = run(join(client.home, ".grok/bin/grok"), [
      "--cwd", client.work,
      "--disable-web-search",
      "--max-turns", "8",
      "--output-format", "json",
      "--verbatim",
      "-p", "Reply with the single word OK. Do not use tools."
    ], { env: grokEnv(client), timeout: 900_000 });
    // Official Grok CLI headless JSON includes real text and terminal stopReason.
    // A process exit code alone is not proof of a completed user task.
    const result: unknown = JSON.parse(output);
    expect(result).toMatchObject({
      text: expect.any(String),
      stopReason: expect.stringMatching(/^(end_turn|EndTurn)$/)
    });
    expect((result as { text: string }).text.trim()).toBe("OK");
  } finally {
    client.cleanup();
  }
}, 1_200_000);
