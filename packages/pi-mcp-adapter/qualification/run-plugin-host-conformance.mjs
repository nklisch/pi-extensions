import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pluginHostRoot = process.env.PLUGIN_HOST_ROOT
  ? resolve(process.env.PLUGIN_HOST_ROOT)
  : undefined;
if (!pluginHostRoot) {
  throw new Error("Set PLUGIN_HOST_ROOT to the Plugin Host checkout containing the committed MCP contract");
}
const contract = join(pluginHostRoot, "test", "contract", "mcp-runtime.contract.ts");
const vitest = join(pluginHostRoot, "node_modules", ".bin", "vitest");
if (!existsSync(contract)) throw new Error(`Plugin Host contract is missing: ${contract}`);
if (!existsSync(vitest)) throw new Error(`Install Plugin Host dependencies first: ${vitest}`);

const workspace = mkdtempSync(join(tmpdir(), "pi-mcp-host-conformance-"));
try {
  const packed = JSON.parse(execFileSync("npm", ["pack", "--json", "--pack-destination", workspace], {
    cwd: root,
    encoding: "utf8",
  }));
  if (!Array.isArray(packed) || packed.length !== 1) throw new Error("npm pack returned no unique package receipt");
  const receipt = packed[0];
  const tarball = join(workspace, receipt.filename);
  writeFileSync(join(workspace, "package.json"), JSON.stringify({
    name: "pi-mcp-adapter-host-qualification",
    private: true,
    type: "module",
  }, null, 2));
  execFileSync("npm", ["install", "--ignore-scripts", tarball], {
    cwd: workspace,
    stdio: "pipe",
  });
  copyFileSync(
    join(root, "qualification", "plugin-host-packed.test.ts"),
    join(workspace, "plugin-host-packed.test.ts"),
  );

  const result = spawnSync(vitest, ["run", "plugin-host-packed.test.ts"], {
    cwd: workspace,
    env: { ...process.env, PLUGIN_HOST_ROOT: pluginHostRoot },
    encoding: "utf8",
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);

  const manifest = JSON.parse(readFileSync(
    join(workspace, "node_modules", "@nklisch", "pi-mcp-adapter", "package.json"),
    "utf8",
  ));
  console.log(JSON.stringify({
    package: `${manifest.name}@${manifest.version}`,
    filename: receipt.filename,
    integrity: receipt.integrity,
    shasum: receipt.shasum,
    pluginHostContract: contract,
    node: process.version,
  }, null, 2));
} finally {
  rmSync(workspace, { recursive: true, force: true });
}
