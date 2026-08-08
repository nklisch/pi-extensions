import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { defineConfig } from "vitest/config";

const canonicalTmp = realpathSync(tmpdir());

export default defineConfig({
  test: {
    environment: "node",
    env: { TMPDIR: canonicalTmp, TMP: canonicalTmp, TEMP: canonicalTmp },
    globals: true,
    include: ["tests/**/*.test.ts"],
    passWithNoTests: true,
  },
});
