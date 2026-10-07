import babelParser from "@babel/eslint-parser";
import eslintPluginTailwindcss from "eslint-plugin-tailwindcss";
import visualStyle from "./scripts/eslint-visual-style.mjs";

const parserOptions = {
  requireConfigFile: false,
  babelOptions: {
    presets: ["@babel/preset-typescript", ["@babel/preset-react", { runtime: "automatic" }]],
  },
};

const tailwindSettings = {
  tailwindcss: {
    cssConfigPath: "src/admin/console.css",
    callees: ["cn", "cva"],
  },
};

export default [
  {
    files: ["src/admin/ui/**/*.tsx"],
    languageOptions: { parser: babelParser, parserOptions },
    plugins: { tailwindcss: eslintPluginTailwindcss, mini: visualStyle },
    settings: tailwindSettings,
    rules: {
      "tailwindcss/no-arbitrary-value": "error",
      "mini/visual-style": "error",
    },
  },
];
