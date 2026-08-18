import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadPackages, orderPackagesForPublish } from "./package-catalog.mjs";
import {
  nativeArtifactDescriptors,
  requireNativeArtifacts,
} from "./native-packages.mjs";

const selector = process.argv[2];
const local = process.argv.includes("--local");
if (!selector) {
  console.error("Usage: npm run publish:package -- <all|directory|@nklisch/package> [--local]");
  console.error("  --local: interactive publish from this machine (2FA prompt, no CI provenance).");
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

for (const pkg of orderPackagesForPublish(selected)) {
  // CI stages every cross-built artifact into the existing package before this
  // point. Refuse partial releases even if the publisher host can load one.
  if (nativeArtifactDescriptors(pkg).length > 0) requireNativeArtifacts(pkg);
  assertOptionalDependenciesPublished(pkg);
  publishOne(pkg);
}

function isPublished(spec) {
  const view = spawnSync("npm", ["view", spec, "version"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return view.status === 0;
}

function assertOptionalDependenciesPublished(pkg) {
  for (const [name, range] of Object.entries(pkg.manifest.optionalDependencies ?? {})) {
    if (!isPublished(`${name}@${range}`)) {
      throw new Error(
        `${pkg.manifest.name}: optional dependency ${name}@${range} must be published first`,
      );
    }
  }
}

function publishOne(pkg) {
  const spec = `${pkg.manifest.name}@${pkg.manifest.version}`;
  if (isPublished(spec)) {
    console.log(`${spec} is already published; skipping.`);
    return;
  }

  console.log(`Packing ${spec} (bundle-aware)...`);
  const packScript = join(dirname(fileURLToPath(import.meta.url)), "pack-package.mjs");
  const pack = spawnSync("node", [packScript, pkg.directory], { encoding: "utf8" });
  if (pack.status !== 0) {
    process.stderr.write(pack.stdout);
    process.stderr.write(pack.stderr);
    throw new Error(`packing ${spec} failed with status ${pack.status ?? 1}`);
  }
  const report = JSON.parse(pack.stdout);
  const tarball = join(pkg.directory, report[0].filename);

  try {
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
    if (publish.status !== 0) {
      throw new Error(`publishing ${spec} failed with status ${publish.status ?? 1}`);
    }
  } finally {
    rmSync(tarball, { force: true });
  }

  // Fork convention: maintained-fork prereleases also carry the `maintained`
  // dist-tag (see pi-subagents/pi-mcp-adapter MAINTAINING docs). OIDC trusted
  // publishing only authenticates `publish` — dist-tag needs a real login, so
  // this only runs for interactive --local publishes; in CI it is skipped and
  // can be applied by hand afterward.
  if (local && pkg.manifest.version.includes("-nklisch.")) {
    const tag = spawnSync("npm", ["dist-tag", "add", spec, "maintained"], { stdio: "inherit" });
    if (tag.status !== 0) {
      throw new Error(`tagging ${spec} failed with status ${tag.status ?? 1}`);
    }
  }
}
