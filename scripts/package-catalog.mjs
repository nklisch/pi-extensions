import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

export const REPOSITORY_URL = "git+https://github.com/nklisch/pi-extensions.git";
export const REQUIRED_SCOPE = "@nklisch/";
export const PACKAGE_PREFIX = "pi-";
export const packagesDirectory = new URL("../packages/", import.meta.url);

export function orderPackagesForPublish(packages) {
  const selectedByName = new Map(packages.map((pkg) => [pkg.manifest.name, pkg]));
  const visiting = new Set();
  const visited = new Set();
  const ordered = [];

  const visit = (pkg) => {
    const name = pkg.manifest.name;
    if (visited.has(name)) return;
    if (visiting.has(name)) {
      throw new Error(`Local package dependency cycle prevents safe publication: ${[...visiting, name].join(" -> ")}`);
    }
    visiting.add(name);
    const dependencies = {
      ...pkg.manifest.dependencies,
      ...pkg.manifest.optionalDependencies,
    };
    for (const dependencyName of Object.keys(dependencies).sort()) {
      const dependency = selectedByName.get(dependencyName);
      if (dependency !== undefined) visit(dependency);
    }
    visiting.delete(name);
    visited.add(name);
    ordered.push(pkg);
  };

  // Exact-version dependents must not become visible before the local package
  // versions they require, or a successful publish creates a temporarily
  // uninstallable release.
  for (const pkg of packages) visit(pkg);
  return ordered;
}

export async function loadPackages() {
  const entries = await readdir(packagesDirectory, { withFileTypes: true });
  const packages = [];

  for (const entry of entries.filter((candidate) => candidate.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    const directory = join(packagesDirectory.pathname, entry.name);
    const manifestPath = join(directory, "package.json");
    let manifest;
    try {
      manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    } catch (error) {
      throw new Error(`Cannot read ${manifestPath}: ${error.message}`, { cause: error });
    }
    packages.push({ directory, directoryName: entry.name, manifest, manifestPath });
  }

  return packages;
}
