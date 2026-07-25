import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, open, readFile, readdir, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export type PublishedPackageReceipt = Readonly<{
  packageName: string;
  version: string;
  registryIntegrity: `sha512-${string}`;
  installedTreeDigest: `sha256:${string}`;
  license: "MIT";
  licenseSha256: string;
  releaseTag: string;
  releaseCommit: string;
  upstreamBaseCommit: string;
  nodeEngine: string;
  piPeerRange: string;
  requiredExports: readonly string[];
  piExtensions: readonly string[];
}>;

export type PublishedPackageProbeResult =
  | Readonly<{ kind: "verified"; packageRoot: string; entry: string }>
  | Readonly<{ kind: "unavailable"; code: "PACKAGE_MISSING" | "PACKAGE_DRIFT" }>;

const TREE_GRAMMAR = "pi-plugin-host-published-tree-v1\0";
const SHA256_HEX = /^[a-f0-9]{64}$/u;
const COMMIT = /^[a-f0-9]{40}$/u;

function inside(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === "" || path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

function receiptShape(receipt: PublishedPackageReceipt): boolean {
  if (receipt === null || typeof receipt !== "object" || receipt.license !== "MIT" ||
      !SHA256_HEX.test(receipt.licenseSha256) || !COMMIT.test(receipt.releaseCommit) ||
      !COMMIT.test(receipt.upstreamBaseCommit) || typeof receipt.releaseTag !== "string" ||
      receipt.releaseTag.length === 0 || !/^sha256:[a-f0-9]{64}$/u.test(receipt.installedTreeDigest) ||
      !Array.isArray(receipt.requiredExports) || !Array.isArray(receipt.piExtensions)) return false;
  if (!receipt.registryIntegrity.startsWith("sha512-")) return false;
  const encoded = receipt.registryIntegrity.slice("sha512-".length);
  try {
    const bytes = Buffer.from(encoded, "base64");
    if (bytes.length !== 64 || bytes.toString("base64") !== encoded) return false;
  } catch { return false; }
  return [receipt.packageName, receipt.version, receipt.nodeEngine, receipt.piPeerRange]
    .every((value) => typeof value === "string" && value.length > 0);
}

function safeRelativePath(path: string): boolean {
  return path.length > 0 && !path.startsWith("/") && !path.includes("\\") && !path.includes("\0") &&
    path.split("/").every((part) => part.length > 0 && part !== "." && part !== "..");
}

/**
 * Hash package-owned installed bytes. npm-created dependency trees are excluded:
 * their own lock/SRI rows are separate authorities and are not tar entries of
 * the package being qualified.
 */
export async function digestPublishedPackageTree(packageRoot: string): Promise<`sha256:${string}`> {
  const root = await realpath(packageRoot);
  const hash = createHash("sha256").update(TREE_GRAMMAR);
  const entries: Array<Readonly<{ path: string; kind: "directory" | "file"; executable: boolean; bytes?: Buffer }>> = [];
  const canonicalPaths = new Set<string>();

  async function visit(directory: string, prefix: string): Promise<void> {
    const children = await readdir(directory, { withFileTypes: true });
    children.sort((left, right) => Buffer.from(left.name).compare(Buffer.from(right.name)));
    for (const child of children) {
      // node_modules is installation structure, not a package-owned tar entry.
      if (prefix === "" && child.name === "node_modules") continue;
      const relativePath = prefix === "" ? child.name : `${prefix}/${child.name}`;
      if (!safeRelativePath(relativePath)) throw new TypeError("published package path is invalid");
      const collisionKey = relativePath.normalize("NFC").toLocaleLowerCase("en-US");
      if (canonicalPaths.has(collisionKey)) throw new TypeError("published package path collision detected");
      canonicalPaths.add(collisionKey);
      const absolute = join(directory, child.name);
      const info = await lstat(absolute);
      if (info.isSymbolicLink()) throw new TypeError("published package contains a symbolic link");
      if (info.isDirectory()) {
        entries.push({ path: relativePath, kind: "directory", executable: false });
        await visit(absolute, relativePath);
        continue;
      }
      if (!info.isFile()) throw new TypeError("published package contains a special file");
      const handle = await open(absolute, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
      try {
        const current = await handle.stat();
        if (!current.isFile()) throw new TypeError("published package entry changed type during verification");
        entries.push({
          path: relativePath,
          kind: "file",
          executable: (current.mode & 0o111) !== 0,
          bytes: await handle.readFile(),
        });
      } finally { await handle.close(); }
    }
  }

  await visit(root, "");
  entries.sort((left, right) => Buffer.from(left.path).compare(Buffer.from(right.path)));
  for (const entry of entries) {
    const bytes = entry.bytes ?? Buffer.alloc(0);
    hash.update(entry.kind).update("\0").update(entry.path).update("\0")
      .update(entry.executable ? "1" : "0").update("\0")
      .update(String(bytes.length)).update("\0").update(bytes).update("\0");
  }
  return `sha256:${hash.digest("hex")}`;
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
  const license = await readFile(join(root, "LICENSE"));
  if (createHash("sha256").update(license).digest("hex") !== receipt.licenseSha256) return false;
  return await digestPublishedPackageTree(root) === receipt.installedTreeDigest;
}

/** Resolve without importing, verify exact installed bytes, then hand the entry to a package-specific loader. */
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
