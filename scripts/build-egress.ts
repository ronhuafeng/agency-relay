import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const root = process.cwd();
const egressDirectory = path.join(root, "deploy", "codex-egress-shim");
const sources = ["transport-lifecycle.ts", "node-transport-adapter.ts"] as const;
const checkOnly = process.argv.includes("--check");
// TypeScript 7 ships no compiler API. Its tsc emit matches the previous transpile.
const tsc = path.join(root, "node_modules", "typescript", "bin", "tsc");

function compile(sourceNames: readonly string[]): Map<string, string> {
  const directory = mkdtempSync(path.join(tmpdir(), "egress-tsc-"));
  const outDir = path.join(directory, "out");
  try {
    writeFileSync(path.join(directory, "tsconfig.json"), JSON.stringify({
      compilerOptions: {
        target: "ES2022",
        module: "ESNext",
        moduleResolution: "Bundler",
        resolveJsonModule: true,
        strict: false,
        skipLibCheck: true,
        declaration: false,
        sourceMap: false,
        removeComments: false,
        types: ["node"],
        typeRoots: [path.join(root, "node_modules", "@types")],
        rootDir: egressDirectory,
        outDir
      },
      files: sourceNames.map((sourceName) => path.join(egressDirectory, sourceName))
    }));
    const result = spawnSync(process.execPath, [tsc, "-p", path.join(directory, "tsconfig.json"), "--pretty", "false"], {
      encoding: "utf8"
    });
    if (result.error !== undefined || result.status !== 0) {
      throw new Error(`Unable to transpile egress sources\n${result.stdout ?? ""}${result.stderr ?? ""}${result.error?.message ?? ""}`);
    }
    return new Map(sourceNames.map((sourceName) => {
      const outputName = sourceName.replace(/\.ts$/, ".js");
      const outputText = readFileSync(path.join(outDir, outputName), "utf8");
      return [
        sourceName,
        `// Generated from ${sourceName} by pnpm run egress:build. Do not edit directly.\n${outputText}`
      ];
    }));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

const compiled = compile(sources);
let stale = false;
for (const sourceName of sources) {
  const expected = compiled.get(sourceName);
  if (expected === undefined) {
    throw new Error(`Missing transpiled output for ${sourceName}`);
  }
  const outputPath = path.join(egressDirectory, sourceName.replace(/\.ts$/, ".mjs"));
  if (checkOnly) {
    const actual = readFileSync(outputPath, "utf8");
    if (actual !== expected) {
      stale = true;
      process.stderr.write(`${path.relative(root, outputPath)} is stale\n`);
    }
  } else {
    writeFileSync(outputPath, expected);
  }
}

if (stale) process.exitCode = 1;
