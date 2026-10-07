import { defineConfig } from "@playwright/test";

// Suppress teardown DOM snapshots. Locator matcher diagnostics have a separate
// snapshot path: secret-result checks must assert only scalar values (see gates.md).
process.env.PLAYWRIGHT_NO_COPY_PROMPT = "1";

export default defineConfig({
  testDir: "./tests/browser",
  testMatch: "**/*.spec.ts",
  outputDir: "tmp/browser-results",
  timeout: 30_000,
  expect: { timeout: 5_000 },
  fullyParallel: true,
  workers: 1,
  retries: 0,
  forbidOnly: Boolean(process.env.CI),
  // Even local synthetic keys and sessions are usable authority: never record them.
  use: { trace: "off", video: "off", screenshot: "off", viewport: { width: 1440, height: 1000 } },
  reporter: [["list"], ["html", { outputFolder: "tmp/browser-report", open: "never" }]],
  projects: [{ name: "chromium", use: { browserName: "chromium" } }, { name: "webkit", use: { browserName: "webkit" } }]
});
