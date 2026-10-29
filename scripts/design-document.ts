import { readFileSync, writeFileSync } from "node:fs";
import { projectDesignTokens } from "./design-tokens";

const mode = process.argv[2];
if (mode !== "update" && mode !== "check") throw new Error("Expected update or check.");
const source = readFileSync("design.md", "utf8");
const { designMd } = await projectDesignTokens(source);
if (mode === "update") writeFileSync("design.md", designMd);
else if (source !== designMd) throw new Error("design.md is stale. Run pnpm design:update and review the projection.");
