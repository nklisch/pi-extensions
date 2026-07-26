import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PI_MCP_ADAPTER_RECEIPT } from "../../src/runtime/mcp/pi-mcp-adapter-package.js";
import { probePublishedPackage } from "../../src/runtime/published-package-receipt.js";
import { PI_SUBAGENTS_RECEIPT } from "../../src/runtime/subagents/pi-subagents-package.js";

const checkout = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const repoRoot = resolve(checkout, "../..");

async function siblingManifest(packageName: string): Promise<any> {
  const directory = packageName.replace("@nklisch/", "");
  return JSON.parse(await readFile(resolve(repoRoot, "packages", directory, "package.json"), "utf8"));
}

async function ownManifest(): Promise<any> {
  return JSON.parse(await readFile(resolve(checkout, "package.json"), "utf8"));
}

describe("runtime sibling contract", () => {
  it.each([
    [PI_MCP_ADAPTER_RECEIPT, "@nklisch/pi-mcp-adapter/programmatic"],
    [PI_SUBAGENTS_RECEIPT, "@nklisch/pi-subagents"],
  ] as const)("%s moves in sync with the workspace sibling", async (receipt, entrySpecifier) => {
    // Sync invariant: the receipt version, the dependency pin, and the
    // sibling's workspace version are one value. Bump one without the others
    // and this test goes red.
    const sibling = await siblingManifest(receipt.packageName);
    expect(sibling.version).toBe(receipt.version);
    const own = await ownManifest();
    expect(own.dependencies?.[receipt.packageName]).toBe(receipt.version);

    // Manifest-shape contract: the sibling presents exactly what the runtime
    // loader requires.
    expect(sibling).toMatchObject({
      name: receipt.packageName,
      license: receipt.license,
      engines: { node: receipt.nodeEngine },
      peerDependencies: { "@earendil-works/pi-coding-agent": receipt.piPeerRange },
    });

    // Load gate: resolution + shape verification succeed from source.
    const result = await probePublishedPackage({
      entrySpecifier,
      receipt,
      signal: new AbortController().signal,
    });
    expect(result.kind).toBe("verified");
  });
});
