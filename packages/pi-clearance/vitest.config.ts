import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    root: "test",
    passWithNoTests: true,
    // Native-backed corpus/replay tests run several seconds under full-suite
    // load; the 5s default flakes in CI for no functional reason.
    testTimeout: 15000,
  },
});
