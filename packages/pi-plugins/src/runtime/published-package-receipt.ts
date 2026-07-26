import { lstat, readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Manifest contract for a runtime sibling (pi-subagents, pi-mcp-adapter).
 *
 * All three packages are owned and released from the same monorepo, so the
 * load-time gate verifies SHAPE — right package, right version, declared
 * exports and Pi resources present — rather than byte-level registry
 * attestation. Byte integrity is npm's job (lockfile SRIs at install), and
 * the bundle ships inside this package's own tarball.
 */
export type PublishedPackageReceipt = Readonly<{
  packageName: string;
  version: string;
  license: "MIT";
  nodeEngine: string;
  piPeerRange: string;
  requiredExports: readonly string[];
  piExtensions: readonly string[];
}>;

export type PublishedPackageProbeResult =
  | Readonly<{ kind: "verified"; packageRoot: string; entry: string }>
  | Readonly<{ kind: "unavailable"; code: "PACKAGE_MISSING" | "PACKAGE_DRIFT" }>;

function inside(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === "" || path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

function receiptShape(receipt: PublishedPackageReceipt): boolean {
  return receipt !== null && typeof receipt === "object" && receipt.license === "MIT" &&
    Array.isArray(receipt.requiredExports) && Array.isArray(receipt.piExtensions) &&
    [receipt.packageName, receipt.version, receipt.nodeEngine, receipt.piPeerRange]
      .every((value) => typeof value === "string" && value.length > 0);
}

function safeRelativePath(path: string): boolean {
  return path.length > 0 && !path.startsWith("/") && !path.includes("\\") && !path.includes("\0") &&
    path.split("/").every((part) => part.length > 0 && part !== "." && part !== "..");
}

async function findPackageRoot(entry: string, receipt: PublishedPackageReceipt): Promise<string | undefined> {
  let current = dirname(entry);
  const filesystemRoot = parse(current).root;
  for (;;) {
    const manifestPath = join(current, "package.json");
    try {
      const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
      if (manifest.name === receipt.packageName) return current;
    } catch { /* continue toward the filesystem root */ }
    if (current === filesystemRoot) return undefined;
    current = dirname(current);
  }
}

function exportPresent(exportsValue: unknown, key: string): boolean {
  if (key === "." && (typeof exportsValue === "string" || Array.isArray(exportsValue))) return true;
  return exportsValue !== null && typeof exportsValue === "object" &&
    Object.prototype.hasOwnProperty.call(exportsValue, key);
}

async function verifyManifest(
  packageRoot: string,
  entry: string,
  receipt: PublishedPackageReceipt,
): Promise<boolean> {
  const manifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8")) as Record<string, unknown>;
  const engines = manifest.engines as Record<string, unknown> | undefined;
  const peers = manifest.peerDependencies as Record<string, unknown> | undefined;
  const pi = manifest.pi as Record<string, unknown> | undefined;
  const extensions = pi?.extensions;
  if (manifest.name !== receipt.packageName || manifest.version !== receipt.version ||
      manifest.license !== receipt.license || engines?.node !== receipt.nodeEngine ||
      peers?.["@earendil-works/pi-coding-agent"] !== receipt.piPeerRange ||
      JSON.stringify(extensions) !== JSON.stringify(receipt.piExtensions) ||
      receipt.requiredExports.some((key) => !exportPresent(manifest.exports, key))) return false;

  const root = await realpath(packageRoot);
  const canonicalEntry = await realpath(entry);
  if (!inside(root, canonicalEntry)) return false;
  for (const resource of receipt.piExtensions) {
    if (!resource.startsWith("./") || !safeRelativePath(resource.slice(2))) return false;
    const resourcePath = resolve(root, resource);
    if (!inside(root, resourcePath) || !(await lstat(resourcePath)).isFile()) return false;
  }
  return true;
}

/** Resolve without importing, verify the manifest contract, then hand the entry to a package-specific loader. */
export async function probePublishedPackage(input: Readonly<{
  entrySpecifier: string;
  receipt: PublishedPackageReceipt;
  signal: AbortSignal;
}>): Promise<PublishedPackageProbeResult> {
  input.signal.throwIfAborted();
  if (!receiptShape(input.receipt)) return Object.freeze({ kind: "unavailable", code: "PACKAGE_DRIFT" });
  let entry: string;
  try {
    const resolvedEntry = import.meta.resolve(input.entrySpecifier);
    if (!resolvedEntry.startsWith("file:")) return Object.freeze({ kind: "unavailable", code: "PACKAGE_DRIFT" });
    entry = fileURLToPath(resolvedEntry);
  } catch {
    return Object.freeze({ kind: "unavailable", code: "PACKAGE_MISSING" });
  }
  input.signal.throwIfAborted();
  try {
    const packageRoot = await findPackageRoot(entry, input.receipt);
    if (packageRoot === undefined || !await verifyManifest(packageRoot, entry, input.receipt)) {
      return Object.freeze({ kind: "unavailable", code: "PACKAGE_DRIFT" });
    }
    input.signal.throwIfAborted();
    return Object.freeze({ kind: "verified", packageRoot, entry });
  } catch {
    if (input.signal.aborted) throw input.signal.reason;
    return Object.freeze({ kind: "unavailable", code: "PACKAGE_DRIFT" });
  }
}
