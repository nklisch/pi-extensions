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
  version: "2.21.0-nklisch.1",
  license: "MIT",
  nodeEngine: ">=22.19.0",
  piPeerRange: ">=0.82.0 <1",
  requiredExports: [".", "./programmatic"],
  piExtensions: ["./index.ts"],
});

type ProgrammaticModule = Readonly<{
  createMcpAdapter(options: McpAdapterOptions): McpAdapterInstance;
}>;

export type PiMcpRuntimeCandidateUnavailableCode =
  | "PACKAGE_MISSING"
  | "PACKAGE_DRIFT"
  | "PACKAGE_IMPORT_FAILED";

export type PiMcpRuntimeCandidate =
  | Readonly<{ kind: "verified"; adapter: PiMcpRuntimeAdapter }>
  | Readonly<{
      kind: "unavailable";
      code: PiMcpRuntimeCandidateUnavailableCode;
      /** Fixed, user-safe explanation; native causes stay on the internal result. */
      explanation: string;
      cause?: unknown;
    }>;

function programmaticModule(value: unknown): ProgrammaticModule | undefined {
  if (value === null || typeof value !== "object" ||
      typeof (value as { createMcpAdapter?: unknown }).createMcpAdapter !== "function") return undefined;
  return value as ProgrammaticModule;
}

function unavailable(
  code: PiMcpRuntimeCandidateUnavailableCode,
  explanation: string,
  cause?: unknown,
): PiMcpRuntimeCandidate {
  return Object.freeze({
    kind: "unavailable" as const,
    code,
    explanation,
    ...(cause === undefined ? {} : { cause }),
  });
}

function probeExplanation(code: "PACKAGE_MISSING" | "PACKAGE_DRIFT"): string {
  return code === "PACKAGE_MISSING"
    ? "The MCP adapter package is not installed."
    : "The installed MCP adapter package does not match the required release.";
}

/** Verify exact local bytes before evaluating the documented programmatic export. */
export async function createVerifiedPiMcpRuntimeCandidate(
  signal: AbortSignal = new AbortController().signal,
): Promise<PiMcpRuntimeCandidate> {
  const probe = await probePublishedPackage({
    entrySpecifier: "@nklisch/pi-mcp-adapter/programmatic",
    receipt: PI_MCP_ADAPTER_RECEIPT,
    signal,
  });
  if (probe.kind !== "verified") return unavailable(probe.code, probeExplanation(probe.code));
  signal.throwIfAborted();
  try {
    const module = programmaticModule(await import(probe.entry));
    if (module === undefined) {
      return unavailable(
        "PACKAGE_IMPORT_FAILED",
        "The MCP adapter package does not expose a usable programmatic runtime.",
        new TypeError("published MCP adapter programmatic export is incomplete"),
      );
    }
    return Object.freeze({
      kind: "verified" as const,
      adapter: createPiMcpRuntime({
        packageFactory: module.createMcpAdapter,
        initialSources: [],
        fileDiscovery: "disabled",
      }),
    });
  } catch (cause) {
    if (signal.aborted) throw signal.reason;
    return unavailable(
      "PACKAGE_IMPORT_FAILED",
      "The MCP adapter package could not be loaded.",
      cause,
    );
  }
}
