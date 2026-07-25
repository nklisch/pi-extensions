import type { ContentDigest } from "../domain/content-manifest.js";
import type { TrustedInstallCandidate } from "./trusted-install-candidate.js";
import type { ConfigurationPathContext } from "./ports/configuration-path.js";
import type { LifecycleStateStore } from "./ports/lifecycle-state-store.js";
import type {
  PluginLifecycleResult,
  PluginLifecycleService,
  PreparedInstallLifecycleAuthority,
} from "./plugin-lifecycle-service.js";

export type TrustedInstallLifecycleResult =
  | Readonly<{ kind: "lifecycle"; result: PluginLifecycleResult; enabledExisting: boolean }>
  | Readonly<{ kind: "current-state"; activation: "enabled"; revision: TrustedInstallCandidate["revision"]["revision"] }>
  | Readonly<{ kind: "conflict"; reason: "already-installed-different-revision" | "pending-transition" }>
  | Readonly<{ kind: "recovery-required" }>
  | Readonly<{
      kind: "boundary-failure";
      boundary: "before-transaction";
      reason: "aborted" | "adapter-failed" | "cleanup-failed";
    }>;

export type TrustedInstallLifecycleDependencies = Readonly<{
  state: LifecycleStateStore;
  prepared: PreparedInstallLifecycleAuthority;
  publicLifecycle: Pick<PluginLifecycleService, "enable">;
}>;

function sourceContext(candidate: TrustedInstallCandidate): import("./source-materialization.js").SourceContext {
  return candidate.resolved.entry.source.value.kind === "marketplace-path"
    ? {
        kind: "marketplace",
        root: candidate.resolved.marketplace.root,
        source: candidate.resolved.marketplace.source,
        contentRootDigest: candidate.resolved.marketplace.content.rootDigest,
        content: candidate.resolved.marketplace.content,
        binding: candidate.resolved.marketplace.binding,
      }
    : { kind: "external" };
}

async function releaseBeforeTransaction(
  candidate: TrustedInstallCandidate,
): Promise<Extract<TrustedInstallLifecycleResult, { kind: "boundary-failure" }> | undefined> {
  try {
    await candidate.lease.release();
    return undefined;
  } catch {
    return { kind: "boundary-failure", boundary: "before-transaction", reason: "cleanup-failed" };
  }
}

/** Select install/enable/current/conflict, leaving all mutation semantics to lifecycle. */
export async function executeTrustedInstallLifecycle(
  candidate: TrustedInstallCandidate,
  configurationPathContext: ConfigurationPathContext,
  dependencies: TrustedInstallLifecycleDependencies,
  signal: AbortSignal,
  expectedConfigurationRevision?: ContentDigest,
): Promise<TrustedInstallLifecycleResult> {
  if (signal.aborted) {
    return { kind: "boundary-failure", boundary: "before-transaction", reason: "aborted" };
  }
  let loaded: Awaited<ReturnType<LifecycleStateStore["read"]>>;
  try {
    loaded = await dependencies.state.read(candidate.resolved.scope, signal);
  } catch {
    return {
      kind: "boundary-failure",
      boundary: "before-transaction",
      reason: signal.aborted ? "aborted" : "adapter-failed",
    };
  }
  if (!loaded.ok) {
    const cleanup = await releaseBeforeTransaction(candidate);
    return cleanup ?? { kind: "recovery-required" };
  }
  const records = "installed" in loaded.snapshot ? loaded.snapshot.installed.plugins : loaded.snapshot.project.plugins;
  const current = records.find((record) => record.plugin === candidate.binding.plugin);
  if (current?.pendingTransition !== undefined) {
    const cleanup = await releaseBeforeTransaction(candidate);
    return cleanup ?? { kind: "conflict", reason: "pending-transition" };
  }
  if (current !== undefined && current.selectedRevision !== candidate.binding.immutableRevision) {
    const cleanup = await releaseBeforeTransaction(candidate);
    return cleanup ?? { kind: "conflict", reason: "already-installed-different-revision" };
  }
  if (current?.activation === "enabled") {
    const cleanup = await releaseBeforeTransaction(candidate);
    return cleanup ?? { kind: "current-state", activation: "enabled", revision: candidate.binding.immutableRevision };
  }
  if (current?.activation === "disabled") {
    const cleanup = await releaseBeforeTransaction(candidate);
    if (cleanup !== undefined) return cleanup;
    return {
      kind: "lifecycle",
      enabledExisting: true,
      result: await dependencies.publicLifecycle.enable({
        scope: candidate.resolved.scope,
        plugin: candidate.binding.plugin,
        configurationPathContext,
        ...(expectedConfigurationRevision === undefined ? {} : { expectedConfigurationRevision }),
      }, signal),
    };
  }
  return {
    kind: "lifecycle",
    enabledExisting: false,
    result: await dependencies.prepared.installPrepared({
      scope: candidate.resolved.scope,
      plugin: candidate.binding.plugin,
      entry: candidate.resolved.entry,
      marketplaceSource: candidate.resolved.marketplace.source,
      sourceContext: sourceContext(candidate),
      lease: candidate.lease,
      expected: candidate.binding,
      ...(expectedConfigurationRevision === undefined ? {} : { expectedConfigurationRevision }),
      configurationPathContext,
    }, signal),
  };
}
