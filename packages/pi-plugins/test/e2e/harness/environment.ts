import { access, cp, lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { onTestFailed } from "vitest";
import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import {
  E2E_CHECKOUT_ROOT,
  E2E_PACKAGE_VERSION,
  E2E_PI_VERSION,
  E2E_SECRET_CANARY,
  E2E_TIMEOUTS,
} from "./constants.js";
import { runChecked } from "./process.js";
import { assertAllSqliteIntegrity } from "./state-inspector.js";

export type E2ECapabilities = Readonly<{
  node: string;
  npm: string;
  git: string;
  gitHttpBackend: string;
  shell: string;
  script?: string;
  stty?: string;
  tar: string;
  cp: string;
  chmod: string;
  libfaketime?: Readonly<{ library: string; version: string }>;
}>;

export type E2ESuiteArtifact = Readonly<{
  root: string;
  candidateName: "@nklisch/pi-plugins";
  candidateIntegrity: `sha512-${string}`;
  tarball: string;
  consumerPackage: string;
  publicLockfile: string;
  npmCache: string;
  consumerTemplate: string;
  packageRoot: string;
  extensionPath: string;
  piRoot: string;
  piCli: string;
  packFiles: readonly string[];
  packageReceipts: readonly Readonly<{ name: string; version: string; resolved: string; integrity: string }>[];
  capabilities: E2ECapabilities;
}>;

export type CleanE2ESandbox = {
  readonly id: string;
  readonly root: string;
  readonly home: string;
  readonly agentDir: string;
  readonly sessionDir: string;
  readonly project: string;
  readonly consumer: string;
  readonly packageRoot: string;
  readonly extensionPath: string;
  readonly piCli: string;
  readonly bin: string;
  readonly logs: string;
  readonly artifacts: string;
  readonly env: NodeJS.ProcessEnv;
  readonly capabilities: E2ECapabilities;
  readonly cleanups: Array<() => Promise<void>>;
  readonly diagnostics: Array<Readonly<{ name: string; capture(): unknown }>>;
  testFailed?: boolean;
  failureEvidence?: Readonly<{ inventory: readonly string[]; logs: Readonly<Record<string, string>> }>;
  cleanupFailures?: readonly unknown[];
  installedList?: string;
};

const RECEIPT_ENV = "PI_PLUGIN_HOST_E2E_SUITE_RECEIPT";
let prepared: Promise<E2ESuiteArtifact> | undefined;

function inside(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === "" || path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

async function executable(name: string, required = true): Promise<string | undefined> {
  for (const directory of (process.env.PATH ?? "").split(delimiter).filter(Boolean)) {
    const candidate = join(directory, name);
    try {
      await access(candidate, fsConstants.X_OK);
      return await realpath(candidate);
    } catch { /* try the next PATH entry */ }
  }
  if (required) throw new Error(`clean E2E capability missing executable: ${name}`);
  return undefined;
}

async function faketimeCapability(): Promise<E2ECapabilities["libfaketime"]> {
  const candidates = [
    process.env.PI_PLUGIN_HOST_E2E_LIBFAKETIME,
    "/usr/lib/x86_64-linux-gnu/faketime/libfaketime.so.1",
    "/usr/lib/aarch64-linux-gnu/faketime/libfaketime.so.1",
    "/usr/lib/faketime/libfaketime.so.1",
  ].filter((value): value is string => typeof value === "string" && value.length > 0);
  for (const candidate of candidates) {
    try {
      const info = await stat(candidate);
      if (!info.isFile()) continue;
      const dpkg = await executable("dpkg-query", false);
      let version = "unmanaged";
      if (dpkg !== undefined) {
        const result = await runChecked(dpkg, ["-W", "-f=${Version}", "libfaketime"], { timeoutMs: E2E_TIMEOUTS.read }).catch(() => undefined);
        if (result !== undefined && result.stdout.trim().length > 0) version = result.stdout.trim();
      }
      return Object.freeze({ library: await realpath(candidate), version });
    } catch { /* unavailable on this host */ }
  }
  return undefined;
}

export async function diagnoseE2ECapabilities(): Promise<E2ECapabilities> {
  const [npm, git, shell, script, stty, tar, copy, chmod, libfaketime] = await Promise.all([
    executable("npm"), executable("git"), executable("bash"), executable("script", false),
    executable("stty", false), executable("tar"), executable("cp"), executable("chmod"),
    faketimeCapability(),
  ]);
  const gitExec = await runChecked(git!, ["--exec-path"], { timeoutMs: E2E_TIMEOUTS.read });
  const gitHttpBackend = join(gitExec.stdout.trim(), "git-http-backend");
  await access(gitHttpBackend, fsConstants.X_OK).catch(() => {
    throw new Error(`clean E2E capability missing real git http-backend at ${gitHttpBackend}`);
  });
  return Object.freeze({
    node: await realpath(process.execPath), npm: npm!, git: git!, gitHttpBackend,
    shell: shell!, ...(script === undefined ? {} : { script }), ...(stty === undefined ? {} : { stty }),
    tar: tar!, cp: copy!, chmod: chmod!, ...(libfaketime === undefined ? {} : { libfaketime }),
  });
}

export async function removeInstallCommandShims(root: string): Promise<void> {
  async function visit(path: string): Promise<void> {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const child = join(path, entry.name);
      if (entry.name === ".bin") await rm(child, { recursive: true, force: true });
      else await visit(child);
    }
  }
  await visit(root);
}

export async function auditIsolatedTree(root: string): Promise<void> {
  async function visit(path: string): Promise<void> {
    for (const name of await readdir(path)) {
      const child = join(path, name);
      const info = await lstat(child);
      if (info.isSymbolicLink()) throw new Error(`isolated consumer retained dependency symlink: ${relative(root, child)}`);
      const canonical = await realpath(child);
      if (inside(E2E_CHECKOUT_ROOT, canonical)) throw new Error(`isolated consumer resolves into checkout: ${relative(root, child)}`);
      if (info.isDirectory()) await visit(child);
    }
  }
  await visit(root);
}

function canonicalIntegrity(value: unknown): value is `sha512-${string}` {
  if (typeof value !== "string" || !value.startsWith("sha512-")) return false;
  const encoded = value.slice("sha512-".length);
  const bytes = Buffer.from(encoded, "base64");
  return bytes.length === 64 && bytes.toString("base64") === encoded;
}

async function auditConsumerLock(
  consumerTemplate: string,
  candidateIntegrity: `sha512-${string}`,
): Promise<readonly Readonly<{ name: string; version: string; resolved: string; integrity: string }>[]> {
  const lock = JSON.parse(await readFile(join(consumerTemplate, "package-lock.json"), "utf8")) as {
    lockfileVersion?: number;
    packages?: Record<string, { version?: string; resolved?: string; integrity?: string; inBundle?: boolean; link?: boolean }>;
  };
  if (lock.lockfileVersion !== 3 || lock.packages === undefined) throw new Error("production consumer requires an exact npm v3 lock");
  const receipts: Array<Readonly<{ name: string; version: string; resolved: string; integrity: string }>> = [];
  for (const [lockPath, row] of Object.entries(lock.packages)) {
    if (lockPath === "" || row.inBundle === true) continue;
    if (row.link === true) throw new Error(`production consumer lock contains a linked package: ${lockPath}`);
    if (typeof row.version !== "string" || typeof row.resolved !== "string") {
      throw new Error(`production consumer lock row is incomplete: ${lockPath}`);
    }
    if (!canonicalIntegrity(row.integrity)) {
      // Pi 0.80.8 carries these three exact nested packages inside its own
      // integrity-bound tarball while npm omits child SRI rows. They are never
      // fetched or resolved independently during the offline replay.
      if (!/^node_modules\/@earendil-works\/pi-coding-agent\/node_modules\/@earendil-works\/pi-(?:agent-core|ai|tui)$/u.test(lockPath) ||
          !row.resolved.startsWith("https://registry.npmjs.org/")) {
        throw new Error(`production consumer lock row has no SRI authority: ${lockPath}`);
      }
      continue;
    }
    if (lockPath === "node_modules/@nklisch/pi-plugins") {
      if (!row.resolved.startsWith("file:../nklisch-pi-plugins-") || row.integrity !== candidateIntegrity) {
        throw new Error("candidate lock row does not bind the packed tarball integrity");
      }
      continue;
    }
    const source = new URL(row.resolved);
    if (source.protocol !== "https:") throw new Error(`public dependency is not registry HTTPS resolved: ${lockPath}`);
    const name = lockPath.slice(lockPath.lastIndexOf("node_modules/") + "node_modules/".length);
    if (!/^(?:@[a-z0-9._~-]+\/[a-z0-9._~-]+|[a-z0-9._~-]+)$/u.test(name)) {
      throw new Error(`public dependency lock path has no canonical package name: ${lockPath}`);
    }
    receipts.push(Object.freeze({ name, version: row.version, resolved: row.resolved, integrity: row.integrity }));
  }
  return Object.freeze(receipts.sort((left, right) => left.name.localeCompare(right.name) || left.version.localeCompare(right.version)));
}

async function prepare(): Promise<E2ESuiteArtifact> {
  const capabilities = await diagnoseE2ECapabilities();
  const root = await mkdtemp(join(tmpdir(), "pi-plugin-host-native-e2e-suite-"));
  await runChecked(capabilities.npm, ["run", "build"], {
    cwd: E2E_CHECKOUT_ROOT,
    env: { ...process.env, NODE_OPTIONS: "" },
    timeoutMs: E2E_TIMEOUTS.lifecycle,
    label: "build packed E2E product",
  });
  const packed = await runChecked(capabilities.npm, ["pack", "--json", "--silent", "--pack-destination", root], {
    cwd: E2E_CHECKOUT_ROOT,
    env: { ...process.env, NODE_OPTIONS: "" },
    timeoutMs: E2E_TIMEOUTS.lifecycle,
    label: "pack E2E product tarball",
  });
  const pack = JSON.parse(packed.stdout) as Array<{ filename: string; files: Array<{ path: string }> }>;
  if (pack.length !== 1) throw new Error(`npm pack returned ${pack.length} artifacts`);
  const tarball = join(root, pack[0]!.filename);
  const candidateIntegrity = `sha512-${createHash("sha512").update(await readFile(tarball)).digest("base64")}` as const;
  const packFiles = Object.freeze(pack[0]!.files.map((entry) => entry.path).sort());
  for (const forbidden of ["src/", "test/", ".work/", ".agents/", ".mockups/"]) {
    if (packFiles.some((path) => path === forbidden.slice(0, -1) || path.startsWith(forbidden))) {
      throw new Error(`packed product contains forbidden development path ${forbidden}`);
    }
  }
  for (const required of [
    "package.json",
    "dist/index.js",
    "dist/pi/production-subagents-extension.js",
    "dist/pi/extension.js",
    "node_modules/@nklisch/pi-subagents/package.json",
    "node_modules/@nklisch/pi-subagents/src/index.ts",
  ]) {
    if (!packFiles.includes(required)) throw new Error(`packed product is missing ${required}`);
  }

  const consumerTemplate = join(root, "consumer-template");
  const npmCache = join(root, "npm-cache");
  const npmHome = join(root, "npm-home");
  const npmPrefix = join(root, "npm-prefix");
  const npmConfig = join(root, "npmrc");
  await Promise.all([consumerTemplate, npmCache, npmHome, npmPrefix].map((path) => mkdir(path, { recursive: true })));
  await writeFile(npmConfig, "registry=https://registry.npmjs.org/\nignore-scripts=true\naudit=false\nfund=false\n");
  const consumerPackage = join(consumerTemplate, "package.json");
  await writeFile(consumerPackage, `${JSON.stringify({
    name: "pi-plugins-production-e2e-consumer",
    private: true,
    type: "module",
    dependencies: {
      "@earendil-works/pi-coding-agent": E2E_PI_VERSION,
      "@earendil-works/pi-tui": E2E_PI_VERSION,
      "@nklisch/pi-plugins": `file:../${pack[0]!.filename}`,
    },
  }, null, 2)}\n`);
  const npmEnvironment = {
    ...process.env,
    HOME: npmHome,
    NODE_OPTIONS: "",
    NODE_PATH: "",
    npm_config_cache: npmCache,
    npm_config_prefix: npmPrefix,
    npm_config_userconfig: npmConfig,
  };
  await runChecked(capabilities.npm, ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--prefer-online"], {
    cwd: consumerTemplate,
    env: npmEnvironment,
    timeoutMs: E2E_TIMEOUTS.lifecycle * 2,
    label: "registry-resolve production consumer lock and cache",
  });
  const nodeModules = join(consumerTemplate, "node_modules");
  // Pi publishes a self-contained nested node_modules tree without declaring
  // bundleDependencies. npm install can consume that tarball, but npm ci also
  // validates the manifest dependency graph and otherwise sees those rows as
  // missing. Declare the exact public Pi manifest closure in this acceptance
  // consumer so the generated lock is a valid, replayable npm contract. Pi's
  // own nested 0.80.8 bytes still win Node resolution at runtime.
  const piPackage = JSON.parse(await readFile(join(nodeModules, "@earendil-works", "pi-coding-agent", "package.json"), "utf8")) as {
    dependencies?: Record<string, string>;
  };
  const consumerManifest = JSON.parse(await readFile(consumerPackage, "utf8")) as { dependencies: Record<string, string> };
  consumerManifest.dependencies = {
    ...(piPackage.dependencies ?? {}),
    ...consumerManifest.dependencies,
  };
  await writeFile(consumerPackage, `${JSON.stringify(consumerManifest, null, 2)}\n`);
  await runChecked(capabilities.npm, ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--prefer-online"], {
    cwd: consumerTemplate,
    env: npmEnvironment,
    timeoutMs: E2E_TIMEOUTS.lifecycle * 2,
    label: "complete exact Pi production dependency lock",
  });
  // Pi 0.80.8 publishes its complete nested runtime dependency closure inside
  // its own tarball. npm's lock writer drops those inBundle markers beside a
  // local candidate tarball, although the same installed Pi bytes are marked
  // correctly in an ordinary registry-root lock. Restore that factual marker
  // before ci so npm does not try to resolve newer range members outside the
  // exact Pi SRI authority.
  const generatedLockPath = join(consumerTemplate, "package-lock.json");
  const generatedLock = JSON.parse(await readFile(generatedLockPath, "utf8")) as { packages: Record<string, { inBundle?: boolean }> };
  for (const [path, row] of Object.entries(generatedLock.packages)) {
    if (path.startsWith("node_modules/@earendil-works/pi-coding-agent/node_modules/")) {
      row.inBundle = true;
    }
  }
  await writeFile(generatedLockPath, `${JSON.stringify(generatedLock, null, 2)}\n`);
  // Populate the cache from a true lock replay as well as initial resolution.
  // This captures optional-platform packuments npm may consult even when their
  // tarballs are not selected for the current Linux tree.
  await rm(nodeModules, { recursive: true, force: true });
  await runChecked(capabilities.npm, ["ci", "--ignore-scripts", "--no-audit", "--no-fund", "--prefer-online"], {
    cwd: consumerTemplate,
    env: npmEnvironment,
    timeoutMs: E2E_TIMEOUTS.lifecycle * 2,
    label: "online cache population from exact production lock",
  });
  // npm command shims are not runtime dependencies and are the only expected
  // install-created links. Runtime realpath auditing remains exception-free.
  await removeInstallCommandShims(nodeModules);

  const packageRoot = join(nodeModules, "@nklisch", "pi-plugins");
  const manifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8")) as {
    name?: string; private?: boolean; version?: string; pi?: { extensions?: string[] };
  };
  if (manifest.name !== "@nklisch/pi-plugins" || manifest.private !== false || manifest.version !== E2E_PACKAGE_VERSION ||
      JSON.stringify(manifest.pi?.extensions) !== JSON.stringify(["./dist/pi/production-subagents-extension.js", "./dist/pi/extension.js"])) {
    throw new Error("packed product identity or Pi extension graph is invalid");
  }
  const piRoot = join(nodeModules, "@earendil-works", "pi-coding-agent");
  const piManifest = JSON.parse(await readFile(join(piRoot, "package.json"), "utf8")) as { version: string; bin: { pi: string } };
  if (piManifest.version !== E2E_PI_VERSION) throw new Error(`clean E2E requires Pi ${E2E_PI_VERSION}, found ${piManifest.version}`);
  const tuiManifest = JSON.parse(await readFile(join(nodeModules, "@earendil-works", "pi-tui", "package.json"), "utf8")) as { version: string };
  if (tuiManifest.version !== E2E_PI_VERSION) throw new Error(`clean E2E requires Pi TUI ${E2E_PI_VERSION}, found ${tuiManifest.version}`);
  const lockReceipts = await auditConsumerLock(consumerTemplate, candidateIntegrity);
  const receiptModule = await import(pathToFileURL(join(packageRoot, "dist", "runtime", "subagents", "pi-subagents-package.js")).href) as {
    PI_SUBAGENTS_RECEIPT: { packageName: string; version: string; registryIntegrity: string; installedTreeDigest: string };
  };
  const treeModule = await import(pathToFileURL(join(packageRoot, "dist", "runtime", "published-package-receipt.js")).href) as {
    digestPublishedPackageTree(root: string): Promise<string>;
  };
  const subagentReceipt = receiptModule.PI_SUBAGENTS_RECEIPT;
  const bundledSubagentRoot = join(packageRoot, "node_modules", "@nklisch", "pi-subagents");
  if (subagentReceipt.packageName !== "@nklisch/pi-subagents" ||
      await treeModule.digestPublishedPackageTree(bundledSubagentRoot) !== subagentReceipt.installedTreeDigest) {
    throw new Error("bundled subagent tree does not match its packed registry receipt");
  }
  const packageReceipts = Object.freeze([...lockReceipts, Object.freeze({
    name: subagentReceipt.packageName,
    version: subagentReceipt.version,
    resolved: `https://registry.npmjs.org/@nklisch/pi-subagents/-/pi-subagents-${subagentReceipt.version}.tgz`,
    integrity: subagentReceipt.registryIntegrity,
  })].sort((left, right) => left.name.localeCompare(right.name) || left.version.localeCompare(right.version)));
  await auditIsolatedTree(nodeModules);

  const artifact: E2ESuiteArtifact = Object.freeze({
    root,
    candidateName: "@nklisch/pi-plugins",
    candidateIntegrity,
    tarball,
    consumerPackage,
    publicLockfile: join(consumerTemplate, "package-lock.json"),
    npmCache,
    consumerTemplate,
    packageRoot,
    extensionPath: join(packageRoot, "dist", "pi", "extension.js"),
    piRoot,
    piCli: join(piRoot, piManifest.bin.pi),
    packFiles,
    packageReceipts,
    capabilities,
  });
  const receipt = join(root, "receipt.json");
  await writeFile(receipt, `${JSON.stringify(artifact, null, 2)}\n`);
  process.env[RECEIPT_ENV] = receipt;
  return artifact;
}

export function prepareSuiteArtifact(): Promise<E2ESuiteArtifact> {
  prepared ??= prepare();
  return prepared;
}

export async function loadSuiteArtifact(): Promise<E2ESuiteArtifact> {
  if (prepared !== undefined) return prepared;
  const receipt = process.env[RECEIPT_ENV];
  if (receipt === undefined) return prepareSuiteArtifact();
  return JSON.parse(await readFile(receipt, "utf8")) as E2ESuiteArtifact;
}

async function linkTool(bin: string, name: string, target: string | undefined): Promise<void> {
  if (target === undefined) return;
  await symlink(target, join(bin, name));
}

function cleanEnvironment(sandbox: Omit<CleanE2ESandbox, "env" | "cleanups">): NodeJS.ProcessEnv {
  return {
    HOME: sandbox.home,
    PI_CODING_AGENT_DIR: sandbox.agentDir,
    PI_SESSION_DIR: sandbox.sessionDir,
    XDG_CONFIG_HOME: join(sandbox.root, "xdg", "config"),
    XDG_CACHE_HOME: join(sandbox.root, "xdg", "cache"),
    XDG_DATA_HOME: join(sandbox.root, "xdg", "data"),
    npm_config_cache: join(sandbox.root, "npm-cache"),
    npm_config_userconfig: join(sandbox.root, "npmrc"),
    GIT_CONFIG_GLOBAL: join(sandbox.root, "gitconfig"),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    PATH: sandbox.bin,
    TMPDIR: join(sandbox.root, "tmp"),
    NODE_OPTIONS: "",
    NO_COLOR: "1",
    FORCE_COLOR: "0",
    PI_OFFLINE: "1",
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    TZ: "UTC",
    TERM: "xterm-256color",
  };
}

export async function createCleanE2ESandbox(id: string): Promise<CleanE2ESandbox> {
  if (!/^[a-z0-9][a-z0-9-]{0,79}$/u.test(id)) throw new Error(`unsafe E2E test id: ${id}`);
  const artifact = await loadSuiteArtifact();
  const root = await mkdtemp(join(tmpdir(), `pi-plugin-host-native-e2e-${id}-`));
  const base = {
    id, root,
    home: join(root, "home"), agentDir: join(root, "agent"), sessionDir: join(root, "sessions"),
    project: join(root, "project"), consumer: join(root, "consumer"),
    packageRoot: join(root, "consumer", "node_modules", "@nklisch", "pi-plugins"),
    extensionPath: join(root, "consumer", "node_modules", "@nklisch", "pi-plugins", "dist", "pi", "extension.js"),
    piCli: join(root, "consumer", "node_modules", "@earendil-works", "pi-coding-agent", relative(artifact.piRoot, artifact.piCli)),
    bin: join(root, "bin"), logs: join(root, "logs"), artifacts: resolve(E2E_CHECKOUT_ROOT, ".e2e-artifacts", id),
    capabilities: artifact.capabilities,
  };
  await Promise.all([
    base.home, base.agentDir, base.sessionDir, base.project, base.bin, base.logs,
    join(root, "tmp"), join(root, "xdg", "config"), join(root, "xdg", "cache"), join(root, "xdg", "data"),
  ].map((path) => mkdir(path, { recursive: true })));
  await runChecked(artifact.capabilities.cp, ["-a", "--reflink=auto", `${artifact.consumerTemplate}/.`, base.consumer], {
    timeoutMs: E2E_TIMEOUTS.lifecycle,
    label: `clone isolated consumer for ${id}`,
  });
  await Promise.all([
    linkTool(base.bin, "node", artifact.capabilities.node),
    linkTool(base.bin, "npm", artifact.capabilities.npm),
    linkTool(base.bin, "git", artifact.capabilities.git),
    linkTool(base.bin, "sh", artifact.capabilities.shell),
    linkTool(base.bin, "bash", artifact.capabilities.shell),
    linkTool(base.bin, "script", artifact.capabilities.script),
    linkTool(base.bin, "stty", artifact.capabilities.stty),
  ]);
  await writeFile(join(root, "npmrc"), "offline=true\nignore-scripts=true\naudit=false\nfund=false\n");
  await writeFile(join(root, "gitconfig"), "[user]\n\tname = Pi Plugin Host E2E\n\temail = e2e@example.invalid\n[init]\n\tdefaultBranch = main\n[protocol]\n\tversion = 2\n");
  const sandboxWithoutEnvironment = {
    ...base,
    cleanups: [] as Array<() => Promise<void>>,
    diagnostics: [] as Array<Readonly<{ name: string; capture(): unknown }>>,
  };
  const sandbox: CleanE2ESandbox = { ...sandboxWithoutEnvironment, env: cleanEnvironment(sandboxWithoutEnvironment) };
  onTestFailed(async ({ task }) => {
    sandbox.testFailed = true;
    // Vitest reports the test outcome after afterEach has removed the disposable
    // root. cleanupSandbox snapshots bounded, redacted evidence beforehand so
    // this late hook can still persist useful diagnostics outside that root.
    const errors = task.result?.errors ?? sandbox.cleanupFailures ?? [];
    await retainFailureArtifacts(
      sandbox,
      errors,
      sandbox.failureEvidence ?? { inventory: [], logs: {} },
    );
  });
  return sandbox;
}

export async function installPackedProduct(sandbox: CleanE2ESandbox): Promise<void> {
  const version = await runChecked(sandbox.capabilities.node, [sandbox.piCli, "--version"], {
    cwd: sandbox.project, env: sandbox.env, timeoutMs: E2E_TIMEOUTS.startup, label: "verify isolated Pi version",
  });
  if (!version.stdout.includes(E2E_PI_VERSION)) throw new Error(`isolated Pi version mismatch: ${version.stdout.trim()}`);
  await runChecked(sandbox.capabilities.node, [sandbox.piCli, "install", sandbox.packageRoot], {
    cwd: sandbox.project, env: sandbox.env, timeoutMs: E2E_TIMEOUTS.lifecycle, label: "Pi three-step local package install",
  });
  const list = await runChecked(sandbox.capabilities.node, [sandbox.piCli, "list"], {
    cwd: sandbox.project, env: sandbox.env, timeoutMs: E2E_TIMEOUTS.startup, label: "list isolated Pi packages",
  });
  if (!list.stdout.includes(sandbox.packageRoot)) throw new Error(`Pi list did not name isolated package root:\n${list.stdout}`);
  if (list.stdout.includes(E2E_CHECKOUT_ROOT)) throw new Error("Pi list leaked the source checkout path");
  sandbox.installedList = list.stdout;
  const extension = await realpath(sandbox.extensionPath);
  if (!inside(sandbox.consumer, extension) || inside(E2E_CHECKOUT_ROOT, extension)) throw new Error("installed Pi extension is not consumer-owned");
  for (const foreign of [join(sandbox.home, ".claude"), join(sandbox.home, ".codex")]) {
    await lstat(foreign).then(() => { throw new Error(`foreign host state appeared at ${foreign}`); }, () => undefined);
  }
}

async function makeWritable(path: string, chmod: string): Promise<void> {
  await runChecked(chmod, ["-R", "u+w", path], { timeoutMs: E2E_TIMEOUTS.shutdown }).catch(() => undefined);
}

function failedTestContext(context: unknown): boolean {
  if (context === null || typeof context !== "object") return false;
  const task = (context as { task?: { result?: { state?: string; errors?: readonly unknown[] } } }).task;
  return task?.result?.state === "fail" || (task?.result?.errors?.length ?? 0) > 0;
}

function redactedText(value: string, sandbox: CleanE2ESandbox): string {
  if (value.includes(E2E_SECRET_CANARY)) throw new Error("secret canary reached E2E diagnostics");
  let safe = value;
  for (const [path, replacement] of [
    [sandbox.root, "[sandbox]"],
    [E2E_CHECKOUT_ROOT, "[checkout]"],
  ] as const) safe = safe.replaceAll(path, replacement);
  return safe.length <= 65_536 ? safe : `${safe.slice(0, 65_536)}\n[truncated]`;
}

function redactDiagnostic(value: unknown, sandbox: CleanE2ESandbox): unknown {
  if (typeof value === "string") return redactedText(value, sandbox);
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.slice(0, 512).map((entry) => redactDiagnostic(entry, sandbox));
  if (typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).slice(0, 512).map(([key, entry]) => [key, redactDiagnostic(entry, sandbox)]));
  }
  return String(value);
}

async function sandboxEvidence(sandbox: CleanE2ESandbox): Promise<Readonly<{ inventory: readonly string[]; logs: Readonly<Record<string, string>> }>> {
  const inventory: string[] = [];
  const logs: Record<string, string> = {};
  const scannedRoots = [sandbox.agentDir, sandbox.home, sandbox.project, sandbox.sessionDir, sandbox.logs];
  async function visit(root: string, path: string): Promise<void> {
    for (const entry of await readdir(path, { withFileTypes: true }).catch(() => [])) {
      if (inventory.length >= 4_096) return;
      const child = join(path, entry.name);
      const relativePath = relative(root, child);
      if (entry.isDirectory()) await visit(root, child);
      else if (entry.isFile()) {
        // Live sandboxes still run sqlite checkpointing and lock handle
        // churn while evidence is collected; files may vanish mid-walk.
        const info = await stat(child).catch((error: unknown) =>
          (error as NodeJS.ErrnoException).code === "ENOENT" ? undefined : Promise.reject(error));
        if (info === undefined) continue;
        inventory.push(`${relative(sandbox.root, child)}\t${info.size}`);
        if (info.size <= 1_048_576) {
          const bytes = await readFile(child);
          if (bytes.includes(Buffer.from(E2E_SECRET_CANARY))) throw new Error(`secret canary reached owned file ${relative(sandbox.root, child)}`);
          if (root === sandbox.logs && info.size <= 262_144) logs[relativePath] = redactedText(bytes.toString("utf8"), sandbox);
        }
      }
    }
  }
  for (const root of scannedRoots) await visit(root, root);
  inventory.sort();
  return Object.freeze({ inventory: Object.freeze(inventory), logs: Object.freeze(logs) });
}

async function retainFailureArtifacts(
  sandbox: CleanE2ESandbox,
  failures: readonly unknown[],
  evidence: Awaited<ReturnType<typeof sandboxEvidence>>,
): Promise<void> {
  await rm(sandbox.artifacts, { recursive: true, force: true });
  await mkdir(sandbox.artifacts, { recursive: true });
  const diagnostics = sandbox.diagnostics.map(({ name, capture }) => {
    try { return { name, value: redactDiagnostic(capture(), sandbox) }; }
    catch (error) { return { name, captureError: error instanceof Error ? error.name : "unknown" }; }
  });
  const summary = {
    schemaVersion: 1,
    testId: sandbox.id,
    failures: failures.map((error) => {
      if (error instanceof Error) return { name: error.name, message: redactedText(error.message, sandbox) };
      if (error !== null && typeof error === "object") {
        const value = error as { name?: unknown; message?: unknown };
        return {
          name: typeof value.name === "string" ? redactedText(value.name, sandbox) : "unknown",
          ...(typeof value.message === "string" ? { message: redactedText(value.message, sandbox) } : {}),
        };
      }
      return { name: "unknown" };
    }),
    inventory: evidence.inventory,
    logs: evidence.logs,
    diagnostics,
  };
  await writeFile(join(sandbox.artifacts, "failure.json"), `${JSON.stringify(summary, null, 2)}\n`, { mode: 0o600 });
}

export async function cleanupSandbox(sandbox: CleanE2ESandbox, testContext?: unknown): Promise<void> {
  const failures: unknown[] = [];
  for (const cleanup of [...sandbox.cleanups].reverse()) {
    try { await cleanup(); } catch (error) { failures.push(error); }
  }
  try { await assertAllSqliteIntegrity(sandbox.agentDir); } catch (error) { failures.push(error); }
  let evidence: Awaited<ReturnType<typeof sandboxEvidence>> = { inventory: [], logs: {} };
  try { evidence = await sandboxEvidence(sandbox); } catch (error) { failures.push(error); }
  for (const diagnostic of sandbox.diagnostics) {
    try {
      const serialized = JSON.stringify(diagnostic.capture());
      if (serialized.includes(E2E_SECRET_CANARY)) throw new Error(`secret canary reached ${diagnostic.name} diagnostics`);
    } catch (error) { failures.push(error); }
  }
  sandbox.failureEvidence = evidence;
  sandbox.cleanupFailures = failures;
  const failed = sandbox.testFailed === true || failedTestContext(testContext) || failures.length > 0;
  if (failed) {
    try { await retainFailureArtifacts(sandbox, failures, evidence); } catch (error) { failures.push(error); }
  } else {
    await rm(sandbox.artifacts, { recursive: true, force: true });
  }
  if (process.env.PI_PLUGIN_HOST_E2E_KEEP === "1") {
    console.error(`PI Plugin Host E2E sandbox retained: ${sandbox.root}`);
  } else {
    await makeWritable(sandbox.root, sandbox.capabilities.chmod);
    await rm(sandbox.root, { recursive: true, force: true });
  }
  if (failures.length > 0) throw new AggregateError(failures, `E2E sandbox ${sandbox.id} cleanup failed`);
}

export async function cleanupSuiteArtifact(artifact?: E2ESuiteArtifact): Promise<void> {
  const value = artifact ?? await loadSuiteArtifact();
  if (process.env.PI_PLUGIN_HOST_E2E_KEEP === "1") {
    console.error(`PI Plugin Host E2E suite artifact retained: ${value.root}`);
    return;
  }
  await makeWritable(value.root, value.capabilities.chmod);
  await rm(value.root, { recursive: true, force: true });
}

export async function acquireExclusiveFile(path: string, contents: string): Promise<() => Promise<void>> {
  await mkdir(dirname(path), { recursive: true });
  const handle = await open(path, "wx", 0o600).catch((cause) => {
    throw new Error(`E2E exclusive capability is already owned: ${path}`, { cause });
  });
  await handle.writeFile(contents, "utf8");
  await handle.close();
  return async () => { await rm(path, { force: true }); };
}

export function fixturePath(...parts: readonly string[]): string {
  return join(E2E_CHECKOUT_ROOT, "test", "e2e", "fixtures", ...parts);
}
