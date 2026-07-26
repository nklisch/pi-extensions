import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadPackages } from "./package-catalog.mjs";

const selector = process.argv[2];
const local = process.argv.includes("--local");
if (!selector) {
  console.error("Usage: npm run publish:package -- <all|directory|@nklisch/package> [--local]");
  console.error("  --local: interactive publish from this machine (2FA prompt, no CI provenance).");
  console.error("           Needed once per never-published package before trust can be configured.");
  process.exit(2);
}

const catalog = await loadPackages();
const selected = selector === "all"
  ? catalog
  : catalog.filter((pkg) => pkg.directoryName === selector || pkg.manifest.name === selector);

if (selected.length === 0) {
  console.error(`Unknown package: ${selector}`);
  console.error(`Available: all, ${catalog.map((pkg) => pkg.directoryName).join(", ")}`);
  process.exit(2);
}

for (const pkg of selected) {
  const spec = `${pkg.manifest.name}@${pkg.manifest.version}`;
  const view = spawnSync("npm", ["view", spec, "version"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (view.status === 0) {
    console.log(`${spec} is already published; skipping.`);
    continue;
  }

  console.log(`Packing ${spec} (bundle-aware)...`);
  const packScript = join(dirname(fileURLToPath(import.meta.url)), "pack-package.mjs");
  const pack = spawnSync("node", [packScript, pkg.directory], { encoding: "utf8" });
  if (pack.status !== 0) {
    process.stderr.write(pack.stdout);
    process.stderr.write(pack.stderr);
    process.exit(pack.status ?? 1);
  }
  const report = JSON.parse(pack.stdout);
  const tarball = join(pkg.directory, report[0].filename);

  console.log(`Publishing ${spec} from ${pkg.directoryName}...`);
  // Provenance statements are only generated in CI (OIDC); local first-time
  // publishes authenticate interactively and ship without them. The flag
  // must be explicit both ways: every package carries publishConfig
  // .provenance=true in its manifest (validator policy for CI), which npm
  // honors even for local publishes unless negated. --tag is explicit so
  // prerelease versions (the forks' -nklisch.N suffixes) publish cleanly.
  const publishArgs = ["publish", tarball, "--access", "public", "--tag", "latest"];
  publishArgs.push(local ? "--no-provenance" : "--provenance");
  const publish = spawnSync("npm", publishArgs, {
    cwd: pkg.directory,
    stdio: "inherit",
  });
  rmSync(tarball, { force: true });
  if (publish.status !== 0) process.exit(publish.status ?? 1);

  // Fork convention: maintained-fork prereleases also carry the `maintained`
  // dist-tag (see pi-subagents/pi-mcp-adapter MAINTAINING docs).
  if (pkg.manifest.version.includes("-nklisch.")) {
    const tag = spawnSync("npm", ["dist-tag", "add", spec, "maintained"], { stdio: "inherit" });
    if (tag.status !== 0) process.exit(tag.status ?? 1);
  }
}
