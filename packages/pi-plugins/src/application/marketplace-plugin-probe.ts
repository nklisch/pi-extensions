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
const PROBE_CONCURRENCY = 4;

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
    const targets = installed.sort((left, right) => left.plugin.localeCompare(right.plugin));
    // Each iteration owns its staging slot and is read-only against state, so
    // probes run with bounded parallelism. Indexed results preserve the
    // sorted plugin order: the notice array lands in state and must stay
    // deterministic.
    const probeOne = async (record: (typeof targets)[number]): Promise<MarketplacePluginProbeResult | undefined> => {
      const entry = byPlugin.get(record.plugin);
      const current = record.revisions.find((revision) => revision.revision === record.selectedRevision);
      if (entry === undefined || current === undefined) return undefined;
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
        if (!inspected.ok) return undefined;
        const plugin = inspected.value;
        if (plugin.identity.key !== record.plugin) throw new Error("catalog plugin identity changed during update probe");
        const compatibility = await input.compatibility.assess({
          plugin,
          ...(entry.policy === undefined ? {} : { marketplacePolicy: entry.policy }),
        }, request.signal);
        if (!compatibility.activatable) return undefined;
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
        if (revision.revision === current.revision) return undefined;
        const available = AvailableRevisionSchema.parse({
          immutableRevision: revision.revision,
          marketplaceSourceIdentity,
          pluginSourceIdentity,
          ...(declaredVersion === undefined ? {} : { declaredVersion }),
          sourceRevision: sourceRevision(materialized.source),
        });
        return Object.freeze({
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
        });
      } finally {
        await input.content.discardStaging(allocation, new AbortController().signal).catch(() => undefined);
      }
    };
    const indexed: Array<MarketplacePluginProbeResult | undefined> = new Array(targets.length);
    let cursor = 0;
    // First failure wins: stop scheduling new probes, but let every STARTED
    // probe finish its staging cleanup before the error propagates. Plain
    // Promise.all rejection would strand sibling workers mid-materialize
    // while the caller discards the marketplace staging they read from.
    let firstError: unknown;
    const worker = async () => {
      while (firstError === undefined && cursor < targets.length) {
        const index = cursor;
        cursor += 1;
        try {
          request.signal.throwIfAborted();
          indexed[index] = await probeOne(targets[index]!);
        } catch (error) {
          firstError ??= error;
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(PROBE_CONCURRENCY, targets.length) }, worker));
    if (firstError !== undefined) throw firstError;
    return Object.freeze(indexed.filter((result): result is MarketplacePluginProbeResult => result !== undefined));
  };
}
