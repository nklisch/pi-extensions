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
  version: "18.1.0-nklisch.0",
  license: "MIT",
  nodeEngine: ">=22",
  piPeerRange: ">=0.80.5",
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
