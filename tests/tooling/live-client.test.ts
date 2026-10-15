import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { codexInstallerEnv, codexTaskSucceeded, createHome, run } from "../live/clients/run";

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

it("does not inherit unrelated CI/provider credentials into third-party client environments", () => {
  const client = createHome("mini-env-check-");
  try {
    expect(Object.keys(client.baseEnv).some((name) => name.startsWith("MINI_"))).toBe(false);
    expect(client.baseEnv.OPENAI_API_KEY).toBeUndefined();
    expect(client.baseEnv.XAI_API_KEY).toBeUndefined();
    expect(client.baseEnv.HOME).toBe(client.home);
  } finally {
    client.cleanup();
  }
});

it("uses native curl transfer controls without a fixed download deadline", async () => {
  const client = createHome("agency-download-check-");
  const server = createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "application/octet-stream" });
    response.write("a".repeat(1024));
    const timer = setInterval(() => response.write("b".repeat(1024)), 100);
    const end = setTimeout(() => response.end(), 1_200);
    response.on("close", () => { clearInterval(timer); clearTimeout(end); });
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test listener missing");
    const args = ["-fsS", `http://127.0.0.1:${address.port}`];
    writeFileSync(join(client.home, ".curlrc"), "max-time = 1\n", { mode: 0o600 });
    // Same continuing transfer fails under a wall-clock deadline.
    await expect(promisify(execFile)("curl", args, { env: client.baseEnv, timeout: 5_000 })).rejects.toMatchObject({ code: 28 });
    const result = await promisify(execFile)("curl", args, {
      env: codexInstallerEnv(client), timeout: 5_000
    });
    expect(result.stdout.length).toBeGreaterThan(1024);
  } finally {
    server.closeAllConnections();
    if (server.listening) {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
    client.cleanup();
  }
});
