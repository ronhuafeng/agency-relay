import { join } from "node:path";
import { it } from "vitest";
import { createHome, expectOneVideo, grokEnv, installGrok, run, selectGrokModel, writeGrokConfig } from "./run";

it("creates one Grok CLI video through Mini", async () => {
  const client = createHome("mini-grok-video-");
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
      "60",
      "--output-format",
      "json",
      "--verbatim",
      "-p",
      "Create one short video of a red circle on a white background. Use image generation once, then image-to-video once. Do not create a second video."
    ], { env: grokEnv(client), timeout: 7_000_000 });
    expectOneVideo(join(client.grokHome, "sessions"));
  } finally {
    client.cleanup();
  }
}, 7_200_000);
