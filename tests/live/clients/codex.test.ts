import { join } from "node:path";
import { expect, it } from "vitest";
import { codexModel, codexTaskSucceeded, createHome, installCodex, run, writeCodexConfig } from "./run";

it("completes a Codex CLI reply through Mini", async () => {
  const client = createHome("mini-codex-");
  try {
    const model = await codexModel();
    installCodex(client);
    writeCodexConfig(client, model);
    const output = run(join(client.home, ".local/bin/codex"), [
      "exec",
      "--json",
      "--skip-git-repo-check",
      "--sandbox",
      "read-only",
      "Reply with the single word OK. Do not use tools or write files."
    ], { cwd: client.work, env: client.baseEnv, timeout: 900_000 });
    expect(codexTaskSucceeded(output)).toBe(true);
  } finally {
    client.cleanup();
  }
}, 1_200_000);
