import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { alias: { "@": new URL("./src", import.meta.url).pathname } },
  test: {
    environment: "node",
    include: ["tests/live/**/*.test.ts"],
    fileParallelism: true,
    sequence: {
      concurrent: false
    },
    testTimeout: 180_000,
    hookTimeout: 60_000
  }
});
