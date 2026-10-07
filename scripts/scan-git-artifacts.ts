import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export function isDisallowedArtifactPath(path: string): boolean {
  const parts = path.split(/[\\/]/);
  const name = parts.at(-1) ?? "";
  const isSharedCodexConfig = parts.length === 2
    && parts[0] === ".codex"
    && name === "config.toml";
  if (parts.includes("node_modules")
    || parts.includes(".wrangler")
    || (parts.includes(".codex") && !isSharedCodexConfig)
    || parts.includes("local-secrets")) {
    return true;
  }
  return name === "auth.json"
    || name === "worker-secret.json"
    || name === "password.txt"
    || name === "cloudflare-gateway-token.txt"
    || name.endsWith(".pem")
    || name.endsWith(".key")
    || name === ".dev.vars"
    || name.startsWith(".dev.vars.")
    || name === ".env"
    || (name.startsWith(".env.") && name !== ".env.example");
}

function gitVisiblePaths(root: string): string[] {
  try {
    return execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    }).split("\0").filter(Boolean);
  } catch (error) {
    throw new Error("Unable to list Git-visible paths", { cause: error });
  }
}

function main(): void {
  const root = process.cwd();
  const disallowed = gitVisiblePaths(root).filter(isDisallowedArtifactPath);
  if (disallowed.length > 0) {
    console.error("Disallowed Git-visible artifact paths found:");
    for (const path of disallowed) {
      console.error(`- ${path}`);
    }
    process.exitCode = 1;
    return;
  }
  console.log("No disallowed Git-visible artifact paths found.");
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(resolve(entry)).href) {
  main();
}
