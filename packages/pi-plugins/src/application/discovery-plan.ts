import { z } from "zod";
import {
  ComponentLocatorClaimSchema,
  ForeignComponentDeclarationSchema,
  PluginManifestPathRegistry,
  type ComponentLocatorClaim,
  type ForeignComponentDeclaration,
  type PluginManifestClaims,
} from "../domain/bundle-ingestion.js";
import {
  DiagnosticSchema,
  ErrorCodeRegistry,
  type Diagnostic,
  type ReadResult,
} from "../domain/errors.js";
import {
  MarketplaceAuthoritySchema,
  NormalizedMarketplaceEntrySchema,
  type MarketplaceAuthority,
  type MarketplaceEntryDeclaration,
  type NormalizedMarketplaceEntry,
} from "../domain/marketplace.js";
import {
  NativeHostSchema,
  ProvenanceSchema,
  type NativeHost,
  type Provenance,
} from "../domain/provenance.js";
import {
  DEFAULT_HOST_PRECEDENCE,
  hostRank,
  type HostPrecedence,
} from "../domain/host-precedence.js";
import { PluginKeySchema } from "../domain/identity.js";
import { JsonValueSchema, type JsonValue } from "../domain/schema.js";
import { splitForeignDeclaration } from "../domain/foreign-identity.js";
import type { ContentIndex } from "./content-index.js";

const OPERATION = "createDiscoveryPlan";
type HostOrder = Readonly<Record<NativeHost, number>>;
const DEFAULT_HOST_ORDER: HostOrder = { claude: 0, codex: 1 };

function hostOrderFor(precedence: HostPrecedence): HostOrder {
  return { claude: hostRank(precedence, "claude"), codex: hostRank(precedence, "codex") };
}

export type ManifestPresence = Readonly<{
  nativeHost: NativeHost;
  path: string;
  required: boolean;
  present: boolean;
}>;

export const ManifestPresenceSchema = z.object({
  nativeHost: NativeHostSchema,
  path: z.string().min(1),
  required: z.boolean(),
  present: z.boolean(),
}).strict().readonly();

export type DiscoveryPlan = Readonly<{
  manifests: readonly ManifestPresence[];
  locators: readonly ComponentLocatorClaim[];
  catalogForeign: readonly ForeignComponentDeclaration[];
}>;

export const DiscoveryPlanSchema = z.object({
  manifests: z.array(ManifestPresenceSchema).readonly(),
  locators: z.array(ComponentLocatorClaimSchema).readonly(),
  catalogForeign: z.array(ForeignComponentDeclarationSchema).readonly()
}).strict().readonly();

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) =>
    `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
}

function locationKey(provenance: Provenance): string {
  const location = provenance.location;
  return stableJson([
    location.host,
    location.documentKind,
    location.path,
    location.pointer === undefined ? null : location.pointer,
    location.line === undefined ? null : location.line,
    location.column === undefined ? null : location.column,
  ]);
}

function compareProvenance(left: Provenance, right: Provenance, order: HostOrder): number {
  const host = order[left.location.host] - order[right.location.host];
  if (host !== 0) return host;
  const a = locationKey(left);
  const b = locationKey(right);
  return a < b ? -1 : a > b ? 1 : 0;
}

type ProvenanceCarrier = Readonly<{ provenance: readonly Provenance[] }> | readonly Provenance[];

function firstProvenance(claim: ProvenanceCarrier, order: HostOrder): Provenance {
  const provenance = Array.isArray(claim)
    ? claim
    : (claim as Readonly<{ provenance: readonly Provenance[] }>).provenance;
  return [...provenance].sort((a, b) => compareProvenance(a, b, order))[0] as Provenance;
}

function mergeProvenance(
  left: readonly Provenance[],
  right: readonly Provenance[],
  order: HostOrder,
): readonly [Provenance, ...Provenance[]] {
  const values = [...left, ...right].sort((a, b) => compareProvenance(a, b, order));
  const unique: Provenance[] = [];
  for (const value of values) {
    if (!unique.some((existing) =>
      locationKey(existing) === locationKey(value) &&
      stableJson(existing.declaration) === stableJson(value.declaration))) {
      unique.push(value);
    }
  }
  return unique as [Provenance, ...Provenance[]];
}

function normalizeCatalogPath(value: unknown, pointer: string): string {
  if (typeof value !== "string" || value.length < 3 || !value.startsWith("./")) {
    throw new Error(`${pointer} must be a relative path beginning with ./`);
  }
  if (value.includes("\\") || value.includes("\u0000")) {
    throw new Error(`${pointer} cannot contain backslashes or NUL bytes`);
  }
  const body = value.slice(2).endsWith("/") ? value.slice(2, -1) : value.slice(2);
  const segments = body.split("/");
  if (
    segments.some((segment) => segment.length === 0 || segment === "." || segment === "..") ||
    /^[A-Za-z]:/.test(segments[0] ?? "")
  ) {
    throw new Error(`${pointer} contains an unsafe path segment`);
  }
  return `./${segments.join("/")}`;
}

function sourceProvenance(
  host: NativeHost,
  path: string,
  pointer: string,
  declaration?: JsonValue,
): Provenance {
  return ProvenanceSchema.parse({
    location: { host, documentKind: "convention", path, pointer },
    ...(declaration === undefined ? {} : { declaration }),
  });
}

function diagnostic(
  code: "SCHEMA_INVALID" | "MANIFEST_ROOT_INVALID" | "PATH_CONTAINMENT_FAILED" | "CLAIM_CONFLICT",
  message: string,
  plugin?: string,
  provenance?: Provenance,
  details?: JsonValue,
): Diagnostic {
  return DiagnosticSchema.parse({
    code,
    severity: "error",
    operation: OPERATION,
    message,
    ...(plugin === undefined ? {} : { plugin: PluginKeySchema.parse(plugin) }),
    ...(provenance === undefined ? {} : { location: provenance.location }),
    ...(details === undefined ? {} : { details }),
  });
}

function failure(
  code: "SCHEMA_INVALID" | "MANIFEST_ROOT_INVALID" | "PATH_CONTAINMENT_FAILED" | "CLAIM_CONFLICT",
  message: string,
  plugin: string,
  provenance?: Provenance,
  details?: JsonValue,
): ReadResult<DiscoveryPlan> {
  return { ok: false, diagnostics: [diagnostic(code, message, plugin, provenance, details)] };
}

function manifestRequired(authority: MarketplaceAuthority): boolean {
  return authority.manifest.value === "required";
}

function contentPath(target: ComponentLocatorClaim["target"]): string | undefined {
  return target.kind === "inline" ? undefined : target.path.startsWith("./") ? target.path.slice(2) : target.path;
}

function targetKey(locator: ComponentLocatorClaim): string {
  return `${locator.componentKind}\u0000${stableJson(locator.target)}`;
}

function locatorSourceRank(source: ComponentLocatorClaim["source"]): number {
  return source === "catalog" ? 0 : source === "manifest" ? 1 : 2;
}

function locatorOrder(locator: ComponentLocatorClaim, order: HostOrder): string {
  return [
    targetKey(locator),
    String(locatorSourceRank(locator.source)),
    String(order[locator.nativeHost]),
    stableJson(locator.provenance.map(locationKey)),
  ].join("\u0000");
}

function deduplicateLocators(
  locators: readonly ComponentLocatorClaim[],
  order: HostOrder,
): readonly ComponentLocatorClaim[] {
  const byKey = new Map<string, ComponentLocatorClaim>();
  for (const candidate of locators) {
    const validated = ComponentLocatorClaimSchema.parse(candidate);
    const key = targetKey(validated);
    const current = byKey.get(key);
    if (current === undefined) {
      byKey.set(key, validated);
      continue;
    }
    const currentRank = [locatorSourceRank(current.source), order[current.nativeHost]];
    const nextRank = [locatorSourceRank(validated.source), order[validated.nativeHost]];
    const preferred = nextRank[0]! < currentRank[0]! ||
      (nextRank[0] === currentRank[0]! && nextRank[1]! < currentRank[1]!)
      ? validated
      : current;
    byKey.set(key, {
      ...preferred,
      provenance: mergeProvenance(current.provenance, validated.provenance, order),
    });
  }
  return [...byKey.values()].sort((left, right) => {
    const a = locatorOrder(left, order);
    const b = locatorOrder(right, order);
    return a < b ? -1 : a > b ? 1 : 0;
  });
}


function ensureExplicitTargets(
  content: ContentIndex,
  locators: readonly ComponentLocatorClaim[],
  plugin: string,
  order: HostOrder,
): ReadResult<DiscoveryPlan> | undefined {
  for (const locator of locators) {
    const path = contentPath(locator.target);
    if (path === undefined) continue;
    const entry = content.get(path);
    const provenance = firstProvenance(locator, order);
    const expectedKind = locator.target.kind;
    if (entry === undefined) {
      return failure(
        ErrorCodeRegistry.pathContainmentFailed,
        `explicit ${expectedKind} target is not present in the content manifest: ${path}`,
        plugin,
        provenance,
        { path, expected: expectedKind },
      );
    }
    if (entry.kind !== expectedKind) {
      return failure(
        ErrorCodeRegistry.pathContainmentFailed,
        `explicit ${expectedKind} target has manifest kind ${entry.kind}: ${path}`,
        plugin,
        provenance,
        { path, expected: expectedKind, actual: entry.kind },
      );
    }
  }
  return undefined;
}

function catalogLocator(
  declaration: MarketplaceEntryDeclaration,
  authority: "authoritative" | "supplemental",
  target: ComponentLocatorClaim["target"],
  provenance: readonly Provenance[],
  order: HostOrder,
): ComponentLocatorClaim {
  const componentKind = declaration.field === "skills"
    ? "skill"
    : declaration.field === "hooks"
      ? "hook"
      : "mcp-server";
  return {
    nativeHost: declaration.nativeHost,
    componentKind,
    authority,
    source: "catalog",
    target,
    provenance: mergeProvenance(provenance, [], order),
  };
}

function catalogPathLocators(
  declaration: MarketplaceEntryDeclaration,
  authority: "authoritative" | "supplemental",
  order: HostOrder,
): ComponentLocatorClaim[] {
  const raw = declaration.declaration.value;
  const pointer = declaration.declaration.provenance[0]?.location.pointer ?? `/${declaration.field}`;
  const declarationProvenance = declaration.declaration.provenance;
  const targetKind = declaration.field === "skills" ? "directory" : "file";
  if (declaration.field === "skills" && Array.isArray(raw)) {
    return raw.map((value, index) => catalogLocator(
      declaration,
      authority,
      { kind: targetKind, path: normalizeCatalogPath(value, `${pointer}/${index}`) },
      declarationProvenance,
      order,
    ));
  }
  if (declaration.field === "mcpServers" && raw !== null && typeof raw === "object" && !Array.isArray(raw)) {
    return [catalogLocator(declaration, authority, { kind: "inline", declaration: JsonValueSchema.parse(raw) }, declarationProvenance, order)];
  }
  if (declaration.field === "hooks" && raw !== null && typeof raw === "object" && !Array.isArray(raw)) {
    return [catalogLocator(declaration, authority, { kind: "inline", declaration: JsonValueSchema.parse(raw) }, declarationProvenance, order)];
  }
  if (typeof raw !== "string") {
    throw new Error(`${declaration.field} must be a path${declaration.field === "skills" ? " or array of paths" : " or inline object"}`);
  }
  return [catalogLocator(
    declaration,
    authority,
    { kind: targetKind, path: normalizeCatalogPath(raw, pointer) },
    declarationProvenance,
    order,
  )];
}

function catalogForeign(
  declaration: MarketplaceEntryDeclaration,
): readonly ForeignComponentDeclaration[] {
  const nativeKind = declaration.field;
  return splitForeignDeclaration(nativeKind, declaration.declaration).map((item) => ({
    nativeHost: declaration.nativeHost,
    nativeKind: {
      value: nativeKind,
      provenance: item.declaration.provenance,
    },
    declarationSubkey: item.declarationSubkey,
    declaration: item.declaration,
  }));
}

function conventionalLocator(
  host: NativeHost,
  componentKind: ComponentLocatorClaim["componentKind"],
  path: string,
  targetKind: "file" | "directory" = componentKind === "skill" ? "directory" : "file",
): ComponentLocatorClaim {
  const provenance = sourceProvenance(host, path, "", path);
  return {
    nativeHost: host,
    componentKind,
    authority: "conventional",
    source: "convention",
    target: {
      kind: targetKind,
      path: `./${path}`,
    },
    provenance: [provenance],
  };
}

function conventionLocators(
  entry: NormalizedMarketplaceEntry,
  content: ContentIndex,
  host: NativeHost,
  authority: MarketplaceAuthority,
  manifestPresent: boolean,
): ComponentLocatorClaim[] {
  if (host !== "claude") return [];
  const enabled = authority.strict?.value === false || manifestPresent;
  if (!enabled) return [];
  const locators: ComponentLocatorClaim[] = [];
  const skills = content.get("skills");
  if (skills?.kind === "directory") locators.push(conventionalLocator(host, "skill", "skills"));
  const rootSkill = content.get("SKILL.md");
  if (rootSkill?.kind === "file") locators.push(conventionalLocator(host, "skill", "SKILL.md", "file"));
  const hooks = content.get("hooks/hooks.json");
  if (hooks?.kind === "file") locators.push(conventionalLocator(host, "hook", "hooks/hooks.json"));
  const mcp = content.get(".mcp.json");
  if (mcp?.kind === "file") locators.push(conventionalLocator(host, "mcp-server", ".mcp.json"));
  void entry;
  return locators;
}

function manifestPresence(
  content: ContentIndex,
  host: NativeHost,
  required: boolean,
  plugin: string,
  authority: MarketplaceAuthority,
  order: HostOrder,
): ReadResult<ManifestPresence> {
  const path = host === "claude" ? PluginManifestPathRegistry.claude : PluginManifestPathRegistry.codex;
  const entry = content.get(path);
  const provenance = firstProvenance(authority.manifest, order);
  if (entry === undefined) {
    if (required) {
      return {
        ok: false,
        diagnostics: [diagnostic(
          ErrorCodeRegistry.manifestRootInvalid,
          `${host} plugin manifest is required but missing: ${path}`,
          plugin,
          provenance,
          { path, nativeHost: host },
        )],
      };
    }
    return { ok: true, value: { nativeHost: host, path, required, present: false }, diagnostics: [] };
  }
  if (entry.kind !== "file") {
    return {
      ok: false,
      diagnostics: [diagnostic(
        ErrorCodeRegistry.manifestRootInvalid,
        `${host} plugin manifest is not a regular file: ${path}`,
        plugin,
        provenance,
        { path, nativeHost: host, actual: entry.kind },
      )],
    };
  }
  return { ok: true, value: { nativeHost: host, path, required, present: true }, diagnostics: [] };
}

function authorityClaims(
  entry: NormalizedMarketplaceEntry,
  order: HostOrder,
): readonly MarketplaceAuthority[] {
  return [...entry.authorities].sort((left, right) => order[left.nativeHost] - order[right.nativeHost]);
}

/**
 * Build the finite inspection plan. This function never lists a directory: a
 * conventional locator exists only when its exact entry is in ContentIndex.
 */
export function createDiscoveryPlan(input: Readonly<{
  entry: NormalizedMarketplaceEntry;
  content: ContentIndex;
  claudeManifest?: PluginManifestClaims;
  codexManifest?: PluginManifestClaims;
  /** Canonical host order for plan ordering and locator preference; defaults to Claude-first. */
  hostPrecedence?: HostPrecedence;
}>): ReadResult<DiscoveryPlan> {
  try {
    const order = hostOrderFor(input.hostPrecedence ?? DEFAULT_HOST_PRECEDENCE);
    const entry = NormalizedMarketplaceEntrySchema.parse(input.entry);
    const content = input.content;
    const plugin = PluginKeySchema.parse(entry.identity.value.key);
    const authorities = authorityClaims(entry, order);
    const manifests: ManifestPresence[] = [];
    const locators: ComponentLocatorClaim[] = [];
    const foreign: ForeignComponentDeclaration[] = [];

    for (const authority of authorities) {
      const host = NativeHostSchema.parse(authority.nativeHost);
      MarketplaceAuthoritySchema.parse(authority);
      const presence = manifestPresence(content, host, manifestRequired(authority), plugin, authority, order);
      if (!presence.ok) return presence;
      manifests.push(presence.value);

      const manifest = host === "claude" ? input.claudeManifest : input.codexManifest;
      if (manifest !== undefined) {
        if (manifest.nativeHost !== host) {
          return failure(ErrorCodeRegistry.schemaInvalid, `${host} manifest claim has the wrong native host`, plugin, manifest.document);
        }
        const expectedPath = host === "claude" ? PluginManifestPathRegistry.claude : PluginManifestPathRegistry.codex;
        if (manifest.document.location.path !== expectedPath) {
          return failure(ErrorCodeRegistry.manifestRootInvalid, `${host} manifest claim has an unexpected path`, plugin, manifest.document);
        }
        locators.push(...manifest.locators);
      }

      const catalogAuthority = authority.catalogRuntime.value;
      for (const declaration of entry.declarations.filter((item) => item.nativeHost === host)) {
        if (declaration.field === "skills" || declaration.field === "hooks" || declaration.field === "mcpServers") {
          try {
            locators.push(...catalogPathLocators(declaration, catalogAuthority, order));
          } catch (error) {
            return failure(
              ErrorCodeRegistry.schemaInvalid,
              error instanceof Error ? error.message : "catalog component declaration is invalid",
              plugin,
              declaration.declaration.provenance[0],
            );
          }
        } else {
          foreign.push(...catalogForeign(declaration));
        }
      }

      const manifestPresent = presence.value.present;
      locators.push(...conventionLocators(entry, content, host, authority, manifestPresent));
    }

    // Divergent explicit locators across hosts are intentionally not a
    // conflict: each host may point at its own tree, and every locator
    // target is read and unioned downstream.
    const targetFailure = ensureExplicitTargets(content, locators, plugin, order);
    if (targetFailure !== undefined) return targetFailure;

    return {
      ok: true,
      value: {
        manifests: manifests.sort((left, right) => order[left.nativeHost] - order[right.nativeHost]),
        locators: deduplicateLocators(locators, order),
        catalogForeign: foreign.sort((left, right) => {
          const a = `${order[left.nativeHost]}\u0000${left.nativeKind.value}\u0000${left.declarationSubkey}`;
          const b = `${order[right.nativeHost]}\u0000${right.nativeKind.value}\u0000${right.declarationSubkey}`;
          return a < b ? -1 : a > b ? 1 : 0;
        }),
      },
      diagnostics: [],
    };
  } catch (error) {
    if (error instanceof z.ZodError) {
      return failure(ErrorCodeRegistry.schemaInvalid, "discovery plan input is invalid", String((input as { entry?: { identity?: { value?: { key?: string } } } }).entry?.identity?.value?.key ?? "unknown"), undefined, {
        issues: error.issues.map((issue) => ({ code: issue.code, path: issue.path.map(String), message: issue.message })),
      });
    }
    return failure(
      ErrorCodeRegistry.schemaInvalid,
      error instanceof Error ? error.message : "discovery plan is invalid",
      "unknown@unknown",
    );
  }
}
