import { spawnSync } from "node:child_process";
import { loadPackages } from "./package-catalog.mjs";

const selector = process.argv[2];
if (!selector) {
  console.error("Usage: npm run publish:package -- <all|directory|@nklisch/package>");
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

  console.log(`Publishing ${spec} from ${pkg.directoryName}...`);
  const publish = spawnSync("npm", ["publish", "--access", "public", "--provenance"], {
    cwd: pkg.directory,
    stdio: "inherit",
  });
  if (publish.status !== 0) process.exit(publish.status ?? 1);
}
