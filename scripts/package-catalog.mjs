import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

export const REPOSITORY_URL = "git+https://github.com/nklisch/pi-extensions.git";
export const REQUIRED_SCOPE = "@nklisch/";
export const PACKAGE_PREFIX = "pi-";
export const packagesDirectory = new URL("../packages/", import.meta.url);

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
