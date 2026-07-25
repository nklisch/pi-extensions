import { access, cp, lstat, mkdir, readFile, realpath } from "node:fs/promises";
import { basename, join, relative, sep } from "node:path";
import { pathToFileURL } from "node:url";
import {
  auditIsolatedTree,
  createCleanE2ESandbox,
  installPackedProduct,
  loadSuiteArtifact,
  removeInstallCommandShims,
  type CleanE2ESandbox,
  type E2ESuiteArtifact,
} from "./environment.js";
import { E2E_CHECKOUT_ROOT, E2E_PACKAGE_VERSION, E2E_PI_VERSION, E2E_TIMEOUTS } from "./constants.js";
import { runChecked } from "./process.js";

export type ProductionSuiteArtifact = Readonly<{
  candidateName: "@nklisch/pi-plugins";
  candidateTarball: string;
  candidateIntegrity: `sha512-${string}`;
  publicLockfile: string;
  consumerPackage: string;
  npmCache: string;
  consumerTemplate: string;
  packageReceipts: E2ESuiteArtifact["packageReceipts"];
}>;

export async function prepareProductionSuiteArtifact(): Promise<ProductionSuiteArtifact> {
  const artifact = await loadSuiteArtifact();
  return Object.freeze({
    candidateName: artifact.candidateName,
    candidateTarball: artifact.tarball,
    candidateIntegrity: artifact.candidateIntegrity,
    publicLockfile: artifact.publicLockfile,
    consumerPackage: artifact.consumerPackage,
    npmCache: artifact.npmCache,
    consumerTemplate: artifact.consumerTemplate,
    packageReceipts: artifact.packageReceipts,
  });
}

export function createProductionE2ESandbox(id: string): Promise<CleanE2ESandbox> {
  return createCleanE2ESandbox(id);
}

export function installProductionPackedProduct(sandbox: CleanE2ESandbox): Promise<void> {
  return installPackedProduct(sandbox);
}

export async function installFromEmptyRegistrySnapshot(input: Readonly<{
  candidateTarball: string;
  publicLockfile: string;
  npmCache: string;
  destination: string;
  env: NodeJS.ProcessEnv;
}>): Promise<Readonly<{
  packageRoot: string;
  piCli: string;
  installedReceipts: readonly Readonly<{ name: string; version: string; integrity: string; realpath: string }>[];
}>> {
  const artifact = await loadSuiteArtifact();
  const consumer = join(input.destination, "consumer");
  await mkdir(consumer, { recursive: true });
  await access(join(consumer, "node_modules")).then(
    () => { throw new Error("from-empty registry destination already contains node_modules"); },
    () => undefined,
  );
  const tarball = join(input.destination, basename(input.candidateTarball));
  await Promise.all([
    cp(input.candidateTarball, tarball, { force: true }),
    cp(artifact.consumerPackage, join(consumer, "package.json"), { force: true }),
    cp(input.publicLockfile, join(consumer, "package-lock.json"), { force: true }),
  ]);
  const env = {
    ...input.env,
    HOME: input.env.HOME ?? join(input.destination, "home"),
    NODE_OPTIONS: "",
    NODE_PATH: "",
    npm_config_cache: input.npmCache,
    npm_config_offline: "true",
    npm_config_ignore_scripts: "true",
    npm_config_audit: "false",
    npm_config_fund: "false",
  };
  await runChecked(artifact.capabilities.npm, ["ci", "--offline", "--ignore-scripts", "--no-audit", "--no-fund"], {
    cwd: consumer,
    env,
    timeoutMs: E2E_TIMEOUTS.lifecycle * 2,
    label: "from-empty offline npm lock/SRI replay",
  });
  const tree = join(consumer, "node_modules");
  await removeInstallCommandShims(tree);
  await auditIsolatedTree(tree);
  await runChecked(artifact.capabilities.npm, ["ls", "--omit=dev", "--all", "--json"], {
    cwd: consumer,
    env,
    timeoutMs: E2E_TIMEOUTS.lifecycle,
    label: "audit from-empty production dependency closure",
  });

  const lock = JSON.parse(await readFile(join(consumer, "package-lock.json"), "utf8")) as {
    packages: Record<string, { version?: string; integrity?: string; inBundle?: boolean }>;
  };
  const receipts: Array<{ name: string; version: string; integrity: string; realpath: string }> = [];
  for (const [path, row] of Object.entries(lock.packages)) {
    if (path === "" || row.inBundle === true || typeof row.version !== "string" || typeof row.integrity !== "string") continue;
    const installed = join(consumer, path);
    const info = await lstat(installed).catch(() => undefined);
    if (info === undefined || !info.isDirectory() || info.isSymbolicLink()) continue;
    const manifest = JSON.parse(await readFile(join(installed, "package.json"), "utf8")) as { name?: string };
    if (typeof manifest.name !== "string") throw new Error(`installed lock row has no package identity: ${path}`);
    const canonical = await realpath(installed);
    const checkoutRelative = relative(E2E_CHECKOUT_ROOT, canonical);
    if (checkoutRelative === "" || checkoutRelative !== ".." && !checkoutRelative.startsWith(`..${sep}`)) {
      throw new Error(`from-empty package resolves into checkout: ${manifest.name}`);
    }
    receipts.push({ name: manifest.name, version: row.version, integrity: row.integrity, realpath: canonical });
  }
  const packageRoot = join(tree, "@nklisch", "pi-plugins");
  const receiptModule = await import(pathToFileURL(join(packageRoot, "dist", "runtime", "subagents", "pi-subagents-package.js")).href) as {
    PI_SUBAGENTS_RECEIPT: { packageName: string; version: string; registryIntegrity: string; installedTreeDigest: string };
  };
  const treeModule = await import(pathToFileURL(join(packageRoot, "dist", "runtime", "published-package-receipt.js")).href) as {
    digestPublishedPackageTree(root: string): Promise<string>;
  };
  const bundledSubagents = join(packageRoot, "node_modules", "@nklisch", "pi-subagents");
  const bundledReceipt = receiptModule.PI_SUBAGENTS_RECEIPT;
  if (await treeModule.digestPublishedPackageTree(bundledSubagents) !== bundledReceipt.installedTreeDigest) {
    throw new Error("from-empty bundled subagent tree drifted from its registry receipt");
  }
  receipts.push({
    name: bundledReceipt.packageName,
    version: bundledReceipt.version,
    integrity: bundledReceipt.registryIntegrity,
    realpath: await realpath(bundledSubagents),
  });
  const candidate = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8")) as { name?: string; private?: boolean; version?: string };
  if (candidate.name !== "@nklisch/pi-plugins" || candidate.private !== false || candidate.version !== E2E_PACKAGE_VERSION) {
    throw new Error("from-empty candidate identity drifted");
  }
  const piRoot = join(tree, "@earendil-works", "pi-coding-agent");
  const pi = JSON.parse(await readFile(join(piRoot, "package.json"), "utf8")) as { version?: string; bin?: { pi?: string } };
  if (pi.version !== E2E_PI_VERSION || typeof pi.bin?.pi !== "string") throw new Error("from-empty Pi runtime drifted");
  return Object.freeze({
    packageRoot,
    piCli: join(piRoot, pi.bin.pi),
    installedReceipts: Object.freeze(receipts.sort((left, right) => left.realpath.localeCompare(right.realpath)).map(Object.freeze)),
  });
}
