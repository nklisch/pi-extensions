import { readFile } from "node:fs/promises";
import * as piApi from "@nklisch/pi-plugins/pi";

const expected = [
  "PackagedPluginHostError",
  "PackagedPluginHostErrorCode",
  "createPackagedPluginHost",
].sort();
const actual = Object.keys(piApi).sort();
if (JSON.stringify(actual) !== JSON.stringify(expected)) {
  throw new Error(`compiled Pi subpath export allowlist mismatch\nexpected: ${JSON.stringify(expected)}\nactual: ${JSON.stringify(actual)}`);
}
const metadata = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
if (!metadata.keywords?.includes("pi-package") || JSON.stringify(metadata.pi?.extensions) !== JSON.stringify(["./dist/pi/production-subagents-extension.js", "./dist/pi/extension.js"])) {
  throw new Error("Pi package discovery metadata is invalid");
}
if (metadata.dependencies?.["@nklisch/pi-mcp-adapter"] !== "2.11.0-nklisch.3" || metadata.dependencies?.["@nklisch/pi-subagents"] !== "18.0.4-nklisch.0") {
  throw new Error("published runtime dependencies are not exact");
}
if (JSON.stringify(metadata.bundledDependencies) !== JSON.stringify(["@nklisch/pi-subagents"])) {
  throw new Error("published subagent extension is not bundled");
}
if (metadata.devDependencies?.["@earendil-works/pi-coding-agent"] !== "0.80.8" || metadata.devDependencies?.["@earendil-works/pi-tui"] !== "0.80.8") {
  throw new Error("Pi 0.80.8 development contracts are not exact");
}
if (metadata.peerDependencies?.["@earendil-works/pi-coding-agent"] !== "*" || metadata.peerDependencies?.["@earendil-works/pi-tui"] !== "*") {
  throw new Error("Pi runtime peer contracts are invalid");
}
await import(new URL("../dist/pi/production-subagents-extension.js", import.meta.url));
await import(new URL("../dist/pi/extension.js", import.meta.url));
console.log(`compiled Pi package import passed (${actual.length} exports)`);
