import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadVerifiedPiSubagentsExtension } from "../runtime/subagents/pi-subagents-package.js";

/**
 * Candidate-owned transitive resource wrapper. Pi loads this before Plugin Host;
 * a drifted bundled package remains inert and central qualification reports the
 * subagent capability unavailable without requiring a second top-level install.
 */
export default async function productionSubagentsExtension(pi: ExtensionAPI): Promise<void> {
  const extension = await loadVerifiedPiSubagentsExtension();
  await extension?.(pi);
}
