import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HOST, assertImage, assertVideo, call, codexLanguageModel, env, expectJson, grokGatewayModel, isRecord } from "../support";

export interface ClientHome {
  home: string;
  work: string;
  codexHome: string;
  grokHome: string;
  baseEnv: NodeJS.ProcessEnv;
  cleanup: () => void;
}

export function createHome(prefix: string): ClientHome {
  const home = mkdtempSync(join(tmpdir(), prefix));
  const work = join(home, "work");
  const codexHome = join(home, ".codex");
  const grokHome = join(home, ".grok");
  for (const dir of [work, codexHome, grokHome]) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  const baseEnv: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    CODEX_HOME: codexHome,
    GROK_HOME: grokHome,
    PATH: `${join(home, ".local/bin")}:${join(home, ".grok/bin")}:${process.env.PATH ?? ""}`
  };
  delete baseEnv.OPENAI_API_KEY;
  delete baseEnv.XAI_API_KEY;
  delete baseEnv.GROK_DEPLOYMENT_KEY;
  return {
    home,
    work,
    codexHome,
    grokHome,
    baseEnv,
    cleanup: () => rmSync(home, { recursive: true, force: true })
  };
}

export function run(command: string, args: string[], options: { cwd?: string; env: NodeJS.ProcessEnv; timeout: number }): string {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    timeout: options.timeout,
    encoding: "utf8"
  });
  if (result.error || result.status !== 0) {
    const code = (result.error as NodeJS.ErrnoException | undefined)?.code ?? "none";
    throw new Error(`Client process failed (status=${result.status ?? "none"}, signal=${result.signal ?? "none"}, code=${code})`);
  }
  return result.stdout;
}

/** Inspect JSONL in memory; never attach client output to an assertion failure. */
export function codexTaskSucceeded(output: string): boolean {
  let completed = false;
  let reply: unknown;
  try {
    for (const line of output.split("\n").filter(line => line.trim())) {
      const event: unknown = JSON.parse(line);
      if (!isRecord(event)) return false;
      if (event.type === "error" || event.type === "turn.failed") return false;
      if (event.type === "item.completed" && isRecord(event.item) && event.item.type === "agent_message") reply = event.item.text;
      if (event.type === "turn.completed") completed = true;
    }
  } catch {
    return false;
  }
  return completed && typeof reply === "string" && reply.trim() === "OK";
}

export function installCodex(client: ClientHome): void {
  run("bash", ["-lc", "curl -fsSL https://chatgpt.com/codex/install.sh | sh"], {
    env: client.baseEnv,
    timeout: 180_000
  });
  run(join(client.home, ".local/bin/codex"), ["--version"], { env: client.baseEnv, timeout: 60_000 });
}

export function installGrok(client: ClientHome): void {
  run("bash", ["-lc", "curl -fsSL https://x.ai/cli/install.sh | bash"], {
    env: client.baseEnv,
    timeout: 180_000
  });
  run(join(client.home, ".grok/bin/grok"), ["--version"], { env: client.baseEnv, timeout: 60_000 });
}

export async function selectGrokModel(): Promise<string> {
  const response = await call(`${HOST.grok}/v1/models`, env("MINI_GROK_API_KEY"));
  return grokGatewayModel(expectJson(response));
}

export function writeCodexConfig(client: ClientHome, model: string): void {
  const key = env("MINI_CODEX_API_KEY");
  writeFileSync(join(client.codexHome, "config.toml"), [
    `model = ${JSON.stringify(model)}`,
    'model_provider = "mini_codex"',
    'sandbox_mode = "read-only"',
    'approval_policy = "never"',
    "",
    "[model_providers.mini_codex]",
    'name = "Mini Codex"',
    'base_url = "https://api.trustedtunnel.app/v1"',
    'wire_api = "responses"',
    `experimental_bearer_token = ${JSON.stringify(key)}`,
    ""
  ].join("\n"), { mode: 0o600 });
}

export function writeGrokConfig(client: ClientHome, model: string): void {
  const key = env("MINI_GROK_API_KEY");
  writeFileSync(join(client.grokHome, "config.toml"), [
    "[cli]",
    "auto_update = false",
    "",
    "[endpoints]",
    'xai_api_base_url = "https://grok.trustedtunnel.app/v1"',
    "",
    "[models]",
    'default = "mini-live"',
    "",
    "[model.mini-live]",
    `model = ${JSON.stringify(model)}`,
    'base_url = "https://grok.trustedtunnel.app/v1"',
    'name = "Mini Grok"',
    'description = "Grok through Mini"',
    'api_backend = "responses"',
    `api_key = ${JSON.stringify(key)}`,
    ""
  ].join("\n"), { mode: 0o600 });
}

export function grokEnv(client: ClientHome): NodeJS.ProcessEnv {
  return { ...client.baseEnv, XAI_API_KEY: env("MINI_GROK_API_KEY") };
}

export async function codexModel(): Promise<string> {
  return codexLanguageModel(env("MINI_CODEX_API_KEY"));
}

export function sessionFiles(dir: string, accept: (name: string) => boolean): string[] {
  const found: string[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        walk(path);
      } else if (accept(entry.name)) {
        found.push(path);
      }
    }
  };
  walk(dir);
  return found;
}

export function expectOneImage(dir: string): void {
  const files = sessionFiles(dir, (name) => /\.(jpg|png|webp)$/i.test(name));
  if (files.length !== 1) {
    throw new Error(`image count ${files.length}`);
  }
  assertImage(readFileSync(files[0] ?? ""));
}

export function expectOneVideo(dir: string): void {
  const files = sessionFiles(dir, (name) => name.endsWith(".mp4"));
  if (files.length !== 1) {
    throw new Error(`video count ${files.length}`);
  }
  assertVideo(readFileSync(files[0] ?? ""));
}
