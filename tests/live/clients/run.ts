import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildClientSetupFiles } from "../../../src/admin/client-setup";
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
  // Isolated child environment: production operator and unrelated Provider
  // secrets must never reach third-party installers or external CLI processes.
  const baseEnv = {
    CI: process.env.CI,
    LANG: process.env.LANG,
    USER: process.env.USER,
    SHELL: process.env.SHELL,
    TMPDIR: process.env.TMPDIR,
    HOME: home,
    CODEX_HOME: codexHome,
    GROK_HOME: grokHome,
    PATH: `${join(home, ".local/bin")}:${join(home, ".grok/bin")}:${process.env.PATH ?? ""}`
  } as unknown as NodeJS.ProcessEnv;
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

const CLIENT_SCOPES = ["surface:codex:production", "surface:grok:production", "surface:xai:production"] as const;

function setupContent(client: "codex" | "grok" | "xai", key: string, models?: { codex?: string; grok?: string }): string {
  const file = buildClientSetupFiles({ token: key, scopes: CLIENT_SCOPES, models }).find((item) => item.client === client);
  if (!file) throw new Error(`Missing ${client} client setup`);
  return file.content;
}

function replaceOnce(content: string, from: string, to: string): string {
  if (!content.includes(from)) throw new Error("Client setup template no longer matches the live script");
  return content.replace(from, to);
}

export function writeCodexConfig(client: ClientHome, model: string): void {
  const content = replaceOnce(
    setupContent("codex", env("MINI_CODEX_API_KEY"), { codex: model }),
    'model_provider = "mini_codex"\n',
    'model_provider = "mini_codex"\nsandbox_mode = "read-only"\napproval_policy = "never"\n'
  );
  writeFileSync(join(client.codexHome, "config.toml"), content, { mode: 0o600 });
}

export function writeGrokConfig(client: ClientHome, model: string): void {
  const content = replaceOnce(
    setupContent("grok", env("MINI_GROK_API_KEY"), { grok: model })
      .replaceAll('default = "mini-grok-4-7"', 'default = "agency-grok"')
      .replaceAll("[model.mini-grok-4-7]", "[model.agency-grok]"),
    "\n[endpoints]\n",
    "\n[cli]\nauto_update = false\n\n[endpoints]\n"
  );
  writeFileSync(join(client.grokHome, "config.toml"), content, { mode: 0o600 });
}

export function writeXaiEnv(client: ClientHome): void {
  writeFileSync(join(client.home, "xai-api.env"), setupContent("xai", env("MINI_XAI_API_KEY")), { mode: 0o600 });
}

/** Grok CLI reads XAI_API_KEY, but this value is the Grok surface key, not the xAI API key. */
export function grokEnv(client: ClientHome): NodeJS.ProcessEnv {
  return { ...client.baseEnv, XAI_API_KEY: env("MINI_GROK_API_KEY") };
}

export function xaiEnv(client: ClientHome): NodeJS.ProcessEnv {
  return {
    ...client.baseEnv,
    XAI_API_KEY: env("MINI_XAI_API_KEY"),
    XAI_BASE_URL: "https://xai.trustedtunnel.app/v1"
  };
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
