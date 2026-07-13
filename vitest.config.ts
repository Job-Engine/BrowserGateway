import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    passWithNoTests: true,
    testTimeout: 120_000,
    hookTimeout: 120_000,
    coverage: {
      provider: "v8",
      include: ["src/gateway/**"],
      // server.ts is the composition root: pure wiring, smoke-tested end to
      // end via the compiled build; excluded from the unit coverage gate.
      exclude: ["src/gateway/server.ts"],
      thresholds: {
        statements: 80,
        lines: 80,
        functions: 80,
      },
    },
  },
});
