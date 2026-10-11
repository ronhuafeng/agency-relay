import { it } from "vitest";
import { HOST, call, expectJson } from "./support";

it("answers health checks as JSON", async () => {
  for (const origin of [HOST.codex, HOST.grok, HOST.xai]) {
    expectJson(await call(`${origin}/healthz`, undefined));
  }
});
