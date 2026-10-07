import { defineConfig } from "@playwright/test";

// An explicit diagnostic, independent of the native correctness/visual CI suite.
process.env.PLAYWRIGHT_NO_COPY_PROMPT = "1";
export default defineConfig({
  testDir: "./tests/performance", testMatch: "**/*.spec.ts",
  outputDir: "tmp/console-performance", reporter: [["list"]],
  workers: 1, fullyParallel: false, retries: 0, timeout: 180_000,
  forbidOnly: Boolean(process.env.CI),
  use: { trace: "off", video: "off", screenshot: "off", browserName: "chromium" }
});
