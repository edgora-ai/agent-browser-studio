import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Fast suite: unit + smoke + the core e2e journey. Deep journeys (j1-j4) run
    // under vitest.config.e2e.ts via `npm run test:e2e`.
    include: [
      "tests/unit/**/*.test.ts",
      "tests/smoke/**/*.test.ts",
      "tests/e2e/journey.test.ts",
    ],
    exclude: ["node_modules", "dist", "tests/e2e/j[1-4]-*.test.ts"],
    globals: true,
    environment: "node",
    deps: {
      inline: [/scripts\/release-manifest/],
    },
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov", "html"],
      reportsDirectory: "coverage",
      include: ["src/main/services/**", "src/main/ipc/**"],
      exclude: ["src/tools/**", "src/main/services/__tests__/**"],
      thresholds: {
        statements: 40,
        branches: 35,
        functions: 40,
        lines: 40,
      },
    },
  },
});
