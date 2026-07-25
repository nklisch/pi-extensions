import { z } from "zod";
import {
  BundleDocumentLimits,
  BundleDocumentLimitsSchema,
  type BundleInspectionInput,
  type BundleInspectionResult,
  type BundleDocumentLimitsContract,
} from "./inspection-contract.js";
import { createContentIndex, type ContentIndex, type ManifestFileEntry } from "./content-index.js";
import { createDiscoveryPlan, type DiscoveryPlan } from "./discovery-plan.js";
import { reconcilePluginBundle, buildPrecedenceResolutionMetadata } from "./bundle-reconciler.js";
import type { MaterializedPlugin } from "./source-materialization.js";
import type { ContentReadPort } from "./ports/content-read.js";
import type {
  BundleReaderSet,
  AgentSkillReaderContext,
} from "./ports/bundle-readers.js";
import {
  ContentDigestSchema,
  createMaterializationBinding,
  hashContent,
  verifyContentManifest,
  type ContentManifestEntry,
} from "../domain/content-manifest.js";
import {
  ForeignComponentDeclarationSchema,
  type ComponentLocatorClaim,
  type PluginManifestClaims,
} from "../domain/bundle-ingestion.js";
import {
  DiagnosticSchema,
  ErrorCodeRegistry,
  BoundaryError,
  type ReadResult,
} from "../domain/errors.js";
import {
  NormalizedMarketplaceEntrySchema,
  type NormalizedMarketplaceEntry,
} from "../domain/marketplace.js";
import {
  PluginKeySchema,
} from "../domain/identity.js";
import {
  NativeHostSchema,
  ProvenanceSchema,
  type NativeHost,
  type Provenance,
} from "../domain/provenance.js";
import { JsonValueSchema, type JsonValue } from "../domain/schema.js";
import {
  serializePluginSource,
  verifyResolvedPluginSource,
  matchesGitRevisionSelector,
  type ResolvedPluginSource,
  type Sha256,
} from "../domain/source.js";
import {
  SkillComponentSchema,
  type Component,
  type SkillComponent,
} from "../domain/components.js";
import {
  DEFAULT_HOST_PRECEDENCE,
  HostPrecedenceSchema,
  hostRank,
  type HostPrecedence,
} from "../domain/host-precedence.js";

const OPERATION = "inspectPluginBundle";
const ABSOLUTE_ROOT = /^(?:\/|[A-Za-z]:[\\/])/u;
const EXACT_VERSION = /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-(?:0|[1-9A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9A-Za-z-][0-9A-Za-z-]*))*)?(?:\+(?:0|[1-9A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9A-Za-z-][0-9A-Za-z-]*))*)?$/u;

type InspectionDependencies = Readonly<{
  content: ContentReadPort;
  readers: BundleReaderSet;
  sha256: Sha256;
  limits?: Partial<BundleDocumentLimitsContract>;
  /**
   * Resolves the user's canonical host order at call time. Defaults to
   * Claude-first. Changing precedence only affects new inspections; stored
   * normalized plugins are never rewritten.
   */
  hostPrecedence?: () => Promise<HostPrecedence>;
}>;

export interface PluginInspectionService {
  inspect(input: BundleInspectionInput, signal: AbortSignal): Promise<BundleInspectionResult>;
}

class StrictJsonFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StrictJsonFailure";
  }
}

/** A small JSON decoder that rejects duplicate and prototype-polluting keys. */
class StrictJsonParser {
  private position = 0;
  private nodes = 0;

  constructor(private readonly source: string) {}

  parse(): unknown {
    this.skipWhitespace();
    const value = this.readValue(0);
    this.skipWhitespace();
    if (this.position !== this.source.length) throw new StrictJsonFailure("JSON has trailing content");
    return value;
  }

  private readValue(depth: number): unknown {
    this.nodes += 1;
    if (this.nodes > 100_000) throw new StrictJsonFailure("JSON node limit exceeded");
    if (depth > 64) throw new StrictJsonFailure("JSON nesting depth exceeded");
    const character = this.source[this.position];
    if (character === "{") return this.readObject(depth + 1);
    if (character === "[") return this.readArray(depth + 1);
    if (character === '"') return this.readString();
    if (character === "t" && this.consume("true")) return true;
    if (character === "f" && this.consume("false")) return false;
    if (character === "n" && this.consume("null")) return null;
    return this.readNumber();
  }

  private readObject(depth: number): Record<string, unknown> {
    this.position += 1;
    const result = Object.create(null) as Record<string, unknown>;
    const keys = new Set<string>();
    this.skipWhitespace();
    if (this.source[this.position] === "}") {
      this.position += 1;
      return result;
    }
    while (true) {
      this.skipWhitespace();
      if (this.source[this.position] !== '"') throw new StrictJsonFailure("JSON object key must be a string");
      const key = this.readString();
      if (typeof key !== "string") throw new StrictJsonFailure("JSON object key is invalid");
      if (key === "__proto__" || key === "prototype" || key === "constructor") {
        throw new StrictJsonFailure(`JSON object key is unsafe: ${key}`);
      }
      if (keys.has(key)) throw new StrictJsonFailure(`duplicate JSON object key: ${key}`);
      keys.add(key);
      this.skipWhitespace();
      if (this.source[this.position] !== ":") throw new StrictJsonFailure("JSON object key must be followed by a colon");
      this.position += 1;
      this.skipWhitespace();
      result[key] = this.readValue(depth);
      this.skipWhitespace();
      const delimiter = this.source[this.position];
      if (delimiter === "}") {
        this.position += 1;
        return result;
      }
      if (delimiter !== ",") throw new StrictJsonFailure("JSON object must use commas between members");
      this.position += 1;
    }
  }

  private readArray(depth: number): unknown[] {
    this.position += 1;
    const result: unknown[] = [];
    this.skipWhitespace();
    if (this.source[this.position] === "]") {
      this.position += 1;
      return result;
    }
    while (true) {
      this.skipWhitespace();
      result.push(this.readValue(depth));
      this.skipWhitespace();
      const delimiter = this.source[this.position];
      if (delimiter === "]") {
        this.position += 1;
        return result;
      }
      if (delimiter !== ",") throw new StrictJsonFailure("JSON array must use commas between values");
      this.position += 1;
    }
  }

  private readString(): string {
    const start = this.position;
    this.position += 1;
    while (this.position < this.source.length) {
      const character = this.source[this.position];
      if (character === '"') {
        this.position += 1;
        const raw = this.source.slice(start, this.position);
        try {
          return JSON.parse(raw) as string;
        } catch {
          throw new StrictJsonFailure("JSON string escape is invalid");
        }
      }
      if (character === "\\") {
        this.position += 1;
        if (this.position >= this.source.length) throw new StrictJsonFailure("JSON string escape is unterminated");
        const escape = this.source[this.position];
        if (escape === "u") {
          const hex = this.source.slice(this.position + 1, this.position + 5);
          if (!/^[0-9a-f]{4}$/iu.test(hex)) throw new StrictJsonFailure("JSON unicode escape is invalid");
          this.position += 4;
        } else if (escape !== '"' && escape !== "\\" && escape !== "/" && escape !== "b" && escape !== "f" && escape !== "n" && escape !== "r" && escape !== "t") {
          throw new StrictJsonFailure("JSON string escape is invalid");
        }
      } else if ((character?.charCodeAt(0) ?? 0) < 0x20) {
        throw new StrictJsonFailure("JSON strings cannot contain control characters");
      }
      this.position += 1;
    }
    throw new StrictJsonFailure("JSON string is unterminated");
  }

  private readNumber(): number {
    const match = this.source.slice(this.position).match(/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/u);
    if (match === null) throw new StrictJsonFailure("JSON value is invalid");
    this.position += match[0].length;
    const value = Number(match[0]);
    if (!Number.isFinite(value)) throw new StrictJsonFailure("JSON number is not finite");
    return value;
  }

  private consume(value: string): boolean {
    if (this.source.slice(this.position, this.position + value.length) !== value) return false;
    this.position += value.length;
    return true;
  }

  private skipWhitespace(): void {
    while (this.position < this.source.length && /[\u0020\u0009\u000a\u000d]/u.test(this.source[this.position] ?? "")) this.position += 1;
  }
}

function safePlugin(input: unknown): string {
  try {
    return PluginKeySchema.parse((input as { readonly entry?: { readonly identity?: { readonly value?: { readonly key?: unknown } } } }).entry?.identity?.value?.key);
  } catch {
    return "unknown@unknown";
  }
}

function failure<T>(
  code: "SCHEMA_INVALID" | "MANIFEST_ROOT_INVALID" | "PATH_CONTAINMENT_FAILED" | "CLAIM_CONFLICT",
  message: string,
  plugin: string,
  provenance?: Provenance,
  details?: JsonValue,
): ReadResult<T> {
  return {
    ok: false,
    diagnostics: [DiagnosticSchema.parse({
      code,
      severity: "error",
      operation: OPERATION,
      message,
      plugin: (() => { try { return PluginKeySchema.parse(plugin); } catch { return undefined; } })(),
      ...(provenance === undefined ? {} : { location: provenance.location }),
      ...(details === undefined ? {} : { details }),
    })],
  };
}

function abortIfRequested(signal: AbortSignal): void {
  if (!signal.aborted) return;
  throw signal.reason ?? new DOMException("The operation was aborted", "AbortError");
}

function sourceFailure(message: string, cause?: unknown): BoundaryError {
  return new BoundaryError({
    code: ErrorCodeRegistry.sourceResolutionFailed,
    operation: OPERATION,
    message,
    details: { operation: OPERATION },
    cause,
  });
}

function pathFailure(message: string, cause?: unknown): BoundaryError {
  return new BoundaryError({
    code: ErrorCodeRegistry.pathContainmentFailed,
    operation: OPERATION,
    message,
    details: { operation: OPERATION },
    cause,
  });
}

function adapterFailure(error: unknown): BoundaryError {
  if (error instanceof BoundaryError) return error;
  return new BoundaryError({
    code: ErrorCodeRegistry.adapterFailed,
    operation: OPERATION,
    message: "plugin content adapter failed",
    details: { operation: OPERATION },
    cause: error,
  });
}

function normalizeTargetPath(path: string): string {
  return path.startsWith("./") ? path.slice(2) : path;
}

function sourceMatches(entry: NormalizedMarketplaceEntry, source: ResolvedPluginSource): boolean {
  const declared = entry.source.value;
  if (declared.kind !== source.kind) return false;
  switch (declared.kind) {
    case "marketplace-path":
      return source.kind === "marketplace-path" && source.path === declared.path;
    case "git": {
      if (source.kind !== "git" || serializePluginSource({ kind: "git", url: declared.url }) !== serializePluginSource({ kind: "git", url: source.url })) return false;
      return matchesGitRevisionSelector(declared, source.revision);
    }
    case "git-subdir": {
      if (source.kind !== "git-subdir" || declared.path !== source.path || serializePluginSource({ kind: "git", url: declared.url }) !== serializePluginSource({ kind: "git", url: source.url })) return false;
      return matchesGitRevisionSelector(declared, source.revision);
    }
    case "npm": {
      if (source.kind !== "npm" || source.package !== declared.package) return false;
      const expectedRegistry = declared.registry ?? "https://registry.npmjs.org/";
      if (serializePluginSource({ kind: "npm", package: declared.package, registry: expectedRegistry }) !== serializePluginSource({ kind: "npm", package: source.package, registry: source.registry })) return false;
      return declared.selector === undefined || !EXACT_VERSION.test(declared.selector) || source.version === declared.selector;
    }
  }
}

function documentProvenance(
  locator: ComponentLocatorClaim,
  path: string,
  documentKind: "hooks" | "mcp" | "skill" | "convention",
  declaration?: JsonValue,
): Provenance {
  const source = [...locator.provenance].sort((left, right) => {
    const a = `${left.location.host}\u0000${left.location.path}\u0000${left.location.pointer ?? ""}`;
    const b = `${right.location.host}\u0000${right.location.path}\u0000${right.location.pointer ?? ""}`;
    return a < b ? -1 : a > b ? 1 : 0;
  })[0];
  return ProvenanceSchema.parse({
    location: {
      host: source?.location.host ?? locator.nativeHost,
      documentKind,
      path,
      pointer: "",
    },
    ...(declaration === undefined ? {} : { declaration }),
  });
}

function firstLocatorProvenance(locator: ComponentLocatorClaim): Provenance {
  const value = [...locator.provenance].sort((left, right) => {
    const a = `${left.location.host}\u0000${left.location.documentKind}\u0000${left.location.path}\u0000${left.location.pointer ?? ""}`;
    const b = `${right.location.host}\u0000${right.location.documentKind}\u0000${right.location.path}\u0000${right.location.pointer ?? ""}`;
    return a < b ? -1 : a > b ? 1 : 0;
  })[0];
  if (value === undefined) throw new Error("locator provenance cannot be empty");
  return value;
}

function decodeUtf8(
  bytes: Uint8Array,
  plugin: string,
  provenance: Provenance,
): ReadResult<string> {
  try {
    return {
      ok: true,
      value: new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      diagnostics: [],
    };
  } catch (error) {
    return failure(
      ErrorCodeRegistry.schemaInvalid,
      error instanceof Error ? error.message : "document is not valid UTF-8",
      plugin,
      provenance,
    );
  }
}

function parseJson(bytes: Uint8Array, limit: number): unknown {
  if (bytes.byteLength > limit) throw new StrictJsonFailure("JSON document byte limit exceeded");
  const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  return new StrictJsonParser(source).parse();
}

function manifestEntryFor(content: ContentIndex, path: string): ManifestFileEntry | undefined {
  const entry = content.get(path);
  return entry?.kind === "file" ? entry : undefined;
}

function isDirectoryCandidate(entry: ContentManifestEntry, prefix: string): boolean {
  return entry.path.startsWith(prefix) && entry.path.split("/").at(-1) === "SKILL.md";
}

function candidateSkillEntries(content: ContentIndex, root: string): ReadResult<readonly ManifestFileEntry[]> {
  const normalized = normalizeTargetPath(root);
  const prefix = normalized === "" ? "" : `${normalized}/`;
  const candidates = content.manifest.entries.filter((entry) => isDirectoryCandidate(entry, prefix));
  for (const candidate of candidates) {
    if (candidate.kind !== "file") {
      return failure(
        ErrorCodeRegistry.pathContainmentFailed,
        `discovered SKILL.md is not a regular file: ${candidate.path}`,
        "unknown@unknown",
        undefined,
        { path: candidate.path, actual: candidate.kind },
      );
    }
  }
  return { ok: true, value: candidates as ManifestFileEntry[], diagnostics: [] };
}

function skillRoot(path: string): string {
  const normalized = normalizeTargetPath(path);
  const root = normalized.slice(0, -"/SKILL.md".length);
  return root === "" ? "." : root;
}

function nestedSkillRoots(roots: readonly string[]): string | undefined {
  const sorted = [...new Set(roots)].sort();
  for (let index = 0; index < sorted.length; index += 1) {
    const current = sorted[index]!;
    const next = sorted[index + 1];
    if (next !== undefined && next.startsWith(`${current}/`)) return next;
  }
  return undefined;
}

function mergeResultFailure<T>(result: ReadResult<T>): ReadResult<never> | undefined {
  return result.ok ? undefined : result;
}

function manifestReader(readers: BundleReaderSet, host: NativeHost): BundleReaderSet["claudeManifest"] {
  return host === "claude" ? readers.claudeManifest : readers.codexManifest;
}

function hookReader(readers: BundleReaderSet, host: NativeHost): BundleReaderSet["claudeHooks"] {
  return host === "claude" ? readers.claudeHooks : readers.codexHooks;
}

function mcpReader(readers: BundleReaderSet, host: NativeHost): BundleReaderSet["claudeMcp"] {
  return host === "claude" ? readers.claudeMcp : readers.codexMcp;
}

function skillPresentationPath(root: string): string {
  return root === "." ? "agents/openai.yaml" : `${root}/agents/openai.yaml`;
}

function uniqueProvenances(locator: ComponentLocatorClaim): readonly Provenance[] {
  const seen = new Set<string>();
  const result: Provenance[] = [];
  for (const value of locator.provenance) {
    const key = `${value.location.host}\u0000${value.location.documentKind}\u0000${value.location.path}\u0000${value.location.pointer ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(value);
  }
  return result.sort((left, right) => {
    const a = `${left.location.host}\u0000${left.location.documentKind}\u0000${left.location.path}\u0000${left.location.pointer ?? ""}`;
    const b = `${right.location.host}\u0000${right.location.documentKind}\u0000${right.location.path}\u0000${right.location.pointer ?? ""}`;
    return a < b ? -1 : a > b ? 1 : 0;
  });
}

/**
 * Same-name skills from different host trees cannot both activate. Blocking
 * the whole plugin over that is the opposite of best-effort: keep the
 * precedence winner (canonical host order, then root path for determinism),
 * record the superseded skills on the winner as resolution metadata, and
 * activate the rest of the plugin untouched.
 */
function dedupeSkillNames(components: readonly Component[], precedence: HostPrecedence): readonly Component[] {
  const hostOrder = (host: string): number =>
    host === "claude" || host === "codex" ? hostRank(precedence, host) : precedence.length;
  const skillSortKey = (component: SkillComponent): string => {
    const location = [...component.root.provenance].sort((left, right) => {
      const host = hostOrder(left.location.host) - hostOrder(right.location.host);
      if (host !== 0) return host;
      const a = `${left.location.host}\u0000${left.location.path}`;
      const b = `${right.location.host}\u0000${right.location.path}`;
      return a < b ? -1 : a > b ? 1 : 0;
    })[0]?.location;
    return `${String(hostOrder(location?.host ?? "")).padStart(2, "0")}\u0000${location?.path ?? ""}\u0000${component.root.value}`;
  };
  const byName = new Map<string, SkillComponent[]>();
  for (const component of components) {
    if (component.kind !== "skill") continue;
    const group = byName.get(component.name.value) ?? [];
    group.push(component);
    byName.set(component.name.value, group);
  }
  const replacements = new Map<string, SkillComponent>();
  const dropped = new Set<string>();
  for (const group of byName.values()) {
    const distinct = new Map(group.map((skill) => [skill.id, skill]));
    if (distinct.size < 2) continue;
    const ordered = [...distinct.values()].sort((left, right) => {
      const a = skillSortKey(left);
      const b = skillSortKey(right);
      return a < b ? -1 : a > b ? 1 : 0;
    });
    const winner = ordered[0]!;
    const notes = ordered.slice(1).map((loser) =>
      buildPrecedenceResolutionMetadata("skill.name", winner.root, loser.root, {
        claude: hostRank(precedence, "claude"),
        codex: hostRank(precedence, "codex"),
      }));
    replacements.set(winner.id, SkillComponentSchema.parse({ ...winner, metadata: [...winner.metadata, ...notes] }));
    for (const loser of ordered.slice(1)) dropped.add(loser.id);
  }
  if (replacements.size === 0 && dropped.size === 0) return components;
  const result: Component[] = [];
  for (const component of components) {
    if (dropped.has(component.id)) continue;
    result.push(replacements.get(component.id) ?? component);
  }
  return result;
}

function createService(dependencies: InspectionDependencies): PluginInspectionService {
  const limits = BundleDocumentLimitsSchema.parse({
    ...BundleDocumentLimits,
    ...(dependencies.limits ?? {}),
  });

  async function inspect(input: BundleInspectionInput, signal: AbortSignal): Promise<BundleInspectionResult> {
    abortIfRequested(signal);
    const plugin = safePlugin(input);
    // Resolve the user's host precedence once per inspection so one run sees
    // a single canonical order even if the preference changes mid-flight.
    const precedence = dependencies.hostPrecedence === undefined
      ? DEFAULT_HOST_PRECEDENCE
      : HostPrecedenceSchema.parse(await dependencies.hostPrecedence());
    abortIfRequested(signal);
    let entry: NormalizedMarketplaceEntry;
    try {
      entry = NormalizedMarketplaceEntrySchema.parse(input.entry);
    } catch (error) {
      return failure(ErrorCodeRegistry.schemaInvalid, "marketplace entry is invalid", plugin, undefined, {
        reason: error instanceof z.ZodError ? error.issues[0]?.message ?? "invalid entry" : String(error),
      });
    }

    const rawMaterialized = (input as unknown as { readonly materialized?: unknown }).materialized;
    if (rawMaterialized === null || typeof rawMaterialized !== "object" || Array.isArray(rawMaterialized)) {
      throw pathFailure("materialized plugin handoff is not trustworthy");
    }
    const materializedRecord = rawMaterialized as Record<string, unknown>;
    if (typeof materializedRecord.root !== "string" || !ABSOLUTE_ROOT.test(materializedRecord.root)) {
      throw pathFailure("materialized content root must be absolute");
    }

    let source: ResolvedPluginSource;
    try {
      source = verifyResolvedPluginSource(materializedRecord.source, dependencies.sha256);
    } catch (error) {
      throw sourceFailure("resolved plugin source is not verified", error);
    }
    let contentManifest;
    try {
      contentManifest = verifyContentManifest(materializedRecord.content, dependencies.sha256);
    } catch (error) {
      throw pathFailure("materialized content manifest is not verified", error);
    }
    let binding: string;
    try {
      binding = ContentDigestSchema.parse(materializedRecord.binding);
    } catch (error) {
      throw sourceFailure("materialized source/content binding is not verified", error);
    }
    try {
      const expectedBinding = createMaterializationBinding(source.hash, contentManifest.rootDigest, dependencies.sha256);
      if (binding !== expectedBinding) throw new Error("source/content binding does not match");
    } catch (error) {
      throw sourceFailure("materialized source/content binding is not verified", error);
    }
    if (!sourceMatches(entry, source)) throw sourceFailure("resolved plugin source does not match marketplace entry");
    const materialized: MaterializedPlugin = {
      root: materializedRecord.root,
      source,
      content: contentManifest,
      binding: binding as MaterializedPlugin["binding"],
    };

    const content = createContentIndex(contentManifest);
    const contentCache = new Map<string, Uint8Array>();

    const readBytes = async (entryRef: ManifestFileEntry, limit: number): Promise<Uint8Array> => {
      abortIfRequested(signal);
      const cached = contentCache.get(entryRef.path);
      if (cached !== undefined) return cached;
      let bytes: Uint8Array;
      try {
        bytes = await dependencies.content.readFile({ root: materialized.root, entry: entryRef }, limit, signal);
        abortIfRequested(signal);
      } catch (error) {
        if (signal.aborted) throw signal.reason ?? error;
        throw adapterFailure(error);
      }
      if (!(bytes instanceof Uint8Array) || bytes.byteLength !== entryRef.size) {
        throw adapterFailure(new Error("content adapter returned bytes that do not match the manifest size"));
      }
      if (hashContent(bytes, dependencies.sha256) !== entryRef.digest) {
        throw adapterFailure(new Error("content adapter returned bytes that do not match the manifest digest"));
      }
      contentCache.set(entryRef.path, bytes);
      return bytes;
    };

    const initialPlan = createDiscoveryPlan({ entry, content, hostPrecedence: precedence });
    if (!initialPlan.ok) return initialPlan;

    const manifestClaims: PluginManifestClaims[] = [];
    for (const manifest of initialPlan.value.manifests) {
      if (!manifest.present) continue;
      const entryRef = manifestEntryFor(content, manifest.path);
      if (entryRef === undefined) {
        return failure(ErrorCodeRegistry.manifestRootInvalid, `manifest is not a regular file: ${manifest.path}`, entry.identity.value.key, undefined, { path: manifest.path });
      }
      let parsed: unknown;
      try {
        parsed = parseJson(await readBytes(entryRef, limits.manifestBytes), limits.manifestBytes);
      } catch (error) {
        if (error instanceof BoundaryError) throw error;
        return failure(ErrorCodeRegistry.manifestRootInvalid, error instanceof Error ? error.message : "manifest JSON is invalid", entry.identity.value.key, {
          location: { host: manifest.nativeHost, documentKind: "manifest", path: manifest.path, pointer: "" },
        } as unknown as Provenance);
      }
      const result = manifestReader(dependencies.readers, manifest.nativeHost)(parsed, {
        plugin: PluginKeySchema.parse(entry.identity.value.key),
        path: manifest.path,
      });
      const failed = mergeResultFailure(result);
      if (failed !== undefined) return failed;
      if (result.ok) manifestClaims.push(result.value);
    }

    const discoveryInput: {
      entry: NormalizedMarketplaceEntry;
      content: ContentIndex;
      claudeManifest?: PluginManifestClaims;
      codexManifest?: PluginManifestClaims;
      hostPrecedence?: HostPrecedence;
    } = { entry, content, hostPrecedence: precedence };
    const claudeManifest = manifestClaims.find((claim) => claim.nativeHost === "claude");
    const codexManifest = manifestClaims.find((claim) => claim.nativeHost === "codex");
    if (claudeManifest !== undefined) discoveryInput.claudeManifest = claudeManifest;
    if (codexManifest !== undefined) discoveryInput.codexManifest = codexManifest;
    const planResult = createDiscoveryPlan(discoveryInput);
    if (!planResult.ok) return planResult;
    const plan: DiscoveryPlan = planResult.value;
    const components: Component[] = [];
    const skillLocators = plan.locators.filter((locator) => locator.componentKind === "skill");
    const skillDocuments = new Map<string, { entry: ManifestFileEntry; locators: ComponentLocatorClaim[] }>();

    for (const locator of skillLocators) {
      if (locator.target.kind === "inline") {
        return failure(ErrorCodeRegistry.schemaInvalid, "skill locators cannot be inline declarations", entry.identity.value.key, firstLocatorProvenance(locator));
      }
      if (locator.target.kind === "file") {
        const entryRef = content.requireFile(locator.target.path, firstLocatorProvenance(locator));
        const path = entryRef.path;
        const current = skillDocuments.get(path);
        if (current === undefined) skillDocuments.set(path, { entry: entryRef, locators: [locator] });
        else current.locators.push(locator);
        continue;
      }
      const directory = content.requireDirectory(locator.target.path, firstLocatorProvenance(locator));
      void directory;
      const candidates = candidateSkillEntries(content, locator.target.path);
      if (!candidates.ok) return candidates;
      for (const entryRef of candidates.value) {
        const current = skillDocuments.get(entryRef.path);
        if (current === undefined) skillDocuments.set(entryRef.path, { entry: entryRef, locators: [locator] });
        else current.locators.push(locator);
      }
    }

    const roots = [...skillDocuments.keys()].map(skillRoot);
    const nested = nestedSkillRoots(roots);
    if (nested !== undefined) return failure(ErrorCodeRegistry.claimConflict, `nested Agent Skill roots are ambiguous: ${nested}`, entry.identity.value.key);

    for (const [path, document] of [...skillDocuments.entries()].sort(([left], [right]) => left.localeCompare(right))) {
      const skillProvenance = documentProvenance(document.locators[0]!, path, "skill");
      const markdownBytes = await readBytes(document.entry, limits.skillBytes);
      const markdownText = decodeUtf8(markdownBytes, entry.identity.value.key, skillProvenance);
      if (!markdownText.ok) return markdownText;
      const markdown = markdownText.value;
      let presentation: JsonValue | undefined;
      const root = skillRoot(path);
      const presentationEntry = content.get(skillPresentationPath(root));
      if (presentationEntry !== undefined && presentationEntry.kind !== "file") {
        return failure(ErrorCodeRegistry.pathContainmentFailed, `skill presentation is not a regular file: ${skillPresentationPath(root)}`, entry.identity.value.key);
      }
      if (presentationEntry?.kind === "file") {
        if (dependencies.readers.skillPresentation === undefined) {
          return failure(ErrorCodeRegistry.schemaInvalid, "Codex skill presentation reader is not configured", entry.identity.value.key);
        }
        const presentationProvenance = documentProvenance(document.locators[0]!, skillPresentationPath(root), "convention");
        const presentationBytes = await readBytes(presentationEntry, limits.skillBytes);
        const presentationText = decodeUtf8(presentationBytes, entry.identity.value.key, presentationProvenance);
        if (!presentationText.ok) return presentationText;
        const presentationResult = dependencies.readers.skillPresentation(
          presentationText.value,
          presentationProvenance,
          {
            maxDocumentBytes: limits.skillBytes,
            maxFrontmatterBytes: limits.frontmatterBytes,
            maxFrontmatterLines: limits.frontmatterLines,
            maxDepth: limits.frontmatterDepth,
            maxNodes: limits.frontmatterNodes,
            maxScalarBytes: limits.frontmatterScalarBytes,
          },
        );
        if (!presentationResult.ok) return presentationResult;
        presentation = presentationResult.value;
      }
      for (const locator of document.locators) {
        for (const provenance of uniqueProvenances(locator)) {
          const context: AgentSkillReaderContext = {
            plugin: PluginKeySchema.parse(entry.identity.value.key),
            root,
            documentPath: path,
            provenance: documentProvenance({ ...locator, provenance: [provenance] }, path, "skill"),
            ...(presentation === undefined ? {} : { presentation }),
            limits: {
              maxDocumentBytes: limits.skillBytes,
              maxFrontmatterBytes: limits.frontmatterBytes,
              maxFrontmatterLines: limits.frontmatterLines,
              maxDepth: limits.frontmatterDepth,
              maxNodes: limits.frontmatterNodes,
              maxScalarBytes: limits.frontmatterScalarBytes,
            },
          };
          const result = dependencies.readers.agentSkill(markdown, context);
          if (!result.ok) return result;
          components.push(result.value);
        }
      }
    }

    for (const locator of plan.locators.filter((value) => value.componentKind !== "skill")) {
      const readerProvenances = uniqueProvenances(locator);
      for (const provenance of readerProvenances) {
        const host = NativeHostSchema.parse(provenance.location.host);
        const target = locator.target;
        const documentKind = locator.componentKind === "hook" ? "hooks" : "mcp";
        const readerProvenance = documentProvenance({ ...locator, provenance: [provenance] }, target.kind === "inline" ? provenance.location.path : normalizeTargetPath(target.path), documentKind, target.kind === "inline" ? target.declaration : undefined);
        let parsed: unknown;
        if (target.kind === "inline") {
          parsed = target.declaration;
        } else {
          const entryRef = content.requireFile(target.path, provenance);
          try {
            parsed = parseJson(await readBytes(entryRef, locator.componentKind === "hook" ? limits.hooksBytes : limits.mcpBytes), locator.componentKind === "hook" ? limits.hooksBytes : limits.mcpBytes);
          } catch (error) {
            if (error instanceof BoundaryError) throw error;
            return failure(ErrorCodeRegistry.manifestRootInvalid, error instanceof Error ? error.message : "component JSON is invalid", entry.identity.value.key, readerProvenance);
          }
        }
        const result = locator.componentKind === "hook"
          ? hookReader(dependencies.readers, host)(parsed, { plugin: PluginKeySchema.parse(entry.identity.value.key), nativeHost: host, provenance: readerProvenance })
          : mcpReader(dependencies.readers, host)(parsed, { plugin: PluginKeySchema.parse(entry.identity.value.key), nativeHost: host, provenance: readerProvenance });
        if (!result.ok) return result;
        components.push(...result.value);
      }
    }

    // A plugin-root package.json with pi.extensions ships a Pi extension
    // (tools/commands). This host deliberately never imports plugin code
    // in-process, so the extension is projected as a foreign metadata-only
    // component: visible in review and diagnostics, never executed.
    const foreignDeclarations = [...plan.catalogForeign];
    const packageEntry = content.get("package.json");
    if (packageEntry?.kind === "file") {
      const packageProvenance = ProvenanceSchema.parse({
        location: { host: precedence[0] ?? "claude", documentKind: "convention", path: "package.json", pointer: "" },
      });
      const packageText = decodeUtf8(await readBytes(packageEntry, limits.manifestBytes), entry.identity.value.key, packageProvenance);
      if (!packageText.ok) return packageText;
      let extensions: unknown;
      try {
        const parsed: unknown = JSON.parse(packageText.value);
        const pi = parsed !== null && typeof parsed === "object" && "pi" in parsed
          ? (parsed as { pi?: unknown }).pi
          : undefined;
        extensions = pi !== null && typeof pi === "object" && "extensions" in pi
          ? (pi as { extensions?: unknown }).extensions
          : undefined;
      } catch {
        // package.json is not a host document; malformed JSON is not a failure.
        extensions = undefined;
      }
      if (Array.isArray(extensions) && extensions.length > 0) {
        foreignDeclarations.push(ForeignComponentDeclarationSchema.parse({
          nativeHost: precedence[0] ?? "claude",
          nativeKind: { value: "pi-extension", provenance: [packageProvenance] },
          declarationSubkey: "pi.extensions",
          declaration: { value: JsonValueSchema.parse(extensions), provenance: [packageProvenance] },
        }));
      }
    }

    return reconcilePluginBundle({
      entry,
      source,
      manifestClaims,
      foreignDeclarations,
      configuration: [],
      components: dedupeSkillNames(components, precedence),
      metadata: entry.metadata,
      sha256: dependencies.sha256,
      hostPrecedence: precedence,
    });
  }

  return { inspect };
}

export function createPluginInspectionService(dependencies: InspectionDependencies): PluginInspectionService {
  if (typeof dependencies.sha256 !== "function") throw new TypeError("plugin inspection requires a SHA-256 function");
  if (dependencies.content === null || typeof dependencies.content.readFile !== "function") throw new TypeError("plugin inspection requires a content reader");
  return createService(dependencies);
}

export type { InspectionDependencies as PluginInspectionDependencies };