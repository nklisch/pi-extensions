import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { loadPackages } from "./package-catalog.mjs";

export async function listPublishPackageNames() {
  return (await loadPackages()).map((pkg) => pkg.manifest.name);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  for (const name of await listPublishPackageNames()) console.log(name);
}
