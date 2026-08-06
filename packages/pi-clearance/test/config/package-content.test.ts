import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const packageDirectory = fileURLToPath(new URL("../../", import.meta.url));
const packScript = fileURLToPath(
  new URL("../../../../scripts/pack-package.mjs", import.meta.url),
);

describe("pi-clearance package contents", () => {
  it("ships the npm postinstall entrypoint", () => {
    const manifest = JSON.parse(
      readFileSync(`${packageDirectory}/package.json`, "utf8"),
    ) as {
      readonly engines?: { readonly node?: string };
      readonly scripts?: { readonly postinstall?: string };
    };
    expect(manifest.engines?.node).toBe(">=22.18");
    expect(manifest.scripts?.postinstall).toContain(
      "src/config/postinstall.ts",
    );

    const report = JSON.parse(
      execFileSync(
        process.execPath,
        [packScript, packageDirectory, "--dry-run"],
        { encoding: "utf8" },
      ),
    ) as readonly { readonly files?: readonly { readonly path: string }[] }[];
    const files = report[0]?.files?.map((file) => file.path) ?? [];
    for (const file of [
      "src/config/postinstall.ts",
      "src/config/persistence.ts",
      "src/config/paths.ts",
      "src/config/schema.ts",
      "src/config/defaults.ts",
      "src/config/gated-tools.ts",
    ]) {
      expect(files).toContain(file);
    }
  });
});
