import { readFileSync } from "node:fs";
import tokenPolicy, { directThemeAliases } from "./scripts/stylelint-token-policy.mjs";

function declarations(path) {
  return [...readFileSync(path, "utf8").matchAll(/(?:^|[^\w-])(--[a-z0-9-]+)\s*:\s*([^;}{]+)/g)]
    .map((match) => [match[1], match[2].trim()]);
}

const tokens = [...new Set(declarations("src/admin/generated/tokens.css").map(([property]) => property))];
const authored = [
  ...declarations("src/admin/console.css"),
  ...declarations("src/admin/console-layout.css"),
  ...declarations("src/admin/ui/components/primitives.css"),
].filter(([property]) => !tokens.includes(property));
const authoredProperties = directThemeAliases(authored, new Set(tokens));
const aliases = authoredProperties.aliases;
const structural = authoredProperties.structural;

export default {
  plugins: [tokenPolicy],
  // Generated tokens are owned by console:check. This config lints authored styles.
  ignoreFiles: ["src/admin/generated/**"],
  rules: {
    "color-no-hex": true,
    "mini/token-policy": {
      tokens,
      aliases,
      structural,
      runtime: ["--dashboard-scroll-inset", "--sidebar-width", "--sidebar-width-icon"],
    },
  },
};
