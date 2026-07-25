import type { McpAdapterInstance, McpAdapterOptions } from "@nklisch/pi-mcp-adapter/programmatic";
import {
  probePublishedPackage,
  type PublishedPackageReceipt,
} from "../published-package-receipt.js";
import {
  createPiMcpRuntime,
  type PiMcpRuntimeAdapter,
} from "./pi-mcp-adapter-runtime.js";

export const PI_MCP_ADAPTER_RECEIPT: PublishedPackageReceipt = Object.freeze({
  packageName: "@nklisch/pi-mcp-adapter",
  version: "2.11.0-nklisch.3",
  registryIntegrity: "sha512-keVNCjw0ZldLr5p6TwB3UvM9dHc9SwhCHbSQQOvdR+nhMFRua2lHdAG3nMqmr9CK1torEd8e5PX3ZyptXXhmbQ==",
  installedTreeDigest: "sha256:de900313591f7e68767e881b8c35aa081a12da692c879e6ca77112e6755c9f7c",
  license: "MIT",
  licenseSha256: "2d20dfacd9742706e564470dc77438608a1e54b0ed46959f080709389209093c",
  releaseTag: "v2.11.0-nklisch.3@edc0ffa77dde0ee70455ee8bf72f43ee4a313f89",
  releaseCommit: "111d79f7d292e928315c5cade586798ef395158a",
  upstreamBaseCommit: "82724dccc13a49310530898f922bafff12b7f3fe",
  nodeEngine: ">=22.19.0",
  piPeerRange: ">=0.79.1 <1",
  requiredExports: [".", "./programmatic"],
  piExtensions: ["./index.ts"],
});

type ProgrammaticModule = Readonly<{
  createMcpAdapter(options: McpAdapterOptions): McpAdapterInstance;
}>;

function programmaticModule(value: unknown): ProgrammaticModule | undefined {
  if (value === null || typeof value !== "object" ||
      typeof (value as { createMcpAdapter?: unknown }).createMcpAdapter !== "function") return undefined;
  return value as ProgrammaticModule;
}

/** Verify exact local bytes before evaluating the documented programmatic export. */
export async function createVerifiedPiMcpRuntimeCandidate(
  signal: AbortSignal = new AbortController().signal,
): Promise<PiMcpRuntimeAdapter | undefined> {
  const probe = await probePublishedPackage({
    entrySpecifier: "@nklisch/pi-mcp-adapter/programmatic",
    receipt: PI_MCP_ADAPTER_RECEIPT,
    signal,
  });
  if (probe.kind !== "verified") return undefined;
  signal.throwIfAborted();
  try {
    const module = programmaticModule(await import(probe.entry));
    if (module === undefined) return undefined;
    return createPiMcpRuntime({
      packageFactory: module.createMcpAdapter,
      initialSources: [],
      fileDiscovery: "disabled",
    });
  } catch {
    if (signal.aborted) throw signal.reason;
    return undefined;
  }
}
