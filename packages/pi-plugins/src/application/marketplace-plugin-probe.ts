import type { CompatibilityService } from "./compatibility-service.js";
import type { PluginInspectionService } from "./inspection-service.js";
import type { MarketplacePluginProbePort, MarketplacePluginProbeResult } from "./marketplace-refresh-service.js";
import type { ContentStorePort } from "./ports/content-store.js";
import type { LifecycleStateStore } from "./ports/lifecycle-state-store.js";
import type { PluginMaterializer, SourceContext } from "./source-materialization.js";
import { createInstalledRevisionRecord } from "../domain/state/installed-state.js";
import { toScopeReference } from "../domain/state/scope.js";
import type { ResolvedPluginSource, Sha256 } from "../domain/source.js";
import { AvailableRevisionSchema, deriveMarketplaceSourceIdentity, derivePluginSourceIdentity, deriveUpdateCandidateKey } from "../domain/update-policy.js";

function sourceRevision(source: ResolvedPluginSource): string {
  switch (source.kind) {
    case "marketplace-path": return source.marketplaceRevision;
    case "git":
    case "git-subdir": return source.revision;
    case "npm": return source.version;
  }
}

/** Probe installed catalog entries without promoting or retaining staging bytes. */
export function createMarketplacePluginProbe(input: Readonly<{
  state: LifecycleStateStore;
  content: ContentStorePort;
  materializer: PluginMaterializer;
  inspector: PluginInspectionService;
  compatibility: CompatibilityService;
  sha256: Sha256;
}>): MarketplacePluginProbePort {
  if (input === null || typeof input !== "object" || typeof input.sha256 !== "function") {
    throw new TypeError("marketplace plugin probe dependencies are required");
  }
  return async (request): Promise<readonly MarketplacePluginProbeResult[]> => {
    request.signal.throwIfAborted();
    const loaded = await input.state.read(request.scope, request.signal);
    if (!loaded.ok) throw new Error("STATE_CORRUPT");
    const installed = ("installed" in loaded.snapshot ? loaded.snapshot.installed.plugins : loaded.snapshot.project.plugins)
      .filter((record) => record.plugin.endsWith(`@${request.snapshot.marketplace}`));
    const byPlugin = new Map(request.catalog.marketplace.entries.map((entry) => [entry.identity.value.key, entry]));
    const results: MarketplacePluginProbeResult[] = [];
    for (const record of installed.sort((left, right) => left.plugin.localeCompare(right.plugin))) {
      request.signal.throwIfAborted();
      const entry = byPlugin.get(record.plugin);
      const current = record.revisions.find((revision) => revision.revision === record.selectedRevision);
      if (entry === undefined || current === undefined) continue;
      const allocation = await input.content.allocateStaging(request.signal);
      try {
        const context: SourceContext = entry.source.value.kind === "marketplace-path"
          ? {
              kind: "marketplace",
              root: request.marketplace.root,
              source: request.marketplace.source,
              contentRootDigest: request.marketplace.content.rootDigest,
              content: request.marketplace.content,
              binding: request.marketplace.binding,
            }
          : { kind: "external" };
        const materialized = await input.materializer.materialize(entry.source.value, context, allocation.slot, request.signal);
        const inspected = await input.inspector.inspect({ entry, materialized }, request.signal);
        if (!inspected.ok) continue;
        const plugin = inspected.value;
        if (plugin.identity.key !== record.plugin) throw new Error("catalog plugin identity changed during update probe");
        const compatibility = await input.compatibility.assess({
          plugin,
          ...(entry.policy === undefined ? {} : { marketplacePolicy: entry.policy }),
        }, request.signal);
        if (!compatibility.activatable) continue;
        const declaredVersion = plugin.version?.value ?? entry.version?.value;
        const marketplaceSourceIdentity = deriveMarketplaceSourceIdentity(request.record.source, input.sha256);
        const pluginSourceIdentity = derivePluginSourceIdentity(entry.source.value, input.sha256);
        const revision = createInstalledRevisionRecord({
          plugin,
          compatibility,
          content: materialized.content,
          scope: toScopeReference(request.scope),
          marketplaceSourceIdentity,
          pluginSourceIdentity,
          ...(declaredVersion === undefined ? {} : { declaredVersion }),
        }, input.sha256);
        if (revision.revision === current.revision) continue;
        const available = AvailableRevisionSchema.parse({
          immutableRevision: revision.revision,
          marketplaceSourceIdentity,
          pluginSourceIdentity,
          ...(declaredVersion === undefined ? {} : { declaredVersion }),
          sourceRevision: sourceRevision(materialized.source),
        });
        results.push(Object.freeze({
          plugin: record.plugin,
          entry,
          available,
          candidate: deriveUpdateCandidateKey({
            scope: toScopeReference(request.scope),
            plugin: record.plugin,
            marketplaceSourceIdentity: available.marketplaceSourceIdentity,
            pluginSourceIdentity: available.pluginSourceIdentity,
            immutableRevision: available.immutableRevision,
          }, input.sha256),
          display: Object.freeze({
            installed: current.evidence.source.declaredVersion ?? current.evidence.source.sourceRevision ?? current.revision,
            available: available.declaredVersion ?? available.sourceRevision,
          }),
        }));
      } finally {
        await input.content.discardStaging(allocation, new AbortController().signal).catch(() => undefined);
      }
    }
    return Object.freeze(results);
  };
}
