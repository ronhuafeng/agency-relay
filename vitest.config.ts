import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": new URL("./src", import.meta.url).pathname,
      "cloudflare:workers": new URL("./tests/shims/cloudflare-workers.ts", import.meta.url).pathname
    }
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    exclude: ["tests/live/**", "**/node_modules/**", "**/dist/**"]
  }
});
