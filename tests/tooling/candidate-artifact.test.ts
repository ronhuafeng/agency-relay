import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, it } from "vitest";
import { sealCandidate, verifyCandidate } from "../../scripts/candidate-artifact";

it("binds all shipped bytes to the candidate source and rejects tampering, missing and extra files", () => {
  const directory = mkdtempSync(join(tmpdir(), "candidate-"));
  const sha = "1".repeat(40), tree = "2".repeat(40);
  const put = (path: string, value = "fixture") => { mkdirSync(dirname(join(directory, path)), { recursive: true }); writeFileSync(join(directory, path), value); };
  try {
    for (const path of ["src/console/generated/client.ts", "dist/worker/index.js", "worker-configuration.d.ts", "wrangler.jsonc",
      "deploy/codex-egress-shim/server.mjs", "deploy/codex-egress-shim/node-transport-adapter.mjs", "deploy/codex-egress-shim/transport-lifecycle.mjs", "deploy/codex-egress-shim/egress-protocol.json"]) put(path);
    const candidate = sealCandidate(directory, sha, tree);
    expect(() => verifyCandidate(directory, candidate, sha, tree)).not.toThrow();
    expect(() => verifyCandidate(directory, candidate, "3".repeat(40), tree)).toThrow("identity mismatch");
    expect(() => verifyCandidate(directory, candidate, sha, "3".repeat(40))).toThrow("identity mismatch");
    put("dist/worker/index.js", "altered");
    expect(() => verifyCandidate(directory, candidate, sha, tree)).toThrow("digest mismatch");
    put("dist/worker/index.js");
    put("dist/worker/unexpected.js");
    expect(() => verifyCandidate(directory, candidate, sha, tree)).toThrow("inventory");
    rmSync(join(directory, "dist/worker/unexpected.js"));
    rmSync(join(directory, "dist/worker/index.js"));
    expect(() => verifyCandidate(directory, candidate, sha, tree)).toThrow("Missing Worker");
    symlinkSync(join(directory, "wrangler.jsonc"), join(directory, "dist/worker/index.js"));
    expect(() => verifyCandidate(directory, candidate, sha, tree)).toThrow("symlink");
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
