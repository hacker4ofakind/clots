import { defineConfig } from "vitest/config";

// The web app has its own config (web/vitest.config.mts) and tests.
export default defineConfig({
  test: { include: ["tests/**/*.test.ts", "packages/*/tests/**/*.test.ts"], exclude: ["web/**", "node_modules/**"] },
});
