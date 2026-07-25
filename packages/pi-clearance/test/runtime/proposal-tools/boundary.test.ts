import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const sourceRoot = path.resolve(process.cwd(), "src");

async function source(relativePath: string): Promise<string> {
  return readFile(path.join(sourceRoot, relativePath), "utf8");
}

describe("proposal writer boundary", () => {
  it("keeps writer imports and call sites in the apply engine", async () => {
    const propose = await source("runtime/proposal-tools/propose.ts");
    const present = await source("runtime/proposal-tools/present.ts");
    const applyEngine = await source("runtime/proposal-tools/apply-engine.ts");
    const writerImports = /config-command-writer|enablement-command/;

    expect(propose).not.toMatch(writerImports);
    expect(propose).not.toMatch(
      /apply(?:ConfigCommandPlan|PackEnablementCommand)/,
    );
    expect(present).not.toMatch(writerImports);
    expect(present).not.toMatch(
      /apply(?:ConfigCommandPlan|PackEnablementCommand)/,
    );
    expect(applyEngine).toMatch(/defaultApplyConfigCommandPlan/);
    expect(applyEngine).toMatch(/defaultApplyPackEnablementCommand/);
  });

  it("does not expose the deleted per-proposal tool id", async () => {
    const ids = await source("runtime/ratchet-tools/ids.ts");
    expect(ids).not.toContain("present_proposal");
  });
});
