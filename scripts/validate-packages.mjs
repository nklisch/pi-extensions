import { access } from "node:fs/promises";
import { join } from "node:path";
import {
  loadPackages,
  PACKAGE_PREFIX,
  REQUIRED_SCOPE,
  REPOSITORY_URL,
} from "./package-catalog.mjs";

const errors = [];
const packages = await loadPackages();
const names = new Set();

if (packages.length === 0) errors.push("No packages found under packages/.");

for (const pkg of packages) {
  const { directory, directoryName, manifest } = pkg;
  const expectedName = `${REQUIRED_SCOPE}${directoryName}`;
  const report = (message) => errors.push(`${directoryName}: ${message}`);

  if (!directoryName.startsWith(PACKAGE_PREFIX)) report(`directory must start with ${PACKAGE_PREFIX}`);
  if (manifest.name !== expectedName) report(`name must be ${expectedName}, got ${manifest.name ?? "(missing)"}`);
  if (names.has(manifest.name)) report(`duplicate package name ${manifest.name}`);
  names.add(manifest.name);
  if (manifest.private !== false) report("private must explicitly be false");
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(manifest.version ?? "")) report("version must be semver");
  if (!manifest.keywords?.includes("pi-package")) report("keywords must include pi-package");
  if (!manifest.keywords?.includes("pi-extension")) report("keywords must include pi-extension");
  if (!Array.isArray(manifest.pi?.extensions) || manifest.pi.extensions.length === 0) report("pi.extensions must declare at least one entrypoint");
  if (manifest.publishConfig?.access !== "public") report("publishConfig.access must be public");
  if (manifest.publishConfig?.provenance !== true) report("publishConfig.provenance must be true");
  if (manifest.repository?.url !== REPOSITORY_URL) report(`repository.url must be ${REPOSITORY_URL}`);
  if (manifest.repository?.directory !== `packages/${directoryName}`) report("repository.directory does not match workspace path");

  // TypeScript packages can point directly at source. Compiled packages may point
  // at dist, which is intentionally absent from a clean checkout until build.
  for (const extensionPath of manifest.pi?.extensions ?? []) {
    if (extensionPath.includes("*") || extensionPath.startsWith("./dist/")) continue;
    try {
      await access(join(directory, extensionPath));
    } catch {
      report(`declared extension path does not exist: ${extensionPath}`);
    }
  }
}

if (errors.length > 0) {
  console.error(`Package validation failed:\n- ${errors.join("\n- ")}`);
  process.exitCode = 1;
} else {
  console.log(`Validated ${packages.length} @nklisch Pi extension packages.`);
}
