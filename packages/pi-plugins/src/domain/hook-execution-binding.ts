import type { ComponentId } from "./components.js";
import type { ContentDigest } from "./content-manifest.js";
import type { PluginKey } from "./identity.js";
import type { ScopeReference } from "./state/scope.js";

export type HookExecutionBinding = Readonly<{
  scope: ScopeReference;
  plugin: PluginKey;
  revision: ContentDigest;
  projectionDigest: ContentDigest;
  contributionDigest: ContentDigest;
  componentId: ComponentId;
  sourceOrder: Readonly<{ snapshotOrdinal: number; hookOrdinal: number }>;
}>;
