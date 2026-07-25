import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PI_MCP_ADAPTER_RECEIPT } from "../../src/runtime/mcp/pi-mcp-adapter-package.js";
import { digestPublishedPackageTree, probePublishedPackage } from "../../src/runtime/published-package-receipt.js";
import { PI_SUBAGENTS_RECEIPT } from "../../src/runtime/subagents/pi-subagents-package.js";

const checkout = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

async function lock(): Promise<any> {
  return JSON.parse(await readFile(resolve(checkout, "package-lock.json"), "utf8"));
}

describe("published runtime provenance", () => {
  it.each([
    [PI_MCP_ADAPTER_RECEIPT, "@nklisch/pi-mcp-adapter/programmatic"],
    [PI_SUBAGENTS_RECEIPT, "@nklisch/pi-subagents"],
  ] as const)("binds %s registry SRI to exact installed package-owned bytes", async (receipt, entrySpecifier) => {
    const metadata = await lock();
    const locked = metadata.packages[`node_modules/${receipt.packageName}`];
    expect(locked).toMatchObject({
      version: receipt.version,
      integrity: receipt.registryIntegrity,
      license: receipt.license,
      engines: { node: receipt.nodeEngine },
      peerDependencies: { "@earendil-works/pi-coding-agent": receipt.piPeerRange },
    });
    const result = await probePublishedPackage({
      entrySpecifier,
      receipt,
      signal: new AbortController().signal,
    });
    expect(result.kind).toBe("verified");
    if (result.kind === "verified") {
      await expect(digestPublishedPackageTree(result.packageRoot)).resolves.toBe(receipt.installedTreeDigest);
    }
  });
});
