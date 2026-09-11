import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    // Corpus is loaded via tests/unit/postgres-live-certification.test.ts so
    // `vitest run` (npm test) does not execute the suite twice.
    exclude: ["**/node_modules/**", "**/dist/**", "tests/certification/**"],
    testTimeout: 30000,
  },
});
