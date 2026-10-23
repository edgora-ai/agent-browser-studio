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
    // A hung test used to stall a CI job until its whole-job timeout killed it,
    // with no indication of which test hung (observed on the Windows runner:
    // 70 minutes of silence after the last completed file). A global deadline
    // turns that into a named failure. It sits above the longest explicit
    // per-test budget in the suite (120 s) so it never cuts healthy work short.
    testTimeout: 180_000,
    hookTimeout: 180_000,
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
