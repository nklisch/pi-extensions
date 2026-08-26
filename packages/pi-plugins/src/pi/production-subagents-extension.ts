import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as piAi from "@earendil-works/pi-ai";
import * as piAiCompat from "@earendil-works/pi-ai/compat";
import * as piCodingAgent from "@earendil-works/pi-coding-agent";
import * as piTui from "@earendil-works/pi-tui";
import { createJiti, type Jiti } from "jiti/static";

const require = createRequire(import.meta.url);
let childLoader: Jiti | undefined;

function loader(): Jiti {
  childLoader ??= createJiti(import.meta.url, {
    virtualModules: {
      "@earendil-works/pi-ai": piAi,
      "@earendil-works/pi-ai/compat": piAiCompat,
      "@earendil-works/pi-coding-agent": piCodingAgent,
      "@earendil-works/pi-tui": piTui,
    },
  });
  return childLoader;
}

function packageRoot(): string {
  const entry = require.resolve("@nklisch/pi-subagents");
  // The package's public export is src/service/service.ts; its Pi resource is
  // the sibling src/index.ts named by the package manifest.
  return dirname(dirname(dirname(entry)));
}

/** Keep the bundled transitive Pi resource available without lifecycle receipts. */
export default async function productionSubagentsExtension(pi: ExtensionAPI): Promise<void> {
  try {
    const module = await loader().import(join(packageRoot(), "src/index.ts"));
    const extension = module !== null && typeof module === "object" ? (module as { default?: unknown }).default : undefined;
    if (typeof extension === "function") await (extension as (api: ExtensionAPI) => void | Promise<void>)(pi);
  } catch {
    // pi-plugins remains useful without the optional transitive feature. The
    // direct package dependency is bundled, but a damaged optional tree should
    // not prevent skills, hooks, or MCP plugins from loading.
  }
}
