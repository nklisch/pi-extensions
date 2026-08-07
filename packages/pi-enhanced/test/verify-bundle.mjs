/**
 * Bundle verification for @nklisch/pi-enhanced.
 *
 * The harness is pure composition: its pi manifest references resources inside
 * bundled dependencies through ./node_modules/ paths. Those paths only exist
 * inside the packed tarball, so the meaningful test is "does every declared
 * resource path actually land in the pack?"
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const clearanceManifest = JSON.parse(
  readFileSync(join(root, "../pi-clearance/package.json"), "utf8"),
);

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

const clearancePrefix = "node_modules/@nklisch/pi-clearance/";
const targetSuffix = new Map([
  ["x86_64-unknown-linux-gnu", "linux-x64-gnu"],
  ["aarch64-unknown-linux-gnu", "linux-arm64-gnu"],
  ["x86_64-apple-darwin", "darwin-x64"],
  ["aarch64-apple-darwin", "darwin-arm64"],
  ["x86_64-pc-windows-msvc", "win32-x64-msvc"],
  ["aarch64-pc-windows-msvc", "win32-arm64-msvc"],
]);
const nativeArtifacts = clearanceManifest.napi.targets.map((target) => {
  const suffix = targetSuffix.get(target);
  if (suffix === undefined) throw new Error(`Unknown Pi Clearance native target: ${target}`);
  return `${clearanceManifest.napi.binaryName}.${suffix}.node`;
});
for (const artifact of nativeArtifacts) {
  const staged = existsSync(join(root, "../pi-clearance/native", artifact));
  if (process.env.PI_NATIVE_RELEASE_ARTIFACTS === "1" && !staged) {
    failures.push(`release artifact was not staged: ${artifact}`);
  }
  if (staged && !files.has(`${clearancePrefix}native/${artifact}`)) {
    failures.push(`bundled pi-clearance is missing native/${artifact}`);
  }
}

if (failures.length > 0) {
  console.error(`Bundle verification failed:\n- ${failures.join("\n- ")}`);
  process.exit(1);
}

console.log(
  `Bundle OK: ${declared.length} declared resource paths and ${manifest.bundledDependencies.length} bundled dependencies present (${files.size} files).`,
);
