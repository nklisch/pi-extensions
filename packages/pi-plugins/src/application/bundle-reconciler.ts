import { z } from "zod";
import {
  ComponentSchema,
  ForeignComponentSchema,
  HookComponentSchema,
  McpServerComponentSchema,
  PluginComponentsSchema,
  RetainedMetadataSchema,
  SkillComponentSchema,
  type Component,
  type ForeignComponent,
  type HookComponent,
  type McpServerComponent,
  type RetainedMetadata,
  type SkillComponent,
} from "../domain/components.js";
import { NormalizedPluginSchema } from "../domain/plugin.js";
import {
  ConfigurationOptionSchema,
  PluginConfigurationSchema,
  type ConfigurationOption,
  type PluginConfiguration,
} from "../domain/configuration.js";
import { deriveComponentId, verifyComponentId } from "../domain/component-identity.js";
import {
  ForeignComponentDeclarationSchema,
  PluginManifestClaimsSchema,
  type ForeignComponentDeclaration,
  type PluginManifestClaims,
} from "../domain/bundle-ingestion.js";
import {
  DiagnosticSchema,
  ErrorCodeRegistry,
  type Diagnostic,
  type ReadResult,
} from "../domain/errors.js";
import { NormalizedMarketplaceEntrySchema,
  type NormalizedMarketplaceEntry,
} from "../domain/marketplace.js";
import {
  DEFAULT_HOST_PRECEDENCE,
  hostRank,
  type HostPrecedence,
} from "../domain/host-precedence.js";
import type { Provenance } from "../domain/provenance.js";
import { PluginKeySchema } from "../domain/identity.js";
import type { JsonValue } from "../domain/schema.js";
import {
  ResolvedPluginSourceSchema,
  type ResolvedPluginSource,
  type Sha256,
} from "../domain/source.js";

const OPERATION = "reconcilePluginBundle";
type HostOrder = Readonly<Record<"claude" | "codex", number>>;
const DEFAULT_HOST_ORDER: HostOrder = { claude: 0, codex: 1 };

function hostOrderFor(precedence: HostPrecedence): HostOrder {
  return { claude: hostRank(precedence, "claude"), codex: hostRank(precedence, "codex") };
}
const COMPONENT_ORDER: Readonly<Record<Component["kind"], number>> = {
  skill: 0,
  hook: 1,
  "mcp-server": 2,
  foreign: 3,
};

type Claim<T> = Readonly<{
  value: T;
  provenance: readonly Provenance[];
}>;

type ReconcileInput = Readonly<{
  entry: NormalizedMarketplaceEntry;
  source: ResolvedPluginSource;
  manifestClaims: readonly PluginManifestClaims[];
  /** Foreign declarations discovered outside host manifests (for example catalogs). */
  foreignDeclarations?: readonly ForeignComponentDeclaration[];
  configuration: readonly PluginConfiguration[];
  components: readonly Component[];
  metadata: readonly RetainedMetadata[];
  sha256: Sha256;
  /** Canonical host order for precedence resolution; defaults to Claude-first. */
  hostPrecedence?: HostPrecedence;
}>;

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
}

function locationKey(provenance: Provenance, order: HostOrder): string {
  const location = provenance.location;
  return stableJson([
    order[location.host],
    location.documentKind,
    location.path,
    location.pointer ?? null,
    location.line ?? null,
    location.column ?? null,
  ]);
}

function compareProvenance(left: Provenance, right: Provenance, order: HostOrder): number {
  const a = locationKey(left, order);
  const b = locationKey(right, order);
  return a < b ? -1 : a > b ? 1 : 0;
}

function sameProvenance(left: Provenance, right: Provenance, order: HostOrder): boolean {
  return locationKey(left, order) === locationKey(right, order) &&
    stableJson(left.declaration) === stableJson(right.declaration);
}

function mergeProvenance(
  left: readonly Provenance[],
  right: readonly Provenance[],
  order: HostOrder,
): readonly [Provenance, ...Provenance[]] {
  const sorted = [...left, ...right].sort((a, b) => compareProvenance(a, b, order));
  const result: Provenance[] = [];
  for (const candidate of sorted) {
    if (!result.some((existing) => sameProvenance(existing, candidate, order))) result.push(candidate);
  }
  if (result.length === 0) throw new Error("claim provenance cannot be empty");
  return result as [Provenance, ...Provenance[]];
}

function firstProvenance(value: Readonly<{ provenance: readonly Provenance[] }>, order: HostOrder): Provenance {
  const first = [...value.provenance].sort((a, b) => compareProvenance(a, b, order))[0];
  if (first === undefined) throw new Error("claim provenance cannot be empty");
  return first;
}

function snapshot(value: unknown): JsonValue {
  if (value !== null && typeof value === "object" && "value" in value && "provenance" in value) {
    const claim = value as { readonly value: unknown; readonly provenance: readonly Provenance[] };
    return {
      value: snapshot(claim.value),
      provenance: claim.provenance as unknown as JsonValue,
    };
  }
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (Array.isArray(value)) return value.map(snapshot);
  if (typeof value === "object") {
    const result: Record<string, JsonValue> = {};
    for (const key of Object.keys(value)) result[key] = snapshot((value as Record<string, unknown>)[key]);
    return result;
  }
  return String(value);
}

function diagnostic(
  code: "SCHEMA_INVALID" | "CLAIM_CONFLICT",
  message: string,
  plugin: string,
  details?: JsonValue,
  provenance?: Provenance,
): Diagnostic {
  return DiagnosticSchema.parse({
    code,
    severity: "error",
    operation: OPERATION,
    message,
    plugin: PluginKeySchema.parse(plugin),
    ...(provenance === undefined ? {} : { location: provenance.location }),
    ...(details === undefined ? {} : { details }),
  });
}

function failure<T>(
  code: "SCHEMA_INVALID" | "CLAIM_CONFLICT",
  message: string,
  plugin: string,
  details?: JsonValue,
  provenance?: Provenance,
): ReadResult<T> {
  return { ok: false, diagnostics: [diagnostic(code, message, plugin, details, provenance)] };
}

function mergeClaim<T>(
  field: string,
  left: Claim<T>,
  right: Claim<T>,
  plugin: string,
  order: HostOrder,
  equals: (left: T, right: T) => boolean = (a, b) => stableJson(a) === stableJson(b),
): ReadResult<Claim<T>> {
  const leftSource = firstProvenance(left, order);
  const rightSource = firstProvenance(right, order);
  const conflictingRawSource = left.provenance.some((a) => right.provenance.some((b) =>
    locationKey(a, order) === locationKey(b, order) && stableJson(a.declaration) !== stableJson(b.declaration)));
  if (conflictingRawSource || !equals(left.value, right.value)) {
    return failure(
      ErrorCodeRegistry.claimConflict,
      `Conflicting plugin claim for ${field}`,
      plugin,
      {
        field,
        left: snapshot(left),
        right: snapshot(right),
        locations: [leftSource.location, rightSource.location] as unknown as JsonValue,
      },
      leftSource,
    );
  }
  return {
    ok: true,
    value: {
      value: left.value,
      provenance: mergeProvenance(left.provenance, right.provenance, order),
    },
    diagnostics: [],
  };
}

function mergeOptionalClaim<T>(
  field: string,
  left: Claim<T> | undefined,
  right: Claim<T> | undefined,
  plugin: string,
  order: HostOrder,
  equals?: (left: T, right: T) => boolean,
): ReadResult<Claim<T> | undefined> {
  if (left === undefined) return { ok: true, value: right, diagnostics: [] };
  if (right === undefined) return { ok: true, value: left, diagnostics: [] };
  return mergeClaim(field, left, right, plugin, order, equals);
}

function reduceClaim<T>(
  field: string,
  values: readonly Claim<T>[],
  plugin: string,
  order: HostOrder,
): ReadResult<Claim<T> | undefined> {
  let result: Claim<T> | undefined;
  for (const value of values) {
    if (result === undefined) {
      result = value;
      continue;
    }
    const merged = mergeClaim(field, result, value, plugin, order);
    if (!merged.ok) return merged;
    result = merged.value;
  }
  return { ok: true, value: result, diagnostics: [] };
}

/**
 * Presentational fields never conflict: the caller's claim ordering is the
 * precedence (marketplace entry first, then Claude, then Codex) and the
 * highest-precedence declaration wins. Real hosts behave the same way —
 * Claude lets a marketplace entry override plugin.json metadata, and Codex
 * never merges catalog metadata at all — so divergent descriptions, versions,
 * or display metadata between equivalent documents are ordinary drift, not
 * an integrity failure. Superseded declarations survive in merged provenance.
 */
function reducePresentational<T>(
  values: readonly Claim<T>[],
  order: HostOrder,
): ReadResult<Claim<T> | undefined> {
  const first = values[0];
  if (first === undefined) return { ok: true, value: undefined, diagnostics: [] };
  let provenance = first.provenance;
  for (const rest of values.slice(1)) {
    provenance = mergeProvenance(provenance, rest.provenance, order);
  }
  return { ok: true, value: { value: first.value, provenance }, diagnostics: [] };
}

function mergePresentationalClaim<T>(
  left: Claim<T>,
  right: Claim<T>,
  order: HostOrder,
): Claim<T> {
  return {
    value: left.value,
    provenance: mergeProvenance(left.provenance, right.provenance, order),
  };
}

function claimHostRank(claim: Claim<unknown>, order: HostOrder): number {
  const host = [...claim.provenance].sort((a, b) => compareProvenance(a, b, order))[0]?.location.host;
  return host === "claude" || host === "codex" ? order[host] : order.codex + 1;
}

/**
 * Total, deterministic precedence between two competing declarations of one
 * semantic thing: canonical host order first (Claude before Codex), then a
 * content tiebreak so the outcome never depends on input ordering.
 */
function precedenceWinner<T>(left: Claim<T>, right: Claim<T>, order: HostOrder): readonly [winner: Claim<T>, loser: Claim<T>] {
  const rank = claimHostRank(left, order) - claimHostRank(right, order);
  if (rank !== 0) return rank < 0 ? [left, right] : [right, left];
  return stableJson(left.value) <= stableJson(right.value) ? [left, right] : [right, left];
}

function claimHost(claim: Claim<unknown>, order: HostOrder): string {
  return [...claim.provenance].sort((a, b) => compareProvenance(a, b, order))[0]?.location.host ?? "unknown";
}

/**
 * Best-effort conflict resolution is the product policy: when two hosts
 * declare one component differently, the precedence winner runs and the loser
 * is retained here as ordinary retained metadata, visible in inspection
 * details. Nothing prompts and nothing blocks.
 */
export function buildPrecedenceResolutionMetadata(
  field: string,
  winner: Claim<unknown>,
  loser: Claim<unknown>,
  order: HostOrder = DEFAULT_HOST_ORDER,
): RetainedMetadata {
  return RetainedMetadataSchema.parse({
    key: `pi.reconciliation.precedence-resolution:${field}`,
    claimed: {
      value: {
        field,
        kept: claimHost(winner, order),
        superseded: claimHost(loser, order),
        keptDeclaration: winner.value,
        supersededDeclaration: loser.value,
      },
      provenance: mergeProvenance(winner.provenance, loser.provenance, order),
    },
  });
}

function metadataKey(value: RetainedMetadata, order: HostOrder): string {
  return `${value.key}\u0000${locationKey(firstProvenance(value.claimed, order), order)}`;
}

function mergeMetadata(
  values: readonly RetainedMetadata[],
  plugin: string,
  order: HostOrder,
): ReadResult<readonly RetainedMetadata[]> {
  const byKey = new Map<string, RetainedMetadata>();
  for (const candidate of values) {
    const value = RetainedMetadataSchema.parse(candidate);
    const existing = byKey.get(value.key);
    if (existing === undefined) {
      byKey.set(value.key, value);
      continue;
    }
    // Retained metadata is presentational: first-seen (highest-precedence)
    // declaration wins; superseded declarations survive in provenance.
    byKey.set(value.key, {
      key: value.key,
      claimed: mergePresentationalClaim(existing.claimed, value.claimed, order),
    });
  }
  return {
    ok: true,
    value: [...byKey.values()].sort((left, right) => {
      const a = metadataKey(left, order);
      const b = metadataKey(right, order);
      return a < b ? -1 : a > b ? 1 : 0;
    }),
    diagnostics: [],
  };
}

function mergeConfigurationOption(
  left: ConfigurationOption,
  right: ConfigurationOption,
  plugin: string,
  order: HostOrder,
): ReadResult<ConfigurationOption> {
  // Configuration label and description are presentation for the prompt UI;
  // they degrade to canonical precedence like other presentational fields.
  const label: ReadResult<Claim<string>> = { ok: true, value: mergePresentationalClaim(left.label, right.label, order), diagnostics: [] };
  const description: ReadResult<Claim<string> | undefined> = {
    ok: true,
    value: left.description === undefined
      ? right.description
      : right.description === undefined
        ? left.description
        : mergePresentationalClaim(left.description, right.description, order),
    diagnostics: [],
  };
  const value = mergeClaim(
    `configuration.${left.key}.value`,
    { value: left.value, provenance: left.provenance },
    { value: right.value, provenance: right.provenance },
    plugin,
    order,
  );
  if (!value.ok) return value;
  const required = mergeClaim(
    `configuration.${left.key}.required`,
    { value: left.required, provenance: left.provenance },
    { value: right.required, provenance: right.provenance },
    plugin,
    order,
  );
  if (!required.ok) return required;
  const sensitive = mergeClaim(
    `configuration.${left.key}.sensitive`,
    { value: left.sensitive, provenance: left.provenance },
    { value: right.sensitive, provenance: right.provenance },
    plugin,
    order,
  );
  if (!sensitive.ok) return sensitive;
  return {
    ok: true,
    value: ConfigurationOptionSchema.parse({
      key: left.key,
      label: label.value,
      ...(description.value === undefined ? {} : { description: description.value }),
      value: value.value,
      required: required.value,
      sensitive: sensitive.value,
      provenance: mergeProvenance(left.provenance, right.provenance, order),
    }),
    diagnostics: [],
  };
}

function mergeConfiguration(
  values: readonly ConfigurationOption[],
  plugin: string,
  order: HostOrder,
): ReadResult<readonly ConfigurationOption[]> {
  const byKey = new Map<string, ConfigurationOption>();
  for (const candidate of values) {
    const option = ConfigurationOptionSchema.parse(candidate);
    const existing = byKey.get(option.key);
    if (existing === undefined) {
      byKey.set(option.key, option);
      continue;
    }
    const merged = mergeConfigurationOption(existing, option, plugin, order);
    if (!merged.ok) return merged;
    byKey.set(option.key, merged.value);
  }
  const configuration = PluginConfigurationSchema.parse({
    options: [...byKey.values()].sort((a, b) => a.key.localeCompare(b.key)),
  });
  return { ok: true, value: configuration.options, diagnostics: [] };
}

function mergeSkill(left: SkillComponent, right: SkillComponent, plugin: string, order: HostOrder): ReadResult<SkillComponent> {
  if (left.name.value !== right.name.value || left.root.value !== right.root.value) {
    return failure(ErrorCodeRegistry.claimConflict, "Conflicting skill component claims", plugin, {
      left: snapshot(left),
      right: snapshot(right),
    }, firstProvenance(right.root, order));
  }
  const name = mergeClaim("skill.name", left.name, right.name, plugin, order);
  if (!name.ok) return name;
  const root = mergeClaim("skill.root", left.root, right.root, plugin, order);
  if (!root.ok) return root;
  const metadata = mergeMetadata([...left.metadata, ...right.metadata], plugin, order);
  if (!metadata.ok) return metadata;
  return {
    ok: true,
    value: SkillComponentSchema.parse({ ...left, name: name.value, root: root.value, metadata: metadata.value }),
    diagnostics: [],
  };
}

function mergeHook(left: HookComponent, right: HookComponent, plugin: string, order: HostOrder): ReadResult<HookComponent> {
  if (left.event.value !== right.event.value ||
      (left.matcher?.value !== right.matcher?.value) ||
      stableJson(left.handler.value) !== stableJson(right.handler.value)) {
    return failure(ErrorCodeRegistry.claimConflict, "Conflicting hook component claims", plugin, {
      left: snapshot(left),
      right: snapshot(right),
    }, firstProvenance(right.handler, order));
  }
  const event = mergeClaim("hook.event", left.event, right.event, plugin, order);
  if (!event.ok) return event;
  const matcher = mergeOptionalClaim("hook.matcher", left.matcher, right.matcher, plugin, order);
  if (!matcher.ok) return matcher;
  const handler = mergeClaim("hook.handler", left.handler, right.handler, plugin, order);
  if (!handler.ok) return handler;
  const metadata = mergeMetadata([...left.metadata, ...right.metadata], plugin, order);
  if (!metadata.ok) return metadata;
  return {
    ok: true,
    value: HookComponentSchema.parse({
      ...left,
      event: event.value,
      ...(matcher.value === undefined ? {} : { matcher: matcher.value }),
      handler: handler.value,
      metadata: metadata.value,
    }),
    diagnostics: [],
  };
}

function mergeMcp(left: McpServerComponent, right: McpServerComponent, plugin: string, order: HostOrder): ReadResult<McpServerComponent> {
  // The component id is derived from nativeKey alone, so equal ids with
  // different nativeKeys would be a hash collision — structural corruption.
  if (left.nativeKey.value !== right.nativeKey.value) {
    return failure(ErrorCodeRegistry.claimConflict, "Conflicting MCP server component claims", plugin, {
      left: snapshot(left),
      right: snapshot(right),
    }, firstProvenance(right.declaration, order));
  }
  // Hosts legitimately ship different launch recipes for one server (Claude
  // `${CLAUDE_PLUGIN_ROOT}` style vs Codex direct-exec style). Resolve by
  // precedence: the winner runs, the loser is retained as resolution
  // metadata. Neither recipe is silently dropped.
  const [winner, loser] = precedenceWinner(left.declaration, right.declaration, order);
  const declaration: Claim<unknown> = {
    value: winner.value,
    provenance: mergeProvenance(left.declaration.provenance, right.declaration.provenance, order),
  };
  const notes = stableJson(left.declaration.value) === stableJson(right.declaration.value)
    ? []
    : [buildPrecedenceResolutionMetadata("mcp.declaration", winner, loser, order)];
  const metadata = mergeMetadata([...left.metadata, ...right.metadata, ...notes], plugin, order);
  if (!metadata.ok) return metadata;
  return {
    ok: true,
    value: McpServerComponentSchema.parse({
      ...left,
      nativeKey: mergePresentationalClaim(left.nativeKey, right.nativeKey, order),
      declaration,
      metadata: metadata.value,
    }),
    diagnostics: [],
  };
}

function mergeForeign(left: ForeignComponent, right: ForeignComponent, plugin: string, order: HostOrder): ReadResult<ForeignComponent> {
  // nativeHost/nativeKind/declarationSubkey are all part of the component
  // id; disagreement here is a hash collision, i.e. structural corruption.
  if (left.nativeHost !== right.nativeHost || left.nativeKind.value !== right.nativeKind.value ||
      left.declarationSubkey !== right.declarationSubkey) {
    return failure(ErrorCodeRegistry.claimConflict, "Conflicting foreign component claims", plugin, {
      left: snapshot(left),
      right: snapshot(right),
    }, firstProvenance(right.declaration, order));
  }
  // Foreign components are never executed, so divergent declarations are
  // pure drift: resolve by precedence; both declarations remain auditable in
  // merged provenance, which carries each side's raw declaration.
  const [winner] = precedenceWinner(left.declaration, right.declaration, order);
  const declaration: Claim<unknown> = {
    value: winner.value,
    provenance: mergeProvenance(left.declaration.provenance, right.declaration.provenance, order),
  };
  return {
    ok: true,
    value: ForeignComponentSchema.parse({
      ...left,
      nativeKind: mergePresentationalClaim(left.nativeKind, right.nativeKind, order),
      declaration,
    }),
    diagnostics: [],
  };
}

function componentIdentity(component: Component): Parameters<typeof deriveComponentId>[1] {
  switch (component.kind) {
    case "skill": return { kind: "skill", root: component.root.value };
    case "hook": return {
      kind: "hook",
      event: component.event.value,
      ...(component.matcher === undefined ? {} : { matcher: component.matcher.value }),
      handler: component.handler.value,
    };
    case "mcp-server": return { kind: "mcp-server", nativeKey: component.nativeKey.value };
    case "foreign":
      return {
        kind: "foreign",
        nativeHost: component.nativeHost,
        nativeKind: component.nativeKind.value,
        declarationSubkey: component.declarationSubkey,
      };
  }
}

function mergeComponent(left: Component, right: Component, plugin: string, order: HostOrder): ReadResult<Component> {
  if (left.kind !== right.kind) {
    return failure(ErrorCodeRegistry.claimConflict, "Different component kinds share one component id", plugin, {
      left: snapshot(left),
      right: snapshot(right),
    }, firstProvenance(left.kind === "skill" ? left.root : left.kind === "hook" ? left.handler : left.kind === "mcp-server" ? left.declaration : left.declaration, order));
  }
  switch (left.kind) {
    case "skill": return mergeSkill(left, right as SkillComponent, plugin, order);
    case "hook": return mergeHook(left, right as HookComponent, plugin, order);
    case "mcp-server": return mergeMcp(left, right as McpServerComponent, plugin, order);
    case "foreign": return mergeForeign(left, right as ForeignComponent, plugin, order);
  }
}

function foreignDeclarationComponent(
  declaration: ForeignComponentDeclaration,
  plugin: string,
  sha256: Sha256,
): ForeignComponent {
  const valid = ForeignComponentDeclarationSchema.parse(declaration);
  const identity = {
    kind: "foreign" as const,
    nativeHost: valid.nativeHost,
    nativeKind: valid.nativeKind.value,
    declarationSubkey: valid.declarationSubkey,
  };
  return ForeignComponentSchema.parse({
    kind: "foreign",
    id: deriveComponentId(PluginKeySchema.parse(plugin), identity, sha256),
    nativeHost: valid.nativeHost,
    nativeKind: valid.nativeKind,
    declarationSubkey: valid.declarationSubkey,
    declaration: valid.declaration,
  });
}

function realizeComponents(
  values: readonly Component[],
  plugin: string,
  sha256: Sha256,
  order: HostOrder,
): ReadResult<Readonly<{
  skills: readonly SkillComponent[];
  hooks: readonly HookComponent[];
  mcpServers: readonly McpServerComponent[];
  foreign: readonly ForeignComponent[];
}>> {
  const byId = new Map<string, Component>();
  try {
    for (const candidate of values) {
      const component = ComponentSchema.parse(candidate);
      verifyComponentId(component.id, PluginKeySchema.parse(plugin), componentIdentity(component), sha256);
      const existing = byId.get(component.id);
      if (existing === undefined) {
        byId.set(component.id, component);
      } else {
        const merged = mergeComponent(existing, component, plugin, order);
        if (!merged.ok) return merged;
        byId.set(component.id, merged.value);
      }
    }
    const sorted = [...byId.values()].sort((left, right) => {
      const kind = COMPONENT_ORDER[left.kind] - COMPONENT_ORDER[right.kind];
      return kind !== 0 ? kind : left.id.localeCompare(right.id);
    });
    const result = PluginComponentsSchema.parse({
      skills: sorted.filter((value): value is SkillComponent => value.kind === "skill"),
      hooks: sorted.filter((value): value is HookComponent => value.kind === "hook"),
      mcpServers: sorted.filter((value): value is McpServerComponent => value.kind === "mcp-server"),
      foreign: sorted.filter((value): value is ForeignComponent => value.kind === "foreign"),
    });
    return { ok: true, value: result, diagnostics: [] };
  } catch (error) {
    if (error instanceof z.ZodError) {
      return failure(ErrorCodeRegistry.schemaInvalid, "normalized component inventory is invalid", plugin, {
        issues: error.issues.map((issue) => ({ code: issue.code, path: issue.path.map(String), message: issue.message })),
      });
    }
    return failure(ErrorCodeRegistry.schemaInvalid, error instanceof Error ? error.message : "normalized component inventory is invalid", plugin);
  }
}

function manifestClaimValues<T>(claims: readonly PluginManifestClaims[], selector: (claim: PluginManifestClaims) => Claim<T> | undefined): Claim<T>[] {
  return claims.flatMap((claim) => {
    const value = selector(claim);
    return value === undefined ? [] : [value];
  });
}

/**
 * Divergent component locators across hosts are intentionally not a conflict:
 * each host's manifest may point at its own file (Claude `.mcp.json` vs Codex
 * `.mcp.codex.json`), and upstream inspection reads every locator target and
 * merges the discovered components. The reconciler consumes merged claims,
 * never raw locator paths, so there is nothing here to arbitrate.
 */

/**
 * Reconcile every observed declaration into one complete normalized plugin.
 * This module intentionally owns no format or runtime policy; it only merges
 * typed claims and verifies the versioned component identities at the boundary.
 */
export function reconcilePluginBundle(input: ReconcileInput): ReadResult<z.infer<typeof NormalizedPluginSchema>> {
  let plugin = "unknown@unknown";
  try {
    const precedence = input.hostPrecedence === undefined ? DEFAULT_HOST_PRECEDENCE : input.hostPrecedence;
    const order = hostOrderFor(precedence);
    const entry = NormalizedMarketplaceEntrySchema.parse(input.entry);
    plugin = PluginKeySchema.parse(entry.identity.value.key);
    const source = ResolvedPluginSourceSchema.parse(input.source);
    const claims = input.manifestClaims
      .map((claim) => PluginManifestClaimsSchema.parse(claim))
      .sort((left, right) => {
        const host = order[left.nativeHost] - order[right.nativeHost];
        if (host !== 0) return host;
        return left.document.location.path.localeCompare(right.document.location.path);
      });
    const externalConfiguration = input.configuration.flatMap((configuration) =>
      PluginConfigurationSchema.parse(configuration).options.map((option) => ConfigurationOptionSchema.parse(option)),
    );
    const externalComponents = input.components.map((component) => ComponentSchema.parse(component));
    const externalMetadata = input.metadata.map((metadata) => RetainedMetadataSchema.parse(metadata));

    const names = manifestClaimValues(claims, (claim) => claim.name);
    // Manifest display names degrade to precedence (canonical host first);
    // plugin identity always comes from the marketplace entry key, never
    // from this value, so drift here cannot misidentify the plugin.
    const manifestName = reducePresentational(names, order);
    if (!manifestName.ok) return manifestName;
    const versions = [
      ...(entry.version === undefined ? [] : [entry.version]),
      ...manifestClaimValues(claims, (claim) => claim.version),
    ];
    const version = reducePresentational(versions, order);
    if (!version.ok) return version;
    const descriptions = [
      ...(entry.description === undefined ? [] : [entry.description]),
      ...manifestClaimValues(claims, (claim) => claim.description),
    ];
    const description = reducePresentational(descriptions, order);
    if (!description.ok) return description;

    const manifestConfiguration = claims.flatMap((claim) => claim.configuration);
    const configuration = mergeConfiguration([...manifestConfiguration, ...externalConfiguration], plugin, order);
    if (!configuration.ok) return configuration;

    const foreign = [
      ...(input.foreignDeclarations ?? []),
      ...claims.flatMap((claim) => claim.foreign),
    ].map((declaration) => foreignDeclarationComponent(declaration, plugin, input.sha256));
    const components = realizeComponents([...externalComponents, ...foreign], plugin, input.sha256, order);
    if (!components.ok) return components;

    const metadata = mergeMetadata([
      ...entry.metadata,
      ...claims.flatMap((claim) => claim.metadata),
      ...externalMetadata,
    ], plugin, order);
    if (!metadata.ok) return metadata;

    const manifestNameValue = manifestName.value?.value;
    const identity = {
      ...entry.identity.value,
      ...(manifestNameValue === undefined || manifestNameValue === entry.identity.value.marketplaceEntryName
        ? {}
        : { manifestName: manifestNameValue }),
    };
    const normalized = NormalizedPluginSchema.parse({
      identity,
      ...(version.value === undefined ? {} : { version: version.value }),
      ...(description.value === undefined ? {} : { description: description.value }),
      source,
      configuration: { options: configuration.value },
      components: components.value,
      metadata: metadata.value,
    });
    return { ok: true, value: normalized, diagnostics: [] };
  } catch (error) {
    if (error instanceof z.ZodError) {
      return failure(ErrorCodeRegistry.schemaInvalid, "plugin bundle reconciliation input is invalid", plugin, {
        issues: error.issues.map((issue) => ({ code: issue.code, path: issue.path.map(String), message: issue.message })),
      });
    }
    return failure(ErrorCodeRegistry.schemaInvalid, error instanceof Error ? error.message : "plugin bundle reconciliation failed", plugin);
  }
}

export type { ReconcileInput as BundleReconciliationInput };