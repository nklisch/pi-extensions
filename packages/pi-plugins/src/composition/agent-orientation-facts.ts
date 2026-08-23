import { TextDecoder } from "node:util";
import {
  createAgentOrientationUnavailableError,
  type AgentOrientationInput,
  type OrientationDegraded,
  type OrientationPlugin,
  type OrientationSkill,
} from "../application/agent-orientation.js";
import type { ContentReadPort } from "../application/ports/content-read.js";
import type { ContentStorePort } from "../application/ports/content-store.js";
import type { InstalledPluginLoader } from "../application/ports/installed-plugin-loader.js";
import type { LifecycleStateStore } from "../application/ports/lifecycle-state-store.js";
import type { HostStartupResult } from "../application/host-observation-contract.js";
import type { RuntimeSelection, RuntimeSelectionCatalog } from "./runtime-selection-catalog.js";
import type { PiProjectContextAdapters } from "../pi/pi-project-context.js";
import type { Sha256 } from "../domain/source.js";
import type { ScopeContext, ScopeReference } from "../domain/state/scope.js";
import type { InstalledPluginRecord, InstalledRevisionRecord } from "../domain/state/installed-state.js";
import type { StateLoadResult } from "../application/state-contract.js";
import type { ContentDigest } from "../domain/content-manifest.js";
import type { PluginKey } from "../domain/identity.js";
import { ProvenanceSchema } from "../domain/provenance.js";
import { readBoundedFrontmatter } from "../formats/agent-skills/frontmatter-reader.js";
import type { PluginHostPathPlan } from "./plugin-host-paths.js";

const FRONTMATTER_READ_LIMIT = 1024 * 1024;
const decoder = new TextDecoder("utf-8", { fatal: true });

type AuthoritativeScope = Readonly<{
  context: ScopeContext;
  reference: ScopeReference;
  generation: number;
  records: readonly InstalledPluginRecord[];
}>;

type OrientationCollection = Readonly<{
  input: AgentOrientationInput;
  generationKey: string;
  scope: ScopeReference;
}>;

export type AgentOrientationFactsCollector = Readonly<{
  collect(signal: AbortSignal): Promise<OrientationCollection>;
  isCurrent(collection: OrientationCollection, signal: AbortSignal): Promise<boolean>;
}>;

function reference(scope: ScopeContext): ScopeReference {
  return scope.kind === "user"
    ? { kind: "user" as const }
    : { kind: "project" as const, projectKey: scope.projectKey };
}

function sameScope(left: ScopeReference, right: ScopeReference): boolean {
  return left.kind === right.kind && (left.kind === "user" || left.projectKey === (right as Extract<ScopeReference, { kind: "project" }>).projectKey);
}

function stableStateError(result: Extract<StateLoadResult, { ok: false }>, fallback: string): string {
  return result.corruptions[0]?.code ?? fallback;
}

function stateScope(
  result: StateLoadResult,
  expected: ScopeContext,
  fallback: string,
): AuthoritativeScope {
  if (!result.ok) {
    throw createAgentOrientationUnavailableError(stableStateError(result, fallback));
  }
  const snapshot = result.snapshot;
  if (snapshot.scope.kind !== expected.kind || snapshot.scope.kind === "project" && expected.kind === "project" && snapshot.scope.projectKey !== expected.projectKey) {
    throw createAgentOrientationUnavailableError(fallback);
  }
  if (snapshot.scope.kind === "user" && "installed" in snapshot) {
    return Object.freeze({
      context: snapshot.scope,
      reference: { kind: "user" as const },
      generation: snapshot.generation,
      records: snapshot.installed.plugins,
    });
  }
  if (snapshot.scope.kind === "project" && "project" in snapshot) {
    return Object.freeze({
      context: snapshot.scope,
      reference: { kind: "project" as const, projectKey: snapshot.scope.projectKey },
      generation: snapshot.generation,
      records: snapshot.project.plugins,
    });
  }
  throw createAgentOrientationUnavailableError(fallback);
}

function selectedRevision(record: InstalledPluginRecord): InstalledRevisionRecord | undefined {
  return record.revisions.find((revision) => revision.revision === record.selectedRevision);
}

function revisionVersion(record: InstalledPluginRecord, revision: InstalledRevisionRecord): string {
  const declared = revision.evidence.source.declaredVersion;
  if (declared !== undefined) return declared;
  return `rev-${revision.revision.slice("sha256:".length, "sha256:".length + 8)}`;
}

function runtimeSelection(
  selections: readonly RuntimeSelection[],
  scope: ScopeReference,
  plugin: PluginKey,
): RuntimeSelection | undefined {
  return selections.find((selection) => sameScope(selection.scope, scope) && selection.plugin === plugin);
}

function blockedFor(
  blocked: readonly OrientationDegraded[],
  scope: ScopeReference,
  plugin: string,
): OrientationDegraded | undefined {
  return blocked.find((entry) => entry.plugin === plugin && (entry.scope === undefined || sameScope(entry.scope, scope)));
}

function componentCount(record: InstalledRevisionRecord, kind: "skill" | "hook" | "mcp-server"): number {
  return record.evidence.components.filter((component) => component.kind === kind).length;
}

function decodeDescription(markdown: string, path: string): string | undefined {
  const provenance = ProvenanceSchema.parse({
    location: { host: "claude", documentKind: "skill", path, pointer: "" },
  });
  const result = readBoundedFrontmatter(markdown, provenance);
  if (!result.ok) return undefined;
  const attributes = result.value.attributes;
  if (attributes === null || typeof attributes !== "object" || Array.isArray(attributes)) return undefined;
  const description = (attributes as Record<string, unknown>).description;
  return typeof description === "string" && description.trim().length > 0 ? description : undefined;
}

async function readSkillDescriptions(
  loaded: Awaited<ReturnType<InstalledPluginLoader["load"]>>,
  resolved: Awaited<ReturnType<ContentStorePort["resolvePlugin"]>>,
  reader: ContentReadPort,
  signal: AbortSignal,
): Promise<readonly OrientationSkill[]> {
  const skills: OrientationSkill[] = [];
  for (const skill of loaded.plugin.components.skills) {
    const root = skill.root.value;
    const path = root === "." ? "SKILL.md" : `${root}/SKILL.md`;
    const entry = resolved.manifest.entries.find((candidate) => candidate.kind === "file" && candidate.path === path);
    let description: string | undefined;
    if (entry?.kind === "file") {
      try {
        const bytes = await reader.readFile({ root: resolved.root, entry }, FRONTMATTER_READ_LIMIT, signal);
        description = decodeDescription(decoder.decode(bytes), path);
      } catch {
        // A single unreadable skill must not erase the authoritative plugin
        // inventory or make orientation a startup dependency.
      }
    }
    skills.push(Object.freeze({ name: skill.name.value, ...(description === undefined ? {} : { description }) }));
  }
  return Object.freeze(skills.sort((left, right) => left.name.localeCompare(right.name)));
}

async function detailFor(
  record: InstalledPluginRecord,
  scope: AuthoritativeScope,
  installed: InstalledPluginLoader,
  content: Pick<ContentStorePort, "resolvePlugin">,
  reader: ContentReadPort,
  signal: AbortSignal,
): Promise<Readonly<{ skills: readonly OrientationSkill[]; hooks: readonly string[]; mcpServers: readonly string[] }>> {
  const selected = selectedRevision(record);
  const candidates: InstalledRevisionRecord[] = selected === undefined ? [] : [selected];
  for (const revision of candidates) {
    try {
      const loaded = await installed.load({ scope: scope.context, revision }, signal);
      const resolved = await content.resolvePlugin(revision, signal, scope.reference);
      const skills = await readSkillDescriptions(loaded, resolved, reader, signal);
      return Object.freeze({
        skills,
        hooks: Object.freeze(loaded.plugin.components.hooks.map((hook) => hook.event.value).sort()),
        mcpServers: Object.freeze(loaded.plugin.components.mcpServers.map((server) => server.nativeKey.value).sort()),
      });
    } catch {
      // Runtime selections annotate active/running status only; they are not
      // an alternate source for the authoritative inventory or detail.
    }
  }
  return Object.freeze({ skills: Object.freeze([]), hooks: Object.freeze([]), mcpServers: Object.freeze([]) });
}

function degradedEntries(startup: HostStartupResult, latest: readonly { plugin: string; scope?: ScopeReference; code: string; explanation: string }[] | undefined): readonly OrientationDegraded[] {
  const entries = [
    ...startup.blocked,
    ...(latest ?? []),
  ].map((entry) => Object.freeze({
    plugin: entry.plugin,
    ...(entry.scope === undefined ? {} : { scope: entry.scope }),
    code: entry.code,
    explanation: entry.explanation,
  }));
  const unique = new Map<string, OrientationDegraded>();
  for (const entry of entries) {
    const scopeKey = entry.scope === undefined
      ? "host"
      : entry.scope.kind === "user" ? "user" : `project:${entry.scope.projectKey}`;
    const key = `${entry.plugin}:${scopeKey}:${entry.code}`;
    unique.set(key, entry);
  }
  return Object.freeze([...unique.values()]);
}

async function readScopes(
  input: Readonly<{
    state: LifecycleStateStore;
    project: PiProjectContextAdapters;
    signal: AbortSignal;
  }>,
): Promise<readonly [AuthoritativeScope, AuthoritativeScope?]> {
  const user = stateScope(await input.state.read({ kind: "user" }, input.signal), { kind: "user" }, "USER_STATE_UNAVAILABLE");
  const currentProject = await input.project.revalidate(input.signal);
  if (currentProject.trust.kind !== "trusted") return [user];
  const project = stateScope(await input.state.read(input.project.scope, input.signal), input.project.scope, "PROJECT_STATE_UNAVAILABLE");
  return [user, project];
}

function scopeSelectionForBrief(scopes: readonly [AuthoritativeScope, AuthoritativeScope?]): AuthoritativeScope {
  return scopes[1] ?? scopes[0]!;
}

/** Collect authoritative inventory and runtime-only status annotations. */
export function createAgentOrientationFactsCollector(input: Readonly<{
  paths: PluginHostPathPlan;
  packageVersion: string;
  state: LifecycleStateStore;
  project: PiProjectContextAdapters;
  installed: InstalledPluginLoader;
  content: Pick<ContentStorePort, "resolvePlugin">;
  contentReader: ContentReadPort;
  selections: RuntimeSelectionCatalog;
  startup: HostStartupResult;
  latestDesired: () => Readonly<{ degraded: readonly { plugin: string; scope?: ScopeReference; code: string; explanation: string }[] }> | undefined;
  sha256: Sha256;
}>): AgentOrientationFactsCollector {
  let previousGenerationKey: string | undefined;
  let previousCollection: OrientationCollection | undefined;
  async function currentGenerationKey(signal: AbortSignal): Promise<string> {
    const scopes = await readScopes({ state: input.state, project: input.project, signal });
    return scopes.filter((scope): scope is AuthoritativeScope => scope !== undefined)
      .map((scope) => `${scope.reference.kind}:${scope.reference.kind === "user" ? "" : scope.reference.projectKey}:${scope.generation}`)
      .join("|");
  }
  return Object.freeze({
    async collect(signal: AbortSignal): Promise<OrientationCollection> {
      signal.throwIfAborted();
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const scopes = await readScopes({ state: input.state, project: input.project, signal });
        const authoritativeScopes = scopes.filter((scope): scope is AuthoritativeScope => scope !== undefined);
        const selectedScope = scopeSelectionForBrief(scopes);
        const generationKey = authoritativeScopes.map((scope) => `${scope.reference.kind}:${scope.reference.kind === "user" ? "" : scope.reference.projectKey}:${scope.generation}`).join("|");
        if (previousGenerationKey === generationKey && previousCollection !== undefined) return previousCollection;
        const runtime = input.selections.snapshot();
        const blocked = degradedEntries(input.startup, input.latestDesired()?.degraded);
        const plugins: OrientationPlugin[] = [];
        for (const scope of authoritativeScopes) {
          for (const record of scope.records) {
            const selected = selectedRevision(record);
            if (selected === undefined) continue;
            const selection = runtimeSelection(runtime.selections, scope.reference, record.plugin);
            const degraded = blockedFor(blocked, scope.reference, record.plugin);
            const details = await detailFor(record, scope, input.installed, input.content, input.contentReader, signal);
            plugins.push(Object.freeze({
              scope: scope.reference,
              plugin: record.plugin,
              marketplace: selected.evidence.plugin.marketplaceName,
              version: revisionVersion(record, selected),
              revision: selected.revision,
              activation: record.activation,
              active: record.activation === "enabled" && selection !== undefined,
              ...(selection === undefined ? {} : { runningRevision: selection.revision.revision }),
              ...(degraded === undefined ? {} : { degraded: { code: degraded.code, explanation: degraded.explanation } }),
              skills: details.skills,
              hooks: details.hooks.length === 0 && componentCount(selected, "hook") > 0 ? Object.freeze([]) : details.hooks,
              mcpServers: details.mcpServers.length === 0 && componentCount(selected, "mcp-server") > 0 ? Object.freeze([]) : details.mcpServers,
              skillCount: componentCount(selected, "skill"),
              hookCount: componentCount(selected, "hook"),
              mcpServerCount: componentCount(selected, "mcp-server"),
              foreignCount: selected.evidence.components.filter((component) => component.kind === "foreign").length,
            }));
          }
        }
        const orientationInput: AgentOrientationInput = {
          packageVersion: input.packageVersion,
          briefPath: input.paths.orientationBrief(selectedScope.reference),
          scopeLabel: authoritativeScopes.length === 1 ? "user scope" : "user + current project scope",
          plugins,
          degraded: blocked,
          sha256: input.sha256,
        };
        const verify = await readScopes({ state: input.state, project: input.project, signal });
        const verifyKey = verify.filter((scope): scope is AuthoritativeScope => scope !== undefined).map((scope) => `${scope.reference.kind}:${scope.reference.kind === "user" ? "" : scope.reference.projectKey}:${scope.generation}`).join("|");
        if (verifyKey !== generationKey) continue;
        const collection = Object.freeze({ input: orientationInput, generationKey, scope: selectedScope.reference });
        previousGenerationKey = generationKey;
        previousCollection = collection;
        return collection;
      }
      throw createAgentOrientationUnavailableError("STATE_CHANGED_DURING_ORIENTATION");
    },
    async isCurrent(collection: OrientationCollection, signal: AbortSignal): Promise<boolean> {
      return await currentGenerationKey(signal) === collection.generationKey;
    },
  });
}
