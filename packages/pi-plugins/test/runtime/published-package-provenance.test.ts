import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  createVerifiedPiMcpRuntimeCandidate,
  PI_MCP_ADAPTER_RECEIPT,
} from "../../src/runtime/mcp/pi-mcp-adapter-package.js";
import { probePublishedPackage } from "../../src/runtime/published-package-receipt.js";
import {
  loadVerifiedPiSubagentsExtension,
  PI_SUBAGENTS_RECEIPT,
} from "../../src/runtime/subagents/pi-subagents-package.js";

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

  it("returns a structured verified MCP runtime candidate when the receipt and import are healthy", async () => {
    const candidate = await createVerifiedPiMcpRuntimeCandidate();
    expect(candidate.kind).toBe("verified");
    if (candidate.kind === "verified") {
      expect(candidate.adapter.runtime).toBeDefined();
      expect(candidate.adapter.extension).toBeTypeOf("function");
    }
  });

  it("loads the complete pi-subagents extension through the packaged peer-module bridge", async () => {
    // This crosses the real Jiti boundary rather than stopping at manifest
    // verification. A root-only virtual-module map can pass the receipt probe
    // while silently dropping the extension when it imports a Pi peer subpath.
    await expect(loadVerifiedPiSubagentsExtension()).resolves.toBeTypeOf("function");
  });
});
