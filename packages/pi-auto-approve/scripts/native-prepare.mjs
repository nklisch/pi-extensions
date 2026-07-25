import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const artifacts = [
  join(root, "native", "clearance-core.linux-x64-gnu.node"),
  join(root, "native", "clearance-core.darwin-arm64.node"),
];

for (const artifact of artifacts) {
  if (!existsSync(artifact)) {
    throw new Error(
      `native publish preparation requires both prebuilds; missing ${artifact}`,
    );
  }
}

run("pnpm", ["exec", "napi", "artifacts", "--output-dir", "native", "--npm-dir", "npm"]);

for (const artifact of artifacts) {
  const staged = join(root, "npm", artifact.includes("linux") ? "linux-x64-gnu" : "darwin-arm64", artifact.split("/").at(-1));
  if (!existsSync(staged)) {
    throw new Error(`napi did not stage required prebuild ${staged}`);
  }
}

run("pnpm", [
  "exec",
  "napi",
  "pre-publish",
  "--gh-release=false",
  "--skip-optional-publish",
]);

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} exited with status ${result.status}`);
  }
}
