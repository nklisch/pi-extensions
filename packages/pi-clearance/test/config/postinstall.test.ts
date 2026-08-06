import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import type { ConfigRepairReport } from "../../src/config/persistence.ts";
import { isDirectExecution, main } from "../../src/config/postinstall.ts";

const modulePath = fileURLToPath(
  new URL("../../src/config/postinstall.ts", import.meta.url),
);

function reportWithError(): ConfigRepairReport {
  return {
    userConfigRoot: "/isolated/config",
    results: [],
    errors: [
      {
        path: "/isolated/config/global.json",
        kind: "global",
        message: "permission denied",
      },
    ],
  };
}

function reportWithSkippedSymlink(): ConfigRepairReport {
  return {
    userConfigRoot: "/isolated/config",
    results: [
      {
        path: "/isolated/config/global.json",
        kind: "global",
        action: "skipped-symlink",
      },
    ],
    errors: [],
  };
}

describe("postinstall entrypoint", () => {
  it("fails visibly when an existing config cannot be repaired", async () => {
    const warning = vi
      .spyOn(console, "warn")
      .mockImplementation(() => undefined);

    await expect(main(async () => reportWithError())).rejects.toThrow(
      "Pi Clearance install repair failed for 1 existing config file.",
    );
    expect(warning).toHaveBeenCalledWith(
      "Pi Clearance could not repair /isolated/config/global.json: permission denied",
    );

    warning.mockRestore();
  });

  it("warns about deliberate symlink skips without failing installation", async () => {
    const warning = vi
      .spyOn(console, "warn")
      .mockImplementation(() => undefined);

    await expect(main(async () => reportWithSkippedSymlink())).resolves.toBeUndefined();
    expect(warning).toHaveBeenCalledWith(
      "Pi Clearance skipped symlinked config path /isolated/config/global.json; install repair does not follow or replace symlinks.",
    );

    warning.mockRestore();
  });

  it("recognizes a relative argv path for direct execution", () => {
    expect(
      isDirectExecution(path.relative(process.cwd(), modulePath), modulePath),
    ).toBe(true);
    expect(isDirectExecution(`${modulePath}.other`, modulePath)).toBe(false);
  });
});
