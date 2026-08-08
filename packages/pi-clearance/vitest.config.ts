import { mkdirSync, mkdtempSync } from "node:fs";
import path from "node:path";
import { defineConfig } from "vitest/config";

// Tests that intentionally exercise config writers must never fall through to
// the developer's real platform config root. Keep the throwaway home under the
// ignored dependency cache—not the OS temp tree—because path-policy fixtures
// intentionally classify OS temp ahead of home and sensitive-home scopes.
const testHomeParent = path.join(process.cwd(), "node_modules", ".cache");
mkdirSync(testHomeParent, { recursive: true });
const testHome = mkdtempSync(
  path.join(testHomeParent, "pi-clearance-vitest-home-"),
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
