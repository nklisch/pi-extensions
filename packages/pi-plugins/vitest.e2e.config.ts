import { defineConfig } from "vitest/config";

// CI sets PI_PLUGIN_HOST_E2E_TIMEOUT_SCALE=2 because runners are far slower
// than dev machines. Every harness wait honors it; vitest's own test/hook
// timeouts must scale too, otherwise consistently slow-but-passing tests
// (e.g. ~140 s against a 120 s budget) straddle the line by runner luck.
const timeoutScale = Number(process.env.PI_PLUGIN_HOST_E2E_TIMEOUT_SCALE ?? 1);

export default defineConfig({
  test: {
    include: ["test/e2e/**/*.e2e.test.ts"],
    globalSetup: ["test/e2e/global-setup.ts"],
    fileParallelism: false,
    maxWorkers: 1,
    isolate: false,
    testTimeout: 120_000 * timeoutScale,
    hookTimeout: 120_000 * timeoutScale,
    typecheck: {
      enabled: true,
      tsconfig: "./tsconfig.test.json",
    },
  },
});
