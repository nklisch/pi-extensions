/**
 * Bundle verification for @nklisch/pi-enhanced.
 *
 * The harness is pure composition: its pi manifest references resources inside
 * bundled dependencies through ./node_modules/ paths. Those paths only exist
 * inside the packed tarball, so the meaningful test is "does every declared
 * resource path actually land in the pack?"
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

// Pack through the repo's bundle-aware packer; npm pack alone drops
// bundleDependencies inside workspaces.
const raw = execFileSync(
  "node",
  [join(root, "../../scripts/pack-package.mjs"), root, "--dry-run"],
  { encoding: "utf8" },
);
const pack = JSON.parse(raw);
const files = new Set(pack[0].files.map((entry) => entry.path));

const declared = [
  ...(manifest.pi.extensions ?? []),
  ...(manifest.pi.skills ?? []),
  ...(manifest.pi.themes ?? []),
].map((p) => p.replace(/^\.\//, ""));

const failures = [];
for (const declaredPath of declared) {
  // A declared path may be a directory, a single file, or a SKILL.md path.
  // It is satisfied when the tarball contains the path itself or anything
  // beneath it.
  const hit = [...files].some((f) => f === declaredPath || f.startsWith(`${declaredPath}/`));
  if (!hit) failures.push(declaredPath);
}

// Every bundled dependency must itself be present in the tarball.
for (const dep of manifest.bundledDependencies ?? []) {
  const hit = [...files].some((f) => f.startsWith(`node_modules/${dep}/package.json`));
  if (!hit) failures.push(`node_modules/${dep}/package.json (bundled dependency missing)`);
}

if (failures.length > 0) {
  console.error(`Bundle verification failed:\n- ${failures.join("\n- ")}`);
  process.exit(1);
}

console.log(
  `Bundle OK: ${declared.length} declared resource paths and ${manifest.bundledDependencies.length} bundled dependencies present (${files.size} files).`,
);
