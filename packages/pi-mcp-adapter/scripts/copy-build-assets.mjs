import { copyFile, mkdir } from "node:fs/promises";

const assets = [
  "app-bridge.bundle.js",
  "mcp-keyring-helper.cjs",
  "mcp-script-worker.mjs",
];

await mkdir(new URL("../dist/", import.meta.url), { recursive: true });
await Promise.all(assets.map((asset) => copyFile(
  new URL(`../${asset}`, import.meta.url),
  new URL(`../dist/${asset}`, import.meta.url),
)));
