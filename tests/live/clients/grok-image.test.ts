import { join } from "node:path";
import { it } from "vitest";
import { createHome, expectOneImage, grokEnv, installGrok, run, selectGrokModel, writeGrokConfig } from "./run";

it("creates one Grok CLI image through Mini", async () => {
  const client = createHome("mini-grok-image-");
  try {
    const model = await selectGrokModel();
    installGrok(client);
    writeGrokConfig(client, model);
    run(join(client.home, ".grok/bin/grok"), [
      "--cwd",
      client.work,
      "--always-approve",
      "--disable-web-search",
      "--max-turns",
      "20",
      "--output-format",
      "json",
      "--verbatim",
      "-p",
      "Use the image_gen tool once to create one simple picture of a red circle on a white background. Do not use any other tool."
    ], { env: grokEnv(client), timeout: 1_500_000 });
    expectOneImage(join(client.grokHome, "sessions"));
  } finally {
    client.cleanup();
  }
}, 1_800_000);
