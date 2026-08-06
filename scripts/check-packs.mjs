import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadPackages } from "./package-catalog.mjs";
import { isNativePlatformPackage } from "./native-packages.mjs";

const packScript = join(dirname(fileURLToPath(import.meta.url)), "pack-package.mjs");

for (const pkg of await loadPackages()) {
  if (
    isNativePlatformPackage(pkg.manifest) &&
    !existsSync(join(pkg.directory, pkg.manifest.main))
  ) {
    console.log(
      `Validated ${pkg.manifest.name}@${pkg.manifest.version} platform manifest (binary is release-staged).`,
    );
    continue;
  }

  const result = spawnSync("node", [packScript, pkg.directory, "--dry-run"], {
    encoding: "utf8",
  });
  if (result.status !== 0) {
    process.stderr.write(result.stdout);
    process.stderr.write(result.stderr);
    process.exit(result.status ?? 1);
  }

  const report = JSON.parse(result.stdout);
  const files = report[0]?.files?.map(({ path }) => path) ?? [];
  if (!files.includes("package.json")) throw new Error(`${pkg.manifest.name}: package.json is missing from tarball`);

  for (const target of publishedEntryTargets(pkg.manifest)) {
    const normalized = target.replace(/^\.\//, "");
    if (!files.includes(normalized)) {
      throw new Error(`${pkg.manifest.name}: published entry target ${target} is missing from tarball`);
    }
  }

  if (pkg.manifest.napi !== undefined) {
    const nativeBinaries = files.filter((file) => file.endsWith(".node"));
    if (nativeBinaries.length > 0) {
      throw new Error(
        `${pkg.manifest.name}: root tarball must not contain host-specific native binaries: ${nativeBinaries.join(", ")}`,
      );
    }
  }

  for (const resourceKind of ["extensions", "skills", "prompts", "themes"]) {
    for (const resourcePath of pkg.manifest.pi[resourceKind] ?? []) {
      if (
        resourcePath.includes("*") ||
        resourcePath.endsWith(`/${resourceKind}`) ||
        resourcePath === `./${resourceKind}`
      ) {
        const prefix = resourcePath.replace(/^\.\//, "").replace(/\*.*$/, "");
        if (!files.some((file) => file.startsWith(prefix))) {
          throw new Error(`${pkg.manifest.name}: tarball does not contain ${resourcePath}`);
        }
        continue;
      }
      const normalized = resourcePath.replace(/^\.\//, "");
      if (!files.includes(normalized)) {
        throw new Error(`${pkg.manifest.name}: tarball does not contain ${resourcePath}`);
      }
    }
  }
  console.log(`Packed ${pkg.manifest.name}@${pkg.manifest.version} (${files.length} files).`);
}

function publishedEntryTargets(manifest) {
  const targets = [];
  collectTarget(manifest.main, targets);
  collectTarget(manifest.types, targets);
  collectTarget(manifest.bin, targets);
  collectTarget(manifest.exports, targets);
  return [...new Set(targets.filter((target) => target.startsWith("./")))];
}

function collectTarget(value, targets) {
  if (typeof value === "string") {
    targets.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) collectTarget(entry, targets);
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const entry of Object.values(value)) collectTarget(entry, targets);
  }
}
