import { z } from "zod";
import { PluginKeySchema } from "../domain/identity.js";
import type { Sha256 } from "../domain/source.js";
import {
  ScopeReferenceSchema,
  createScopeContext,
  type ScopeContext,
} from "../domain/state/scope.js";
import { TrustSubjectRefSchema } from "../domain/state/references.js";
import { createTrustCandidate, evaluateTrust } from "../domain/trust-policy.js";
import { digestCompatibilityReport } from "./ports/runtime-projection.js";
import type { CompatibilityService } from "./compatibility-service.js";
import type { ExactTrustGrantService } from "./exact-trust-grant-service.js";
import type { InstalledPluginLoader } from "./ports/installed-plugin-loader.js";
import type { LifecycleStateStore } from "./ports/lifecycle-state-store.js";
import type { ProjectRootAuthorityPort } from "./ports/project-root-authority.js";

/**
 * Exact re-trust of the currently installed revision. Updates grant trust as
 * one lifecycle phase, but no other surface can re-grant trust for a revision
 * that is already installed — without this service a trust-required verdict
 * on an unchanged install is only fixable by remove + add.
 */

export const NativeTrustGrantResultSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("granted"), plugin: PluginKeySchema, scope: ScopeReferenceSchema, subject: TrustSubjectRefSchema }).strict().readonly(),
  z.object({ kind: z.literal("current-state"), plugin: PluginKeySchema, scope: ScopeReferenceSchema, reason: z.literal("already-authorized") }).strict().readonly(),
  z.object({ kind: z.literal("stale"), plugin: PluginKeySchema, scope: ScopeReferenceSchema, reason: z.enum(["revision", "generation", "project", "capability"]) }).strict().readonly(),
  z.object({ kind: z.literal("rejected"), plugin: PluginKeySchema, scope: ScopeReferenceSchema, code: z.enum(["PROJECT_UNTRUSTED", "INCOMPATIBLE"]) }).strict().readonly(),
  z.object({ kind: z.literal("unavailable"), plugin: PluginKeySchema, scope: ScopeReferenceSchema }).strict().readonly(),
  z.object({ kind: z.literal("recovery-required"), plugin: PluginKeySchema, scope: ScopeReferenceSchema }).strict().readonly(),
]);
export type NativeTrustGrantResult = z.infer<typeof NativeTrustGrantResultSchema>;

export const InstalledTrustGrantRequestSchema = z.object({
  // Facade-level reference; the full project context is resolved against the
  // host's one bound project inside the service.
  scope: ScopeReferenceSchema,
  plugin: PluginKeySchema,
  // The exact revision the caller inspected. Anything newer in state is a
  // concurrent change and must be re-inspected, never silently trusted.
  expectedRevision: z.string().min(1),
  // The compatibility report fingerprint the caller reviewed. The service
  // re-assesses live (matching the runtime's construction); a drifted report
  // means the granted evidence would differ from the reviewed evidence, so
  // the grant must fail stale rather than trust content nobody confirmed.
  expectedCompatibilityFingerprint: z.string().min(1),
}).strict().readonly();
export type InstalledTrustGrantRequest = z.infer<typeof InstalledTrustGrantRequestSchema>;

export interface InstalledTrustGrantService {
  grant(request: InstalledTrustGrantRequest, signal: AbortSignal): Promise<NativeTrustGrantResult>;
}

export type InstalledTrustGrantDependencies = Readonly<{
  state: LifecycleStateStore;
  installed: InstalledPluginLoader;
  compatibility: CompatibilityService;
  trust: ExactTrustGrantService;
  projectRoots: ProjectRootAuthorityPort;
  /** The one project this host is bound to; project grants outside it are stale. */
  projectScope: Extract<ScopeContext, { kind: "project" }>;
  sha256: Sha256;
}>;

export function createInstalledTrustGrantService(dependencies: InstalledTrustGrantDependencies): InstalledTrustGrantService {
  if (dependencies === null || typeof dependencies !== "object" || typeof dependencies.sha256 !== "function") {
    throw new TypeError("installed trust grant dependencies are required");
  }

  const service: InstalledTrustGrantService = {
    async grant(requestInput, signal) {
      signal.throwIfAborted();
      const request = InstalledTrustGrantRequestSchema.parse(requestInput);
      const base = { plugin: request.plugin, scope: request.scope } as const;
      let scope: ScopeContext;
      if (request.scope.kind === "user") {
        scope = createScopeContext({ kind: "user" }, dependencies.sha256);
      } else if (dependencies.projectScope.projectKey === request.scope.projectKey) {
        scope = dependencies.projectScope;
      } else {
        return NativeTrustGrantResultSchema.parse({ ...base, kind: "stale", reason: "project" });
      }

      let installedSnapshot;
      try {
        installedSnapshot = await dependencies.state.read(scope, signal);
      } catch (error) {
        if (signal.aborted) throw signal.reason ?? error;
        return NativeTrustGrantResultSchema.parse({ ...base, kind: "unavailable" });
      }
      if (!installedSnapshot.ok) return NativeTrustGrantResultSchema.parse({ ...base, kind: "unavailable" });
      const records = "installed" in installedSnapshot.snapshot ? installedSnapshot.snapshot.installed.plugins : installedSnapshot.snapshot.project.plugins;
      const record = records.find((candidate) => candidate.plugin === request.plugin);
      const revision = record?.revisions.find((candidate) => candidate.revision === record.selectedRevision);
      if (record === undefined || revision === undefined || record.selectedRevision !== request.expectedRevision) {
        return NativeTrustGrantResultSchema.parse({ ...base, kind: "stale", reason: "revision" });
      }

      let loaded;
      try {
        loaded = await dependencies.installed.load({ scope, revision }, signal);
      } catch (error) {
        if (signal.aborted) throw signal.reason ?? error;
        return NativeTrustGrantResultSchema.parse({ ...base, kind: "unavailable" });
      }
      if (loaded.plugin.identity.key !== request.plugin || loaded.binding !== record.selectedRevision) {
        return NativeTrustGrantResultSchema.parse({ ...base, kind: "stale", reason: "revision" });
      }

      let compatibility;
      try {
        // Re-assess live with the install-time policy so the granted evidence
        // is byte-identical to the candidate the runtime will evaluate at
        // hook/MCP execution time. The stored install-time report would
        // authorize evidence the runtime no longer computes.
        compatibility = await dependencies.compatibility.assess({
          plugin: loaded.plugin,
          ...(loaded.installationPolicy === undefined ? {} : { marketplacePolicy: loaded.installationPolicy }),
        }, signal);
      } catch (error) {
        if (signal.aborted) throw signal.reason ?? error;
        return NativeTrustGrantResultSchema.parse({ ...base, kind: "unavailable" });
      }
      if (!compatibility.activatable) {
        return NativeTrustGrantResultSchema.parse({ ...base, kind: "rejected", code: "INCOMPATIBLE" });
      }
      if (digestCompatibilityReport(compatibility, dependencies.sha256) !== request.expectedCompatibilityFingerprint) {
        return NativeTrustGrantResultSchema.parse({ ...base, kind: "stale", reason: "capability" });
      }

      const candidate = createTrustCandidate({
        scope: request.scope,
        marketplaceSource: loaded.marketplaceSource,
        plugin: loaded.plugin,
        compatibility,
        content: loaded.content,
        materializationBinding: loaded.binding,
      }, dependencies.sha256);
      // The granted evidence must be byte-identical to the installed record's
      // install-time evidence; a divergence means the content store drifted
      // and nothing here should be trusted.
      if (candidate.evidence.executableSurfaceDigest !== revision.evidence.trust.executableSurfaceDigest) {
        return NativeTrustGrantResultSchema.parse({ ...base, kind: "unavailable" });
      }

      // Trust authority is the user state document regardless of the
      // plugin's install scope.
      let trustSnapshot;
      try {
        trustSnapshot = await dependencies.state.read({ kind: "user" }, signal);
      } catch (error) {
        if (signal.aborted) throw signal.reason ?? error;
        return NativeTrustGrantResultSchema.parse({ ...base, kind: "unavailable" });
      }
      if (!trustSnapshot.ok || !("trust" in trustSnapshot.snapshot)) {
        return NativeTrustGrantResultSchema.parse({ ...base, kind: "unavailable" });
      }
      const decision = evaluateTrust(candidate, trustSnapshot.snapshot.trust.records, dependencies.sha256);
      if (decision.kind === "authorized") {
        return NativeTrustGrantResultSchema.parse({ ...base, kind: "current-state", reason: "already-authorized" });
      }

      let projectRoot;
      if (scope.kind === "project") {
        try {
          projectRoot = await dependencies.projectRoots.acquire(signal);
        } catch (error) {
          if (signal.aborted) throw signal.reason ?? error;
          return NativeTrustGrantResultSchema.parse({ ...base, kind: "stale", reason: "project" });
        }
      }
      const granted = await dependencies.trust.grant({
        candidate,
        scope,
        ...(projectRoot === undefined ? {} : { projectRoot }),
      }, signal);
      if (granted.kind === "recorded") {
        // The grant guards the trust generation, not the installed record; a
        // concurrent update/uninstall could have moved the selection while the
        // mutation committed. The recorded grant is evidence-keyed and inert
        // in that case, but the honest answer is stale, not granted.
        try {
          const settled = await dependencies.state.read(scope, signal);
          const settledRecord = settled.ok
            ? ("installed" in settled.snapshot ? settled.snapshot.installed.plugins : settled.snapshot.project.plugins).find((entry) => entry.plugin === request.plugin)
            : undefined;
          if (settledRecord?.selectedRevision !== request.expectedRevision) {
            return NativeTrustGrantResultSchema.parse({ ...base, kind: "stale", reason: "revision" });
          }
        } catch (error) {
          if (signal.aborted) throw signal.reason ?? error;
        }
        return NativeTrustGrantResultSchema.parse({ ...base, kind: "granted", subject: granted.subject });
      }
      if (granted.kind === "already-recorded") return NativeTrustGrantResultSchema.parse({ ...base, kind: "current-state", reason: "already-authorized" });
      if (granted.kind === "stale") return NativeTrustGrantResultSchema.parse({ ...base, kind: "stale", reason: "generation" });
      if (granted.kind === "project-stale") return NativeTrustGrantResultSchema.parse({ ...base, kind: "stale", reason: "project" });
      if (granted.kind === "project-untrusted") return NativeTrustGrantResultSchema.parse({ ...base, kind: "rejected", code: "PROJECT_UNTRUSTED" });
      return NativeTrustGrantResultSchema.parse({ ...base, kind: "recovery-required" });
    },
  };
  return Object.freeze(service);
}
