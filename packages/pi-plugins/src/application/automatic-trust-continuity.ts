import { compareUtf8 } from "../domain/canonical-json.js";
import { MarketplaceNameSchema, type PluginKey } from "../domain/identity.js";
import type { Sha256 } from "../domain/source.js";
import { createTrustCandidate, grantTrust, type TrustCandidate } from "../domain/trust-policy.js";
import {
  createTrustStateDocument,
  verifyTrustStateRecord,
  type TrustStateRecord,
} from "../domain/state/trust-state.js";
import { toScopeReference, type ScopeContext } from "../domain/state/scope.js";
import { deriveMarketplaceSourceIdentity } from "../domain/update-policy.js";
import type { InstalledPluginRecord } from "../domain/state/installed-state.js";
import { parseStateMutation, type GenerationSnapshot } from "./state-contract.js";
import { resolveEffectiveUpdatePolicy } from "./update-policy-resolution.js";
import type { GenerationMutationCoordinator } from "./generation-mutation-coordinator.js";
import type { InstalledPluginLoader } from "./ports/installed-plugin-loader.js";
import type { LifecycleStateStore } from "./ports/lifecycle-state-store.js";
import type { ProjectTrustPort } from "./ports/project-trust.js";

/**
 * Automatic trust continuity. Enabling automatic updates is the operator's
 * consent to acquire, validate, and activate compatible new revisions from the
 * same trusted source, including revisions that change hook or MCP execution
 * definitions. Exact-subject trust evaluation never infers that consent at
 * read time, so this service records the exact grant for the selected
 * revision itself whenever the automatic policy, an unchanged source lineage,
 * and a granted baseline all hold. Explicit revocation of the exact subject
 * still wins; a lineage with no granted baseline still requires interactive
 * consent.
 */
export interface AutomaticTrustContinuity {
  ensure(scope: ScopeContext, signal: AbortSignal): Promise<AutomaticTrustContinuityResult>;
}

export type AutomaticTrustContinuityResult =
  | Readonly<{ kind: "ensured"; granted: readonly string[] }>
  | Readonly<{ kind: "unavailable" }>;

export type AutomaticTrustContinuityDependencies = Readonly<{
  state: LifecycleStateStore;
  mutations: GenerationMutationCoordinator;
  installed: InstalledPluginLoader;
  projectTrust?: ProjectTrustPort;
  sha256: Sha256;
}>;

type PlannedGrant = Readonly<{
  plugin: PluginKey;
  candidate: TrustCandidate;
  record: InstalledPluginRecord;
  selected: InstalledPluginRecord["revisions"][number];
}>;

function installedPlugins(snapshot: GenerationSnapshot): readonly InstalledPluginRecord[] {
  return "installed" in snapshot ? snapshot.installed.plugins : snapshot.project.plugins;
}

function trustRecordsOf(snapshot: GenerationSnapshot): readonly TrustStateRecord[] {
  return "trust" in snapshot ? snapshot.trust.records : [];
}

function marketplaceOf(plugin: PluginKey): string {
  return plugin.slice(plugin.lastIndexOf("@") + 1);
}

/**
 * Load-free presence check for the selected revision's exact subject. The
 * subject is derived from evidence whose revision-embedded fields are fully
 * determined by the materialization binding, so a record matching plugin,
 * scope, immutable revision, and executable surface IS the exact subject.
 */
function hasExactSubjectRecord(
  records: readonly TrustStateRecord[],
  pluginRecord: InstalledPluginRecord,
  selected: InstalledPluginRecord["revisions"][number],
  scope: ScopeContext,
  sha256: Sha256,
): boolean {
  for (const raw of records) {
    let record: TrustStateRecord;
    try {
      record = verifyTrustStateRecord(raw, sha256);
    } catch {
      continue;
    }
    if (record.evidence.plugin !== pluginRecord.plugin) continue;
    if (record.evidence.scope.kind !== scope.kind ||
        (scope.kind === "project" && (record.evidence.scope.kind !== "project" || record.evidence.scope.projectKey !== scope.projectKey))) continue;
    if (record.evidence.immutableRevision === selected.revision &&
        record.evidence.executableSurfaceDigest === selected.evidence.trust.executableSurfaceDigest) {
      return true;
    }
  }
  return false;
}

/**
 * Lineage consent: an exact grant for another installed revision of the same
 * plugin whose stable source identities match the selected revision. Trust
 * evidence embeds the immutable revision in its canonical sources, so lineage
 * is anchored on installed revision records (revision digest plus executable
 * surface) rather than on the grant's canonical source text.
 */
function hasGrantedBaseline(
  records: readonly TrustStateRecord[],
  pluginRecord: InstalledPluginRecord,
  selected: InstalledPluginRecord["revisions"][number],
  scope: ScopeContext,
  sha256: Sha256,
): boolean {
  const selectedIdentity = selected.evidence.source;
  if (selectedIdentity.marketplaceSourceIdentity === undefined || selectedIdentity.pluginSourceIdentity === undefined) return false;
  for (const raw of records) {
    let record: TrustStateRecord;
    try {
      record = verifyTrustStateRecord(raw, sha256);
    } catch {
      return false;
    }
    if (record.status !== "granted") continue;
    if (record.evidence.plugin !== pluginRecord.plugin) continue;
    if (record.evidence.scope.kind !== scope.kind ||
        (scope.kind === "project" && (record.evidence.scope.kind !== "project" || record.evidence.scope.projectKey !== scope.projectKey))) continue;
    const anchor = pluginRecord.revisions.find((revision) =>
      revision.revision === record.evidence.immutableRevision &&
      revision.evidence.trust.executableSurfaceDigest === record.evidence.executableSurfaceDigest);
    if (anchor === undefined) continue;
    if (anchor.evidence.source.marketplaceSourceIdentity !== selectedIdentity.marketplaceSourceIdentity ||
        anchor.evidence.source.pluginSourceIdentity !== selectedIdentity.pluginSourceIdentity) continue;
    return true;
  }
  return false;
}

function exactRecord(records: readonly TrustStateRecord[], subject: string, sha256: Sha256): TrustStateRecord | undefined {
  for (const raw of records) {
    try {
      const record = verifyTrustStateRecord(raw, sha256);
      if (record.subject === subject) return record;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

class NoContinuityGrants extends Error {
  constructor() {
    super("locked snapshot already adjudicated every planned subject");
    this.name = "NoContinuityGrants";
  }
}

class ProjectAuthorityStale extends Error {
  constructor() {
    super("project authority changed between planning and commit");
    this.name = "ProjectAuthorityStale";
  }
}

export function createAutomaticTrustContinuity(dependencies: AutomaticTrustContinuityDependencies): AutomaticTrustContinuity {
  if (dependencies === null || typeof dependencies !== "object" || typeof dependencies.sha256 !== "function") {
    throw new TypeError("automatic trust continuity dependencies are required");
  }

  async function projectTrusted(scope: ScopeContext, signal: AbortSignal): Promise<boolean> {
    if (scope.kind === "user") return true;
    if (dependencies.projectTrust === undefined) return false;
    try {
      return (await dependencies.projectTrust.assess(scope.projectKey, signal)).kind === "trusted";
    } catch (error) {
      if (signal.aborted) throw signal.reason ?? error;
      return false;
    }
  }

  async function planGrants(scope: ScopeContext, snapshot: GenerationSnapshot, userSnapshot: GenerationSnapshot, signal: AbortSignal): Promise<readonly PlannedGrant[] | undefined> {
    const policyRecords = "config" in snapshot ? snapshot.config.records : snapshot.project.marketplaceUpdates;
    const scopedPolicy = "config" in snapshot ? snapshot.config.scope.application : snapshot.project.scope.application;
    const globalPolicy = "config" in userSnapshot ? userSnapshot.config.global.application : undefined;
    if (globalPolicy === undefined) return undefined;
    const records = trustRecordsOf(userSnapshot);
    const trusted = await projectTrusted(scope, signal);
    if (!trusted) return [];
    const planned: PlannedGrant[] = [];
    for (const pluginRecord of installedPlugins(snapshot)) {
      const plugin = pluginRecord.plugin;
      const policyRecord = policyRecords.find((record) => record.marketplace === MarketplaceNameSchema.parse(marketplaceOf(plugin)));
      if (policyRecord === undefined) continue;
      const selected = pluginRecord.revisions.find((revision) => revision.revision === pluginRecord.selectedRevision);
      if (selected === undefined) continue;
      const effective = resolveEffectiveUpdatePolicy({
        plugin,
        record: policyRecord,
        global: globalPolicy,
        ...(scopedPolicy === undefined ? {} : { scope: scopedPolicy }),
        marketplaceSourceIdentity: selected.evidence.source.marketplaceSourceIdentity ?? "legacy-unavailable",
        registeredMarketplaceSourceIdentity: deriveMarketplaceSourceIdentity(policyRecord.source, dependencies.sha256),
        pluginSourceIdentity: selected.evidence.source.pluginSourceIdentity ?? "legacy-unavailable",
      });
      if (effective.application !== "automatic" || effective.sourceGuard !== "none") continue;
      // Already-adjudicated subjects (granted or revoked) and plugins with no
      // granted lineage never need their retained content loaded. Continuity
      // runs every background cycle, so keep the steady state disk-free.
      if (hasExactSubjectRecord(records, pluginRecord, selected, scope, dependencies.sha256)) continue;
      if (!hasGrantedBaseline(records, pluginRecord, selected, scope, dependencies.sha256)) continue;
      let loaded: Awaited<ReturnType<InstalledPluginLoader["load"]>>;
      try {
        loaded = await dependencies.installed.load({ scope, revision: selected }, signal);
      } catch (error) {
        if (signal.aborted) throw signal.reason ?? error;
        // Fail closed for this subject only; one unavailable plugin must not
        // block continuity for every other plugin in the scope.
        continue;
      }
      let candidate: TrustCandidate;
      try {
        candidate = createTrustCandidate({
          scope: toScopeReference(scope),
          marketplaceSource: loaded.marketplaceSource,
          plugin: loaded.plugin,
          compatibility: loaded.compatibility,
          content: loaded.content,
          materializationBinding: loaded.binding,
        }, dependencies.sha256);
      } catch {
        continue;
      }
      // The load-free checks above established absence of any exact record
      // and the presence of a baseline; the candidate only names the subject
      // being granted.
      planned.push({ plugin, candidate, record: pluginRecord, selected });
    }
    return planned;
  }

  async function ensure(scope: ScopeContext, signal: AbortSignal): Promise<AutomaticTrustContinuityResult> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      signal.throwIfAborted();
      const loaded = await dependencies.state.read(scope, signal).catch((error: unknown) => {
        if (signal.aborted) throw error;
        return undefined;
      });
      if (loaded === undefined) return { kind: "unavailable" };
      if (!loaded.ok) return { kind: "unavailable" };
      // Trust authority is always user state, even for project-scope plugins.
      const userLoaded = scope.kind === "user"
        ? loaded
        : await dependencies.state.read({ kind: "user" }, signal).catch((error: unknown) => {
            if (signal.aborted) throw error;
            return undefined;
          });
      if (userLoaded === undefined || !userLoaded.ok || !("trust" in userLoaded.snapshot)) return { kind: "unavailable" };
      const planned = await planGrants(scope, loaded.snapshot, userLoaded.snapshot, signal);
      if (planned === undefined) return { kind: "unavailable" };
      if (planned.length === 0) return { kind: "ensured", granted: [] };
      const outcome = await (async () => {
        try {
          return { result: await dependencies.mutations.runPreparedMutation(
        {
          scope: { kind: "user" },
          plugins: planned.map((entry) => entry.plugin),
          expectedGeneration: userLoaded.snapshot.generation,
        },
        async (context) => {
          if (!("trust" in context.snapshot)) throw new Error("trust authority is not user state");
          const current = context.snapshot.trust.records;
          const additions: TrustStateRecord[] = [];
          for (const entry of planned) {
            // Re-adjudicate inside the locked snapshot: a concurrent grant or
            // revocation of the exact subject since planning wins.
            if (exactRecord(current, entry.candidate.subject, dependencies.sha256) !== undefined) continue;
            if (!hasGrantedBaseline(current, entry.record, entry.selected, scope, dependencies.sha256)) continue;
            additions.push(grantTrust(entry.candidate, dependencies.sha256));
          }
          // Re-adjudication can remove every planned subject (concurrent
          // grant or baseline revocation). Never commit a no-op trust
          // replacement: churning the user generation moves authority under
          // foreground readers for no semantic change.
          if (additions.length === 0) throw new NoContinuityGrants();
          const records = [...current, ...additions].sort((left, right) => compareUtf8(left.subject, right.subject));
          const trust = createTrustStateDocument({
            schemaVersion: 1,
            generation: context.snapshot.generation,
            records,
          }, dependencies.sha256);
          return {
            mutation: parseStateMutation({
              scope: { kind: "user" },
              expectedGeneration: context.snapshot.generation,
              replace: { trust },
            }, dependencies.sha256),
            value: additions.map((record) => record.subject),
            ...(scope.kind === "project" ? {
              // The locked snapshot is user state; project authority (trust,
              // policy, selected revision, baseline) can move underneath the
              // plan from another session without advancing the user
              // generation. Re-adjudicate the exact plan against fresh
              // project authority immediately before commit.
              beforeCommit: async () => {
                if (!await projectTrusted(scope, signal)) throw new ProjectAuthorityStale();
                const fresh = await dependencies.state.read(scope, signal);
                if (!fresh.ok) throw new ProjectAuthorityStale();
                const replanned = await planGrants(scope, fresh.snapshot, context.snapshot, signal);
                if (replanned === undefined) throw new ProjectAuthorityStale();
                const wanted = planned.map((entry) => entry.candidate.subject).sort(compareUtf8);
                const current = replanned.map((entry) => entry.candidate.subject).sort(compareUtf8);
                if (wanted.length !== current.length || wanted.some((subject, index) => subject !== current[index])) {
                  throw new ProjectAuthorityStale();
                }
              },
            } : {}),
          };
        },
            signal,
          ) };
        } catch (error) {
          if (error instanceof NoContinuityGrants) return { noGrants: true as const };
          // The project moved between planning and commit; the retry loop
          // replans against fresh authority.
          if (error instanceof ProjectAuthorityStale) return { projectStale: true as const };
          throw error;
        }
      })();
      if ("noGrants" in outcome) return { kind: "ensured", granted: [] };
      if ("projectStale" in outcome) continue;
      const result = outcome.result;
      if (result.kind === "committed") return { kind: "ensured", granted: result.value };
      if (result.kind === "stale-generation") continue;
      return { kind: "unavailable" };
    }
    return { kind: "unavailable" };
  }

  return Object.freeze({ ensure });
}
