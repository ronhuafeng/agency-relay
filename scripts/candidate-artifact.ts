import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const roots = ["src/console/generated", "dist/worker", "worker-configuration.d.ts", "wrangler.jsonc",
  "deploy/codex-egress-shim/server.mjs", "deploy/codex-egress-shim/node-transport-adapter.mjs",
  "deploy/codex-egress-shim/transport-lifecycle.mjs", "deploy/codex-egress-shim/egress-protocol.json"];
export interface Candidate {
  sha: string;
  tree: string;
  files: Record<string, string>;
}
function files(root: string, path: string): string[] {
  const stat = lstatSync(join(root, path));
  if (stat.isSymbolicLink()) throw new Error("Candidate contains a symlink");
  if (stat.isDirectory()) return readdirSync(join(root, path)).sort().flatMap(name => files(root, `${path}/${name}`));
  if (!stat.isFile()) throw new Error("Candidate contains a non-file");
  return [path];
}
function inventory(root: string): Record<string, string> {
  return Object.fromEntries(roots.flatMap(path => files(root, path)).sort().map(path =>
    [path, createHash("sha256").update(readFileSync(join(root, path))).digest("hex")]));
}
export function sealCandidate(root: string, sha: string, tree: string): Candidate {
  if (!/^[a-f0-9]{40}$/.test(sha) || !/^[a-f0-9]{40}$/.test(tree)) throw new Error("Invalid source identity");
  const candidate = { sha, tree, files: inventory(root) };
  if (!candidate.files["dist/worker/index.js"]) throw new Error("Missing Worker bundle");
  return candidate;
}
export function verifyCandidate(root: string, candidate: Candidate, sha: string, tree: string): void {
  const actual = sealCandidate(root, sha, tree);
  if (candidate.sha !== sha || candidate.tree !== tree) throw new Error("Candidate source identity mismatch");
  const expected = Object.entries(candidate.files).sort();
  if (JSON.stringify(expected) !== JSON.stringify(Object.entries(actual.files).sort())) throw new Error("Candidate file inventory or digest mismatch");
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const git = (ref: string) => execFileSync("git", ["rev-parse", ref], { encoding: "utf8" }).trim();
  const sha = git("HEAD"), tree = git("HEAD^{tree}");
  if (process.argv[2] === "seal") {
    execFileSync("git", ["diff", "--exit-code", "HEAD"], { stdio: "pipe" });
    writeFileSync("candidate.json", JSON.stringify(sealCandidate(".", sha, tree), null, 2) + "\n");
  } else if (process.argv[2] === "verify") {
    verifyCandidate(".", JSON.parse(readFileSync("candidate.json", "utf8")), sha, tree);
  } else throw new Error("Expected seal or verify");
}
