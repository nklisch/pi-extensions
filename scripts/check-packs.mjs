import { spawnSync } from "node:child_process";
import { loadPackages } from "./package-catalog.mjs";

for (const pkg of await loadPackages()) {
  const result = spawnSync("npm", ["pack", "--dry-run", "--json"], {
    cwd: pkg.directory,
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
  for (const extensionPath of pkg.manifest.pi.extensions) {
    if (extensionPath.includes("*") || extensionPath.endsWith("/extensions") || extensionPath === "./extensions") {
      const prefix = extensionPath.replace(/^\.\//, "").replace(/\*.*$/, "");
      if (!files.some((file) => file.startsWith(prefix))) throw new Error(`${pkg.manifest.name}: tarball does not contain ${extensionPath}`);
      continue;
    }
    const normalized = extensionPath.replace(/^\.\//, "");
    if (!files.includes(normalized)) throw new Error(`${pkg.manifest.name}: tarball does not contain ${extensionPath}`);
  }
  console.log(`Packed ${pkg.manifest.name}@${pkg.manifest.version} (${files.length} files).`);
}
