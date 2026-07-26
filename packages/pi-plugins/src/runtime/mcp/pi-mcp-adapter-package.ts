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
  license: "MIT",
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
