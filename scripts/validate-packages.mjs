import { access, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  loadPackages,
  PACKAGE_PREFIX,
  REQUIRED_SCOPE,
  REPOSITORY_URL,
} from "./package-catalog.mjs";
import {
  isNativePlatformPackage,
  validateNativePackageContract,
} from "./native-packages.mjs";

const errors = [];
const packages = await loadPackages();
const packagesByName = new Map(packages.map((pkg) => [pkg.manifest.name, pkg]));
const lockfile = JSON.parse(
  await readFile(new URL("../package-lock.json", import.meta.url), "utf8"),
);
const names = new Set();

if (packages.length === 0) errors.push("No packages found under packages/.");

for (const pkg of packages) {
  const { directory, directoryName, manifest } = pkg;
  const expectedName = `${REQUIRED_SCOPE}${directoryName}`;
  const nativePlatformPackage = isNativePlatformPackage(manifest);
  const report = (message) => errors.push(`${directoryName}: ${message}`);

  if (!directoryName.startsWith(PACKAGE_PREFIX)) report(`directory must start with ${PACKAGE_PREFIX}`);
  if (manifest.name !== expectedName) report(`name must be ${expectedName}, got ${manifest.name ?? "(missing)"}`);
  if (names.has(manifest.name)) report(`duplicate package name ${manifest.name}`);
  names.add(manifest.name);
  if (manifest.private !== false) report("private must explicitly be false");
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(manifest.version ?? "")) report("version must be semver");
  if (!nativePlatformPackage) {
    if (!manifest.keywords?.includes("pi-package")) report("keywords must include pi-package");
    if (!manifest.keywords?.includes("pi-extension")) report("keywords must include pi-extension");
    if (!Array.isArray(manifest.pi?.extensions) || manifest.pi.extensions.length === 0) {
      report("pi.extensions must declare at least one entrypoint");
    }
  }
  if (manifest.publishConfig?.access !== "public") report("publishConfig.access must be public");
  if (manifest.publishConfig?.provenance !== true) report("publishConfig.provenance must be true");
  if (manifest.repository?.url !== REPOSITORY_URL) report(`repository.url must be ${REPOSITORY_URL}`);
  if (manifest.repository?.directory !== `packages/${directoryName}`) report("repository.directory does not match workspace path");
  for (const error of validateNativePackageContract(pkg)) report(error);

  // npm does not install optional dependencies declared only by a bundled
  // child package. Meta-packages must forward them so platform/runtime
  // capabilities survive a clean consumer install.
  for (const dependency of manifest.bundledDependencies ?? manifest.bundleDependencies ?? []) {
    const bundledManifest =
      packagesByName.get(dependency)?.manifest ??
      lockfile.packages?.[`node_modules/${dependency}`];
    for (const [name, range] of Object.entries(bundledManifest?.optionalDependencies ?? {})) {
      if (manifest.optionalDependencies?.[name] !== range) {
        report(
          `optionalDependencies.${name} must forward ${dependency}'s bundled range ${range}`,
        );
      }
    }
  }

  // TypeScript packages can point directly at source. Compiled packages may point
  // at dist, which is intentionally absent from a clean checkout until build.
  // Meta packages reference bundled dependencies through node_modules paths,
  // which only materialize inside the packed tarball (verified by check-packs).
  for (const extensionPath of manifest.pi?.extensions ?? []) {
    if (extensionPath.includes("*") || extensionPath.startsWith("./dist/") || extensionPath.startsWith("./node_modules/")) continue;
    try {
      await access(join(directory, extensionPath));
    } catch {
      report(`declared extension path does not exist: ${extensionPath}`);
    }
  }
}

// Generated native packages are staged outside the repository. Any other
// nested public manifest is invisible to the workspace catalog and would be
// silently skipped by validation and publishing, so reject it explicitly.
for (const pkg of packages) {
  for (const manifestPath of await nestedManifestPaths(pkg.directory)) {
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    if (manifest.private !== true) {
      errors.push(
        `${pkg.directoryName}: nested publishable manifest is not supported: ${manifestPath}`,
      );
    }
  }
}

if (errors.length > 0) {
  console.error(`Package validation failed:\n- ${errors.join("\n- ")}`);
  process.exitCode = 1;
} else {
  console.log(`Validated ${packages.length} @nklisch publishable packages.`);
}

async function nestedManifestPaths(root) {
  const paths = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || ["node_modules", "dist", ".git"].includes(entry.name)) continue;
    const directory = join(root, entry.name);
    try {
      await access(join(directory, "package.json"));
      paths.push(join(directory, "package.json"));
    } catch {
      // Continue into ordinary source/docs directories.
    }
    paths.push(...(await nestedManifestPaths(directory)));
  }
  return paths;
}
