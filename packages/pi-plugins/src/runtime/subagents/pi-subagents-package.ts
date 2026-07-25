import { join } from "node:path";
import * as piAi from "@earendil-works/pi-ai";
import * as piCodingAgent from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as piTui from "@earendil-works/pi-tui";
import type { SubagentsService } from "@nklisch/pi-subagents";
import { createJiti, type Jiti } from "jiti/static";
import {
  probePublishedPackage,
  type PublishedPackageProbeResult,
  type PublishedPackageReceipt,
} from "../published-package-receipt.js";

export const PI_SUBAGENTS_RECEIPT: PublishedPackageReceipt = Object.freeze({
  packageName: "@nklisch/pi-subagents",
  version: "18.0.4-nklisch.0",
  registryIntegrity: "sha512-33Q8JDffXUuiT1M3XjLXCI4If9p+3AOwsUp/b5f1+B7Y5JI8Z8SVU+Dncq0umAG2IjgVYKnT9FHToFHNoZGWoQ==",
  installedTreeDigest: "sha256:7dc5579d3da204be379138453295375d8ab598fab19c97ce9d7e2b0b61fbe67f",
  license: "MIT",
  licenseSha256: "e7d9d11c28cce34f09dc7d2b0a3a6609ccba5fbc8e926e6d1bfdf060930e9f05",
  releaseTag: "pi-subagents-v18.0.4-nklisch.0@ad55fae043abf87d4ec74a5cb0f2f8f17b1fb175",
  releaseCommit: "43efffb459f64e2f5f9aaee50d8ae5afa564f4f3",
  upstreamBaseCommit: "c76a294a777a990950da23fc06cb0caf51da7ac6",
  nodeEngine: ">=22",
  piPeerRange: ">=0.75.0",
  requiredExports: [".", "./settings"],
  piExtensions: ["./src/index.ts"],
});

type RootModule = Readonly<{
  getSubagentsService(): SubagentsService | undefined;
}>;

let verifiedPackage: Promise<PublishedPackageProbeResult> | undefined;
let packageLoader: Jiti | undefined;

/**
 * Pi supplies extension peer modules through its own Jiti aliases/virtual
 * modules rather than installing another coding-agent tree beside each package.
 * The nested verified extension is loaded by our Jiti instance, so explicitly
 * bridge those already-loaded module identities into that child loader.
 */
function loader(): Jiti {
  packageLoader ??= createJiti(import.meta.url, {
    virtualModules: {
      "@earendil-works/pi-ai": piAi,
      "@earendil-works/pi-coding-agent": piCodingAgent,
      "@earendil-works/pi-tui": piTui,
    },
  });
  return packageLoader;
}

function probe(signal: AbortSignal): Promise<PublishedPackageProbeResult> {
  verifiedPackage ??= probePublishedPackage({
    entrySpecifier: "@nklisch/pi-subagents",
    receipt: PI_SUBAGENTS_RECEIPT,
    signal,
  });
  return verifiedPackage;
}

function rootModule(value: unknown): RootModule | undefined {
  if (value === null || typeof value !== "object" ||
      typeof (value as { getSubagentsService?: unknown }).getSubagentsService !== "function") return undefined;
  return value as RootModule;
}

/** Load the exact package-declared Pi resource only after its full tree receipt passes. */
export async function loadVerifiedPiSubagentsExtension(
  signal: AbortSignal = new AbortController().signal,
): Promise<((pi: ExtensionAPI) => void | Promise<void>) | undefined> {
  const result = await probe(signal);
  if (result.kind !== "verified") return undefined;
  signal.throwIfAborted();
  try {
    const module = await loader().import(join(result.packageRoot, PI_SUBAGENTS_RECEIPT.piExtensions[0]!));
    const extension = module !== null && typeof module === "object"
      ? (module as { default?: unknown }).default
      : undefined;
    return typeof extension === "function"
      ? extension as (pi: ExtensionAPI) => void | Promise<void>
      : undefined;
  } catch {
    if (signal.aborted) throw signal.reason;
    return undefined;
  }
}

/** Resolve the documented service root from the same verified package tree. */
export async function loadVerifiedPiSubagentsService(
  signal: AbortSignal = new AbortController().signal,
): Promise<SubagentsService | undefined> {
  const result = await probe(signal);
  if (result.kind !== "verified") return undefined;
  signal.throwIfAborted();
  try {
    const module = rootModule(await loader().import(result.entry));
    return module?.getSubagentsService();
  } catch {
    if (signal.aborted) throw signal.reason;
    return undefined;
  }
}
