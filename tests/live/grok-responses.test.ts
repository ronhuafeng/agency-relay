import { it } from "vitest";
import { expectTerminal, languageModel, requireEnv, send } from "./runtime";

it("completes one Grok production response", async () => {
  const key = requireEnv("MINI_GROK_API_KEY");
  const model = await languageModel("https://grok.trustedtunnel.app", key);
  expectTerminal(await send("https://grok.trustedtunnel.app/v1/responses", key, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, input: "Reply exactly OK.", stream: false })
  }, 180_000));
}, 180_000);
