import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { defineConfig } from "vitest/config";

// Tests that intentionally exercise config writers must never fall through to
// the developer's real platform config root. Use one canonical throwaway home
// for the Vitest process; individual fixtures may still override it further.
const testHome = mkdtempSync(
  path.join(realpathSync(tmpdir()), "pi-clearance-vitest-home-"),
);

export default defineConfig({
  test: {
    root: "test",
    env: {
      HOME: testHome,
      USERPROFILE: testHome,
      XDG_CONFIG_HOME: path.join(testHome, ".config"),
      LOCALAPPDATA: path.join(testHome, "AppData", "Local"),
    },
    passWithNoTests: true,
    // Native-backed corpus/replay tests run several seconds under full-suite
    // load; the 5s default flakes in CI for no functional reason.
    testTimeout: 15000,
  },
});
