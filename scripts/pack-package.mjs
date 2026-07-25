/**
 * pack-package.mjs — produce a publish-faithful tarball for a workspace
 * package, including bundleDependencies.
 *
 * Why this exists: npm pack silently drops bundleDependencies when packing
 * inside an npm workspace (verified empirically on npm 11: registry deps
 * stage fine, but workspace-owned package names are excluded from the
 * bundle). The reliable workaround is to pack a copy of the package outside
 * the workspace context with the bundle staged as real directories — which
 * matches exactly what a consumer receives.
 *
 * Bundle resolution per dependency:
 * - Workspace sibling: recursively packed with this same script (so nested
 *   bundles and prepack build steps compose), tarball extracted into place.
 * - Registry dep present in the install tree: copied (the installed tree of
 *   a registry package is its published tree), minus its node_modules —
 *   transitive deps install normally at consume time.
 * - Registry dep npm declined to install (inBundle lockfile quirk): fetched
 *   as the exact locked version's published tarball.
 *
 * Usage:
 *   node scripts/pack-package.mjs <packageDir> [--dry-run] [--out <dir>]
 *
 * Prints the npm pack JSON report to stdout.
 */
import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2).filter((a) => a !== "--dry-run");
const dryRun = process.argv.includes("--dry-run");
const outIndex = args.indexOf("--out");
const packageDir = resolve(args[0] ?? ".");
const outDir = outIndex !== -1 ? resolve(args[outIndex + 1]) : packageDir;
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function cleanEnv() {
  // npm_config_* / npm_lifecycle_* leak from an enclosing npm run (e.g.
  // --dry-run) into child npm processes and silently change their behavior.
  return Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !key.startsWith("npm_config_") && !key.startsWith("npm_lifecycle_"),
    ),
  );
}

function npmPackJson(cwd, spec, destination, asDryRun) {
  const argv = ["pack", "--json", "--ignore-scripts", "--pack-destination", destination];
  if (spec) argv.splice(1, 0, spec);
  if (asDryRun && !spec) argv.push("--dry-run");
  const raw = execFileSync("npm", argv, { cwd, encoding: "utf8", env: cleanEnv() });
  // Scripts in the pack pipeline may print progress lines; locate the JSON.
  return JSON.parse(raw.slice(raw.indexOf("["), raw.lastIndexOf("]") + 1));
}

function extractTarball(tgzPath, destination) {
  const extractDir = mkdtempSync(join(tmpdir(), "pack-extract-"));
  execFileSync("tar", ["-xzf", tgzPath, "-C", extractDir]);
  cpSync(join(extractDir, "package"), destination, { recursive: true });
  rmSync(extractDir, { recursive: true, force: true });
}

function findInstalledDir(dep, startDir) {
  let dir = startDir;
  for (;;) {
    const candidate = join(dir, "node_modules", dep, "package.json");
    if (existsSync(candidate)) return dirname(candidate);
    const parent = dirname(dir);
    if (dir === repoRoot || parent === dir) return null;
    dir = parent;
  }
}

function lockfileVersion(dep) {
  const lock = JSON.parse(readFileSync(join(repoRoot, "package-lock.json"), "utf8"));
  const entry =
    lock.packages?.[`node_modules/${dep}`] ??
    Object.entries(lock.packages ?? {}).find(([key, value]) =>
      key.endsWith(`node_modules/${dep}`) && value.version,
    )?.[1];
  if (!entry?.version) throw new Error(`No lockfile entry for ${dep}`);
  return entry.version;
}

/** Pack a package directory; returns { tarball, report }. */
function packPackage(dir, asDryRun = false) {
  const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  const bundled = manifest.bundledDependencies ?? manifest.bundleDependencies ?? [];

  const stagingRoot = mkdtempSync(join(tmpdir(), "pack-package-"));
  const stagingDir = join(stagingRoot, "pkg");
  try {
    cpSync(dir, stagingDir, {
      recursive: true,
      filter: (source) =>
        !source.includes(`${dir}/node_modules`) &&
        !source.includes(`${dir}/.git`) &&
        !source.endsWith(".tgz"),
    });

    for (const dep of bundled) {
      const destination = join(stagingDir, "node_modules", dep);
      const installedDir = findInstalledDir(dep, dir);
      const realDir = installedDir ? realpathSync(installedDir) : null;

      if (realDir?.startsWith(join(repoRoot, "packages") + "/")) {
        const sibling = packPackage(realDir, false);
        extractTarball(sibling.tarball, destination);
        rmSync(sibling.tarball, { force: true });
      } else if (realDir) {
        cpSync(installedDir, destination, {
          recursive: true,
          filter: (source) => !source.includes(`${dep}/node_modules`),
        });
      } else {
        const report = npmPackJson(stagingRoot, `${dep}@${lockfileVersion(dep)}`, stagingRoot);
        extractTarball(join(stagingRoot, report[0].filename), destination);
      }

      if (!existsSync(join(destination, "package.json"))) {
        throw new Error(`Staged bundle for ${dep} is missing package.json`);
      }
    }

    mkdirSync(outDir, { recursive: true });
    const report = npmPackJson(stagingDir, undefined, outDir, asDryRun);
    return { tarball: asDryRun ? null : join(outDir, report[0].filename), report };
  } finally {
    rmSync(stagingRoot, { recursive: true, force: true });
  }
}

const { tarball, report } = packPackage(packageDir, dryRun);
console.log(JSON.stringify(report));
if (tarball) console.error(`Wrote ${tarball}`);
