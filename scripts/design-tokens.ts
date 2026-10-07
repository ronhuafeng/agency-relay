import { readFileSync } from "node:fs";
import { lint } from "@google/design.md/linter";
import { build, defineConfig, parse, type TokenNormalized, type TokenNormalizedSet } from "@terrazzo/parser";
import css from "@terrazzo/plugin-css";

const spaceNames: Record<string, string> = {
  micro: "space-1",
  related: "space-2",
  compact: "space-3",
  content: "space-4",
  section: "space-section",
  page: "space-5",
  wide: "space-6",
};

function variableName(token: TokenNormalized): string {
  if (token.id.startsWith("color.")) return token.id.slice("color.".length);
  if (token.id.startsWith("space.")) return spaceNames[token.id.slice("space.".length)] ?? token.id.replaceAll(".", "-");
  if (token.id === "rounded.control") return "radius";
  if (token.id === "font.sans") return "font-family-sans";
  if (token.id === "font.mono") return "font-family-mono";
  if (token.id === "shadow.pixel") return "shadow-soft";
  if (token.id === "control.target") return "control-target";
  return token.id.replaceAll(".", "-");
}

function cssValue(token: TokenNormalized): string | undefined {
  if (token.$type === "color") {
    const hex = token.$value.hex;
    if (!hex || !/^#[0-9a-f]{6}$/.test(hex)) throw new Error(`Color ${token.id} did not resolve to a 6-digit sRGB hex.`);
    return hex;
  }
  if (token.$type === "shadow") {
    const shadow = Array.isArray(token.$value) ? token.$value[0] : token.$value;
    if (!shadow) throw new Error(`Shadow ${token.id} did not resolve.`);
    return `${shadow.offsetX.value}px ${shadow.offsetY.value}px 0 var(--pixel)`;
  }
  return undefined;
}

const config = defineConfig({
  plugins: [css({
    filename: "tokens.css",
    // The plugin also uses this name in aliases, where the CSS -- prefix is required.
    variableName: (token) => `--${variableName(token)}`,
    transform: cssValue,
    permutations: [
      {
        input: { theme: "light" },
        prepare: (contents) => `:root {\n  color-scheme: light dark;\n${contents}\n}\n`,
      },
      {
        input: { theme: "dark" },
        prepare: (contents) => `@media (prefers-color-scheme: dark) {\n  :root {\n${contents}\n  }\n}\n`,
      },
    ],
  })],
}, { cwd: new URL("../", import.meta.url) });

function hex(tokens: TokenNormalizedSet, id: string): string {
  const token = tokens[id];
  if (!token || token.$type !== "color" || !token.$value.hex) throw new Error(`Missing resolved color ${id}.`);
  return token.$value.hex;
}

function dimension(tokens: TokenNormalizedSet, id: string): string {
  const token = tokens[id];
  if (!token || token.$type !== "dimension") throw new Error(`Missing resolved dimension ${id}.`);
  return `${token.$value.value}${token.$value.unit}`;
}

function fontFamily(families: string | readonly string[]): string {
  const generic = new Set(["serif", "sans-serif", "monospace", "cursive", "fantasy", "system-ui", "ui-serif", "ui-sans-serif", "ui-monospace", "ui-rounded", "emoji", "math", "fangsong"]);
  return (typeof families === "string" ? [families] : families).map((name) => generic.has(name) || /^[A-Za-z]+$/.test(name) ? name : `"${name}"`).join(", ");
}

function typography(tokens: TokenNormalizedSet, id: string): string {
  const token = tokens[id];
  if (!token || token.$type !== "typography") throw new Error(`Missing resolved typography ${id}.`);
  const value = token.$value;
  const size = value.fontSize;
  if (!size || typeof value.fontWeight !== "number" || typeof value.lineHeight !== "number") {
    throw new Error(`Typography ${id} is missing font size, weight or line height.`);
  }
  return [
    `    fontFamily: '${fontFamily(value.fontFamily)}'`,
    `    fontSize: ${size.value}${size.unit}`,
    `    fontWeight: ${value.fontWeight}`,
    `    lineHeight: ${value.lineHeight}`,
  ].join("\n");
}

function frontmatter(light: TokenNormalizedSet, dark: TokenNormalizedSet): string {
  const color = (name: string, id = name) => `  ${name}: "${hex(light, `color.${id}`)}"`;
  const darkColor = (name: string, id = name) => `  dark-${name}: "${hex(dark, `color.${id}`)}"`;
  const target = dimension(light, "control.target");
  const content = dimension(light, "space.content");
  const menu = dimension(light, "control.menu");
  const divider = dimension(light, "control.divider");
  const button = (name: string, background: string, text: string) => [
    `  ${name}:`,
    `    backgroundColor: "${background}"`,
    `    textColor: "${text}"`,
    name.endsWith("-dark") ? "" : `    typography: "{typography.label}"`,
    `    rounded: "{rounded.control}"`,
    `    height: ${target}`,
  ].filter(Boolean).join("\n");
  return `---
version: alpha
name: Agency Relay Console
description: Cyan pixel workspaces with cool light surfaces, deep indigo dark surfaces and crisp task boundaries.
colors:
${color("primary")}
${color("on-primary", "primary-foreground")}
${color("background")}
${color("surface", "card")}
${color("on-surface", "foreground")}
${color("muted", "muted-foreground")}
${color("border")}
${color("input-border", "input")}
${color("secondary")}
${color("accent")}
${color("success", "ok")}
${color("warning", "warn")}
${color("error", "destructive")}
${color("on-error", "destructive-foreground")}
${darkColor("primary")}
${darkColor("on-primary", "primary-foreground")}
${darkColor("background")}
${darkColor("surface", "card")}
${darkColor("on-surface", "foreground")}
${darkColor("muted", "muted-foreground")}
${darkColor("border")}
${darkColor("input-border", "input")}
${darkColor("secondary")}
${darkColor("accent")}
${darkColor("success", "ok")}
${darkColor("warning", "warn")}
${darkColor("error", "destructive")}
${darkColor("on-error", "destructive-foreground")}
typography:
  page-title:
${typography(light, "typography.page-title")}
  section-title:
${typography(light, "typography.section-title")}
  body:
${typography(light, "typography.body")}
  label:
${typography(light, "typography.label")}
  caption:
${typography(light, "typography.caption")}
  input-phone:
${typography(light, "typography.input-phone")}
  technical:
${typography(light, "typography.technical")}
rounded:
  none: ${dimension(light, "rounded.none")}
  control: ${dimension(light, "rounded.control")}
  container: ${dimension(light, "rounded.container")}
spacing:
  micro: ${dimension(light, "space.micro")}
  related: ${dimension(light, "space.related")}
  compact: ${dimension(light, "space.compact")}
  content: ${content}
  section: ${dimension(light, "space.section")}
  page: ${dimension(light, "space.page")}
  wide: ${dimension(light, "space.wide")}
components:
${button("button-primary", "{colors.primary}", "{colors.on-primary}")}
${button("button-secondary", "{colors.surface}", "{colors.on-surface}")}
  button-destructive:
    backgroundColor: "{colors.error}"
    textColor: "{colors.on-error}"
    rounded: "{rounded.control}"
    height: ${target}
  task-card:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.on-surface}"
    rounded: "{rounded.container}"
    padding: ${content}
  selected-row:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.on-surface}"
  account-menu:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.on-surface}"
    rounded: "{rounded.container}"
    width: ${menu}
  caption:
    textColor: "{colors.muted}"
    typography: "{typography.caption}"
  divider:
    backgroundColor: "{colors.border}"
    height: ${divider}
  badge-success:
    textColor: "{colors.success}"
  badge-warning:
    textColor: "{colors.warning}"
${button("button-primary-dark", "{colors.dark-primary}", "{colors.dark-on-primary}")}
${button("button-secondary-dark", "{colors.dark-surface}", "{colors.dark-on-surface}")}
${button("button-destructive-dark", "{colors.dark-error}", "{colors.dark-on-error}")}
  page-dark:
    backgroundColor: "{colors.dark-background}"
    textColor: "{colors.dark-on-surface}"
  badge-dark:
    backgroundColor: "{colors.dark-secondary}"
    textColor: "{colors.dark-muted}"
  badge-success-dark:
    textColor: "{colors.dark-success}"
  badge-warning-dark:
    textColor: "{colors.dark-warning}"
  selected-row-dark:
    backgroundColor: "{colors.dark-accent}"
    textColor: "{colors.dark-on-surface}"
  divider-dark:
    backgroundColor: "{colors.dark-border}"
    height: ${divider}
---
`;
}

function designBody(source: string): string {
  const close = source.indexOf("\n---\n", 4);
  if (!source.startsWith("---\n") || close < 0) throw new Error("design.md frontmatter is missing.");
  return source.slice(close + "\n---\n".length);
}

function lintDesignMd(contents: string): void {
  const report = lint(contents);
  if (report.summary.errors > 0) {
    const errors = report.findings.filter((finding) => finding.severity === "error").map((finding) => finding.message);
    throw new Error(`design.md lint reported errors:\n${errors.join("\n")}`);
  }
}

export interface DesignTokenProjection {
  readonly css: string;
  readonly designMd: string;
  readonly theme: {
    readonly light: { readonly background: string; readonly card: string };
    readonly dark: { readonly background: string; readonly card: string };
  };
}

export async function projectDesignTokens(designMdSource: string, filename = new URL("../tokens/console.resolver.json", import.meta.url)): Promise<DesignTokenProjection> {
  const parsed = await parse([{ filename, src: readFileSync(filename, "utf8") }], { config });
  if (!parsed.resolver) throw new Error("Console token resolver did not load.");
  const light = parsed.resolver.apply({ theme: "light" });
  const dark = parsed.resolver.apply({ theme: "dark" });
  const built = await build(light, { resolver: parsed.resolver, sources: parsed.sources, config });
  const file = built.outputFiles.find((entry) => String(entry.filename).endsWith("tokens.css"));
  if (!file) throw new Error("Terrazzo did not generate tokens.css.");
  const theme = {
    light: { background: hex(light, "color.background"), card: hex(light, "color.card") },
    dark: { background: hex(dark, "color.background"), card: hex(dark, "color.card") },
  };
  const designMd = `${frontmatter(light, dark)}${designBody(designMdSource)}`;
  lintDesignMd(designMd);
  return { css: String(file.contents).replace(/^--/gm, "  --"), designMd, theme };
}
