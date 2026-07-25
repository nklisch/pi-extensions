import { z } from "zod";
import {
  MarketplaceConfigurationRecordSchema,
  HostConfigDocumentSchema,
  GenerationSchema,
  type Generation,
} from "./config-state.js";
import {
  InstalledUserStateDocumentSchema,
  createInstalledPluginRecord,
  createMarketplaceSnapshotRecord,
  type InstalledPluginRecord,
  type InstalledUserStateDocument,
} from "./installed-state.js";
import {
  ProjectLocalStateDocumentSchema,
  UNSYNCHRONIZED_PORTABLE_INTENT,
  createProjectLocalStateDocument,
} from "./project-state.js";
import { PortableProjectDeclarationSchema } from "./portable-project-declaration.js";
import { StatePointersDocumentSchema } from "./pointers.js";
import {
  TrustStateDocumentSchema,
  createTrustStateRecord,
  type TrustStateRecord,
} from "./trust-state.js";
import {
  StateDocumentKindSchema,
  getStateDocumentDefinition,
  type StateDocumentByKind,
  type StateDocumentFor,
  type StateDocumentKind,
} from "./registry.js";
import {
  ScopeContextSchema,
  ScopeReferenceSchema,
  createScopeContext,
  toScopeReference,
  type ScopeContext,
  type ScopeReference,
} from "./scope.js";
import {
  ContentDigestSchema,
  hashContent,
  type ContentDigest,
} from "../content-manifest.js";
import { JsonValueSchema, type JsonValue } from "../schema.js";
import { MarketplaceNameSchema, PluginKeySchema } from "../identity.js";
import {
  MarketplaceRegistrationRecordSchema,
  type MarketplaceRegistrationRecord,
} from "../update-policy.js";
import { TrustSubjectRefSchema } from "./references.js";
import { serializeMarketplaceSource, type Sha256 } from "../source.js";

/** A readable version field; anything else is malformed, not stale. */
const StateDocumentVersionFieldSchema = z.number().int().positive().safe();


/** Registry-owned corruption codes and fixed summaries. */
export const StateCorruptionCodeRegistry = {
  documentInvalid: { code: "DOCUMENT_INVALID", summary: "state document is invalid" },
  generationMismatch: { code: "GENERATION_MISMATCH", summary: "state document generation is not selected" },
  scopeMismatch: { code: "SCOPE_MISMATCH", summary: "state document scope is not selected" },
  recordInvalid: { code: "RECORD_INVALID", summary: "state record was quarantined" },
  recordDuplicate: { code: "RECORD_DUPLICATE", summary: "duplicate state record was quarantined" },
  digestMismatch: { code: "DIGEST_MISMATCH", summary: "state document digest does not match" },
} as const;
const corruptionDefinitions = Object.values(StateCorruptionCodeRegistry);
const corruptionCodes = corruptionDefinitions.map((definition) => definition.code) as [string, ...string[]];
const corruptionSummaries = corruptionDefinitions.map((definition) => definition.summary) as [string, ...string[]];
export const StateCorruptionCodeSchema = z.enum(corruptionCodes);
export const StateCorruptionSummarySchema = z.enum(corruptionSummaries);
export type StateCorruptionCode = z.infer<typeof StateCorruptionCodeSchema>;
export type StateCorruptionSummary = z.infer<typeof StateCorruptionSummarySchema>;

/** Registry-owned field ids are safer than exposing parser paths or messages. */
export const StateCorruptionFieldRegistry = {
  root: "root",
  schemaVersion: "schemaVersion",
  generation: "generation",
  scope: "scope",
  document: "document",
  records: "records",
  marketplaces: "marketplaces",
  marketplaceUpdates: "marketplaceUpdates",
  plugins: "plugins",
  revisions: "revisions",
  projectKey: "projectKey",
  identity: "identity",
  declarationDigest: "declarationDigest",
  documents: "documents",
  digest: "digest",
  blob: "blob",
} as const;
const corruptionFieldIds = Object.values(StateCorruptionFieldRegistry) as [string, ...string[]];
export const StateCorruptionFieldIdSchema = z.enum(corruptionFieldIds);
export type StateCorruptionFieldId = z.infer<typeof StateCorruptionFieldIdSchema>;

const corruptionPointerSegments = new Set(corruptionFieldIds);
export const StateCorruptionPointerSchema = z.string().max(128).regex(/^(?:\/(?:[A-Za-z][A-Za-z0-9]*|[0-9]+|~0|~1))*$/).superRefine((value, context) => {
  for (const segment of value.split("/").slice(1)) {
    if (/^[0-9]+$/.test(segment)) continue;
    if (!corruptionPointerSegments.has(segment.replaceAll("~1", "/").replaceAll("~0", "~"))) {
      context.addIssue({ code: "custom", message: "state corruption pointer uses an unknown field" });
      return;
    }
  }
});
export type StateCorruptionPointer = z.infer<typeof StateCorruptionPointerSchema>;

const StateRecordIdentitySchema = z.union([MarketplaceNameSchema, PluginKeySchema, TrustSubjectRefSchema]);
export const StateCorruptionLocationSchema = z.union([
  z.object({ kind: z.literal("field"), id: StateCorruptionFieldIdSchema }).strict().readonly(),
  z.object({ kind: z.literal("pointer"), value: StateCorruptionPointerSchema }).strict().readonly(),
]);
export type StateCorruptionLocation = z.infer<typeof StateCorruptionLocationSchema>;

export const StateCorruptionSchema = z.object({
  document: StateDocumentKindSchema,
  scope: ScopeReferenceSchema,
  code: StateCorruptionCodeSchema,
  recordIdentity: StateRecordIdentitySchema.optional(),
  location: StateCorruptionLocationSchema.optional(),
  summary: StateCorruptionSummarySchema,
}).strict().readonly();
export type StateCorruption = z.infer<typeof StateCorruptionSchema>;

export type StateCodecContext = Readonly<{
  scope: ScopeContext;
  generation: Generation;
  sha256: Sha256;
  /** When present, verify the exact logical blob digest selected by a pointer. */
  expectedDigest?: ContentDigest;
}>;

export type DecodedDocument<T> = Readonly<{
  value: T;
  corruptions: readonly StateCorruption[];
}>;

/** Fatal enclosing-document failures never expose a partial value. */
export class StateCodecError extends Error {
  readonly corruption: StateCorruption;

  constructor(corruption: StateCorruption) {
    const safe = StateCorruptionSchema.parse(corruption);
    super(safe.summary);
    this.name = "StateCodecError";
    this.corruption = safe;
  }
}

/**
 * Raised when the pointers index carries a stale or unknown schema version. A
 * pointer document indexes every other blob, so it has no meaningful empty
 * default of its own: the clean cut-over reinitializes the whole scope, which
 * the state store performs. This is deliberately not a StateCodecError — a
 * version cut-over is reinitialization, not corruption.
 */
export class StateVersionCutoverError extends Error {
  readonly document: StateDocumentKind;
  readonly foundVersion: number;
  readonly currentVersion: number;

  constructor(document: StateDocumentKind, foundVersion: number, currentVersion: number) {
    super(`state document version ${foundVersion} is cut over to current version ${currentVersion}`);
    this.name = "StateVersionCutoverError";
    this.document = document;
    this.foundVersion = foundVersion;
    this.currentVersion = currentVersion;
  }
}

function assertSha256(sha256: Sha256): void {
  if (typeof sha256 !== "function") throw new TypeError("state codec requires a SHA-256 function");
}

function assertContext(context: StateCodecContext): {
  readonly scope: ScopeContext;
  readonly scopeReference: ScopeReference;
  readonly generation: StateCodecContext["generation"];
  readonly sha256: Sha256;
} {
  assertSha256(context.sha256);
  const scope = createScopeContext(ScopeContextSchema.parse(context.scope), context.sha256);
  const generation = GenerationSchema.parse(context.generation);
  return {
    scope,
    scopeReference: toScopeReference(scope),
    generation,
    sha256: context.sha256,
  };
}

function summaryFor(code: StateCorruptionCode): StateCorruptionSummary {
  const definition = corruptionDefinitions.find((candidate) => candidate.code === code);
  if (definition === undefined) throw new Error("unregistered state corruption code");
  return StateCorruptionSummarySchema.parse(definition.summary);
}

function corruption(
  document: StateDocumentKind,
  scope: ScopeReference,
  code: StateCorruptionCode,
  options: Readonly<{ recordIdentity?: string; location?: StateCorruptionLocation }> = {},
): StateCorruption {
  return StateCorruptionSchema.parse({
    document,
    scope,
    code,
    ...(options.recordIdentity === undefined ? {} : { recordIdentity: options.recordIdentity }),
    ...(options.location === undefined ? {} : { location: options.location }),
    summary: summaryFor(code),
  });
}

function fatal(
  document: StateDocumentKind,
  scope: ScopeReference,
  code: StateCorruptionCode,
  options?: Readonly<{ recordIdentity?: string; location?: StateCorruptionLocation }>,
): never {
  throw new StateCodecError(corruption(document, scope, code, options));
}

function recordPointer(field: StateCorruptionFieldId, index: number): StateCorruptionLocation {
  return { kind: "pointer", value: StateCorruptionPointerSchema.parse(`/${field}/${index}`) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readVersion(input: unknown): number | undefined {
  if (!isRecord(input)) return undefined;
  const result = StateDocumentVersionFieldSchema.safeParse(input.schemaVersion);
  return result.success ? result.data : undefined;
}

function sameScope(left: ScopeReference, right: ScopeReference): boolean {
  if (left.kind === "user") return right.kind === "user";
  return right.kind === "project" && left.projectKey === right.projectKey;
}

function sameJson(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (left === null || right === null || typeof left !== "object" || typeof right !== "object") return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length &&
      left.every((entry, index) => sameJson(entry, right[index]));
  }
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord);
  const rightKeys = Object.keys(rightRecord);
  return leftKeys.length === rightKeys.length &&
    leftKeys.every((key) => Object.prototype.hasOwnProperty.call(rightRecord, key) && sameJson(leftRecord[key], rightRecord[key]));
}

/** Record-tolerant roots let the codec quarantine individual bad children. */
const rootSchemas: { readonly [K in StateDocumentKind]: z.ZodTypeAny } = {
  hostConfig: z.object({ schemaVersion: z.literal(4), generation: GenerationSchema, global: z.unknown(), scope: z.unknown(), records: z.array(z.unknown()) }).strict(),
  installedUser: z.object({ schemaVersion: z.literal(2), generation: GenerationSchema, marketplaces: z.array(z.unknown()), plugins: z.array(z.unknown()) }).strict(),
  trust: z.object({ schemaVersion: z.literal(1), generation: GenerationSchema, records: z.array(z.unknown()) }).strict(),
  projectLocal: z.object({ schemaVersion: z.literal(4), generation: GenerationSchema, projectKey: z.string(), identity: z.unknown(), declarationDigest: z.string(), scope: z.unknown(), marketplaces: z.array(z.unknown()), plugins: z.array(z.unknown()), marketplaceUpdates: z.array(z.unknown()) }).strict(),
  portableProject: z.object({ schemaVersion: z.literal(1), marketplaces: z.array(z.unknown()), plugins: z.array(z.unknown()) }).strict(),
  pointers: z.object({ schemaVersion: z.literal(1), scope: z.unknown(), generation: GenerationSchema, previousGeneration: GenerationSchema.optional(), documents: z.array(z.unknown()) }).strict(),
};

function parseRoot<K extends StateDocumentKind>(
  kind: K,
  input: unknown,
  scope: ScopeReference,
): Record<string, unknown> {
  const parsed = rootSchemas[kind].safeParse(input);
  if (!parsed.success || !isRecord(parsed.data)) {
    fatal(kind, scope, "DOCUMENT_INVALID");
  }
  return parsed.data;
}

/**
 * Clean cut-over: a document at a stale or unknown (but readable) schema
 * version is reinitialized to the kind's empty default for the requested
 * context — never migrated and never reported as corruption. The fresh root
 * carries the context generation so the enclosing snapshot stays coherent.
 */
function cutoverDocumentRoot(
  kind: Exclude<StateDocumentKind, "pointers">,
  context: ReturnType<typeof assertContext>,
): Record<string, unknown> {
  const generation = context.generation;
  // The registry owns the current version; defaults only shape the empty doc.
  const schemaVersion = getStateDocumentDefinition(kind).schemaVersion;
  switch (kind) {
    case "hostConfig":
      return {
        schemaVersion,
        generation,
        global: { application: "manual", cadence: "balanced" },
        scope: {},
        records: [],
      };
    case "installedUser":
      return { schemaVersion, generation, marketplaces: [], plugins: [] };
    case "trust":
      return { schemaVersion, generation, records: [] };
    case "projectLocal": {
      // A project cut-over keeps the scope's verified identity evidence and
      // marks the declaration digest as never synchronized. Enclosing-context
      // validation still rejects a mismatched user-scope decode below.
      const scope = context.scope;
      return {
        schemaVersion,
        generation,
        projectKey: scope.kind === "project" ? scope.projectKey : "",
        identity: scope.kind === "project" ? scope.identity : {},
        declarationDigest: hashContent(
          new TextEncoder().encode(UNSYNCHRONIZED_PORTABLE_INTENT),
          context.sha256,
        ),
        scope: {},
        marketplaces: [],
        plugins: [],
        marketplaceUpdates: [],
      };
    }
    case "portableProject":
      return { schemaVersion, marketplaces: [], plugins: [] };
  }
}

function validateEnclosingContext(
  kind: StateDocumentKind,
  root: Record<string, unknown>,
  context: ReturnType<typeof assertContext>,
): void {
  if (kind === "portableProject") return;

  if (kind === "pointers") {
    const pointerScope = root.scope;
    const scopeResult = ScopeReferenceSchema.safeParse(pointerScope);
    if (!scopeResult.success || !sameScope(scopeResult.data, context.scopeReference)) {
      fatal(kind, context.scopeReference, "SCOPE_MISMATCH");
    }
  }

  if (root.generation !== context.generation) {
    fatal(kind, context.scopeReference, "GENERATION_MISMATCH");
  }

  if (kind === "hostConfig" || kind === "installedUser" || kind === "trust") {
    if (context.scope.kind !== "user") fatal(kind, context.scopeReference, "SCOPE_MISMATCH");
  }

  if (kind === "projectLocal") {
    if (context.scope.kind !== "project") fatal(kind, context.scopeReference, "SCOPE_MISMATCH");
    if (root.projectKey !== context.scope.projectKey || !sameJson(root.identity, context.scope.identity)) {
      fatal(kind, context.scopeReference, "SCOPE_MISMATCH");
    }
  }
}

function candidateKey(
  kind: StateDocumentKind,
  candidate: unknown,
): string | undefined {
  if (!isRecord(candidate)) return undefined;
  if (kind === "hostConfig") {
    const value = candidate.marketplace;
    return typeof value === "string" && MarketplaceNameSchema.safeParse(value).success ? value : undefined;
  }
  if (kind === "trust") {
    const value = candidate.subject;
    return typeof value === "string" && TrustSubjectRefSchema.safeParse(value).success ? value : undefined;
  }
  const value = candidate.plugin;
  return typeof value === "string" && PluginKeySchema.safeParse(value).success ? value : undefined;
}

function decodeRecords<T>(
  kind: StateDocumentKind,
  input: unknown,
  scope: ScopeReference,
  decode: (candidate: unknown) => T,
  keyOf: (candidate: unknown) => string | undefined = (candidate) => candidateKey(kind, candidate),
  field: StateCorruptionFieldId = kind === "hostConfig" || kind === "trust" ? "records" : "plugins",
): { readonly records: readonly T[]; readonly corruptions: readonly StateCorruption[] } {
  if (!Array.isArray(input)) fatal(kind, scope, "DOCUMENT_INVALID");
  const occurrences = new Map<string, number>();
  for (const candidate of input) {
    const key = keyOf(candidate);
    if (key !== undefined) occurrences.set(key, (occurrences.get(key) ?? 0) + 1);
  }

  const records: T[] = [];
  const corruptions: StateCorruption[] = [];
  for (const [index, candidate] of input.entries()) {
    const key = keyOf(candidate);
    if (key === undefined) {
      fatal(kind, scope, "DOCUMENT_INVALID", { location: recordPointer(field, index) });
    }
    if (occurrences.get(key)! > 1) {
      corruptions.push(corruption(kind, scope, "RECORD_DUPLICATE", { recordIdentity: key, location: recordPointer(field, index) }));
      continue;
    }
    try {
      records.push(decode(candidate));
    } catch {
      corruptions.push(corruption(kind, scope, "RECORD_INVALID", { recordIdentity: key, location: recordPointer(field, index) }));
    }
  }
  return { records, corruptions };
}

function marketplaceCandidateKey(candidate: unknown): string | undefined {
  if (!isRecord(candidate)) return undefined;
  const value = candidate.marketplace;
  return typeof value === "string" && MarketplaceNameSchema.safeParse(value).success ? value : undefined;
}

function decodeProjectMarketplaceRegistrations(
  input: unknown,
  snapshots: readonly { readonly marketplace: string }[],
  scope: ScopeReference,
): { readonly records: readonly MarketplaceRegistrationRecord[]; readonly corruptions: readonly StateCorruption[] } {
  if (!Array.isArray(input)) fatal("projectLocal", scope, "DOCUMENT_INVALID", { location: { kind: "field", id: "marketplaceUpdates" } });
  const snapshotNames = new Set(snapshots.map((snapshot) => snapshot.marketplace));
  const parsed: Array<{ index: number; name: string; source: string; record: MarketplaceRegistrationRecord }> = [];
  const corruptions: StateCorruption[] = [];
  for (const [index, candidate] of input.entries()) {
    const name = marketplaceCandidateKey(candidate);
    try {
      const record = MarketplaceRegistrationRecordSchema.parse(candidate);
      if (record.source.kind === "local-git" || !snapshotNames.has(record.marketplace)) throw new Error("project registration is not authoritative");
      parsed.push({ index, name: record.marketplace, source: serializeMarketplaceSource(record.source), record });
    } catch {
      corruptions.push(corruption("projectLocal", scope, "RECORD_INVALID", {
        ...(name === undefined ? {} : { recordIdentity: name }),
        location: recordPointer("marketplaceUpdates", index),
      }));
    }
  }
  const nameCounts = new Map<string, number>();
  const sourceCounts = new Map<string, number>();
  for (const candidate of parsed) {
    nameCounts.set(candidate.name, (nameCounts.get(candidate.name) ?? 0) + 1);
    sourceCounts.set(candidate.source, (sourceCounts.get(candidate.source) ?? 0) + 1);
  }
  const records: MarketplaceRegistrationRecord[] = [];
  for (const candidate of parsed) {
    if (nameCounts.get(candidate.name)! > 1 || sourceCounts.get(candidate.source)! > 1) {
      corruptions.push(corruption("projectLocal", scope, "RECORD_DUPLICATE", {
        recordIdentity: candidate.name,
        location: recordPointer("marketplaceUpdates", candidate.index),
      }));
    } else {
      records.push(candidate.record);
    }
  }
  return { records, corruptions: corruptions.sort((left, right) => {
    const a = left.location?.kind === "pointer" ? Number(left.location.value.split("/").at(-1)) : -1;
    const b = right.location?.kind === "pointer" ? Number(right.location.value.split("/").at(-1)) : -1;
    return a - b;
  }) };
}

function decodeInstalledCollection(
  kind: "installedUser" | "projectLocal",
  input: unknown,
  scope: ScopeReference,
  sha256: Sha256,
): { readonly records: readonly InstalledPluginRecord[]; readonly corruptions: readonly StateCorruption[] } {
  return decodeRecords(kind, input, scope, (candidate) => {
    if (!isRecord(candidate)) throw new Error("record is not an object");
    return createInstalledPluginRecord({ ...candidate, scope }, sha256);
  });
}

function filterDependentInstalledRecords(
  kind: "installedUser" | "projectLocal",
  records: readonly InstalledPluginRecord[],
  marketplaces: readonly { readonly marketplace: string; readonly source: { readonly revision: string } }[],
  scope: ScopeReference,
  corruptions: readonly StateCorruption[],
): { readonly records: readonly InstalledPluginRecord[]; readonly corruptions: readonly StateCorruption[] } {
  const snapshots = new Set(marketplaces.map((record) => record.marketplace));
  const kept: InstalledPluginRecord[] = [];
  const nextCorruptions = [...corruptions];
  for (const record of records) {
    const marketplace = record.plugin.slice(record.plugin.lastIndexOf("@") + 1);
    const invalid = !snapshots.has(marketplace);
    if (invalid) {
      nextCorruptions.push(corruption(kind, scope, "RECORD_INVALID", { recordIdentity: record.plugin, location: { kind: "field", id: "plugins" } }));
    } else {
      kept.push(record);
    }
  }
  return { records: kept, corruptions: nextCorruptions };
}

function decodeDocument<K extends StateDocumentKind>(
  kind: K,
  root: Record<string, unknown>,
  context: ReturnType<typeof assertContext>,
): DecodedDocument<StateDocumentFor<K>> {
  const scope = context.scopeReference;
  const sha256 = context.sha256;

  if (kind === "pointers") {
    return { value: StatePointersDocumentSchema.parse(root) as StateDocumentFor<K>, corruptions: [] };
  }
  if (kind === "portableProject") {
    return { value: PortableProjectDeclarationSchema.parse(root) as StateDocumentFor<K>, corruptions: [] };
  }
  if (kind === "hostConfig") {
    const decoded = decodeRecords(kind, root.records, scope, (candidate) => MarketplaceConfigurationRecordSchema.parse(candidate));
    const value = HostConfigDocumentSchema.parse({ ...root, records: decoded.records });
    return { value: value as StateDocumentFor<K>, corruptions: decoded.corruptions };
  }
  if (kind === "trust") {
    const decoded = decodeRecords(kind, root.records, scope, (candidate) => createTrustStateRecord(candidate, sha256));
    const value = TrustStateDocumentSchema.parse({ ...root, records: decoded.records });
    return { value: value as StateDocumentFor<K>, corruptions: decoded.corruptions };
  }

  const marketplaces = decodeRecords(kind, root.marketplaces, scope, (candidate) => createMarketplaceSnapshotRecord(candidate, sha256), marketplaceCandidateKey, "marketplaces");
  const installed = decodeInstalledCollection(kind, root.plugins, scope, sha256);
  const collectionCorruptions = [...marketplaces.corruptions, ...installed.corruptions];
  if (kind === "installedUser") {
    const filtered = filterDependentInstalledRecords(kind, installed.records, marketplaces.records, scope, collectionCorruptions);
    const value = InstalledUserStateDocumentSchema.parse({ ...root, marketplaces: marketplaces.records, plugins: filtered.records });
    return { value: value as StateDocumentFor<K>, corruptions: filtered.corruptions };
  }
  // Project plugins resolve through the host-global marketplace registry;
  // only retained project registrations require local snapshot coverage.
  const registrations = decodeProjectMarketplaceRegistrations(root.marketplaceUpdates ?? [], marketplaces.records, scope);
  const value = ProjectLocalStateDocumentSchema.parse({ ...root, marketplaces: marketplaces.records, plugins: installed.records, marketplaceUpdates: registrations.records });
  return { value: value as StateDocumentFor<K>, corruptions: [...collectionCorruptions, ...registrations.corruptions] };
}

function canonicalStringCompare(left: string, right: string): number {
  const encoder = new TextEncoder();
  const a = encoder.encode(left);
  const b = encoder.encode(right);
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return a.length - b.length;
}

function canonicalizeJsonValue(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(canonicalizeJsonValue);
  if (value !== null && typeof value === "object") {
    const record = value as { readonly [key: string]: JsonValue };
    const sorted: Record<string, JsonValue> = {};
    for (const key of Object.keys(record).sort(canonicalStringCompare)) {
      sorted[key] = canonicalizeJsonValue(record[key]!);
    }
    return sorted;
  }
  return value;
}

function sortByKey<T>(values: readonly T[], key: (value: T) => string): T[] {
  return [...values].sort((left, right) => canonicalStringCompare(key(left), key(right)));
}

function deterministicDocument(kind: StateDocumentKind, input: JsonValue): JsonValue {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return input;
  const document = { ...(input as Record<string, JsonValue>) };
  if (kind === "hostConfig" && Array.isArray(document.records)) {
    document.records = sortByKey(document.records, (value) => String((value as Record<string, JsonValue>).marketplace));
  }
  if (kind === "trust" && Array.isArray(document.records)) {
    document.records = sortByKey(document.records, (value) => String((value as Record<string, JsonValue>).subject));
  }
  if (kind === "installedUser" || kind === "projectLocal") {
    if (Array.isArray(document.marketplaces)) {
      document.marketplaces = sortByKey(document.marketplaces, (value) => String((value as Record<string, JsonValue>).marketplace));
    }
    if (Array.isArray(document.marketplaceUpdates)) {
      document.marketplaceUpdates = sortByKey(document.marketplaceUpdates, (value) => String((value as Record<string, JsonValue>).marketplace));
    }
    if (Array.isArray(document.plugins)) {
      document.plugins = sortByKey(document.plugins, (value) => String((value as Record<string, JsonValue>).plugin)).map((value) => {
        if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
        const plugin = { ...(value as Record<string, JsonValue>) };
        if (Array.isArray(plugin.revisions)) {
          plugin.revisions = sortByKey(plugin.revisions, (revision) => String((revision as Record<string, JsonValue>).revision));
        }
        return plugin;
      });
    }
  }
  if (kind === "portableProject") {
    if (Array.isArray(document.marketplaces)) {
      document.marketplaces = sortByKey(document.marketplaces, (value) => String((value as Record<string, JsonValue>).marketplace));
    }
    if (Array.isArray(document.plugins)) {
      document.plugins = sortByKey(document.plugins, (value) => String((value as Record<string, JsonValue>).plugin));
    }
  }
  if (kind === "pointers" && Array.isArray(document.documents)) {
    document.documents = sortByKey(document.documents, (value) => String((value as Record<string, JsonValue>).kind));
  }
  return canonicalizeJsonValue(document);
}

function validateForEncoding<K extends StateDocumentKind>(
  kind: K,
  input: StateDocumentFor<K>,
  context: ReturnType<typeof assertContext>,
): StateDocumentFor<K> {
  if (kind !== "portableProject" && isRecord(input) && "generation" in input && input.generation !== context.generation) {
    throw new Error("state document generation does not match the requested generation");
  }
  if (kind === "hostConfig") {
    return HostConfigDocumentSchema.parse(input) as StateDocumentFor<K>;
  }
  if (kind === "trust") {
    const value = TrustStateDocumentSchema.parse(input);
    const records = value.records.map((record) => createTrustStateRecord(record, context.sha256));
    return TrustStateDocumentSchema.parse({ ...value, records }) as StateDocumentFor<K>;
  }
  if (kind === "installedUser") {
    if (context.scope.kind !== "user") throw new Error("installed user state requires user scope");
    const value = InstalledUserStateDocumentSchema.parse(input);
    return InstalledUserStateDocumentSchema.parse({
      ...value,
      marketplaces: value.marketplaces.map((record) => createMarketplaceSnapshotRecord(record, context.sha256)),
      plugins: value.plugins.map((record) => createInstalledPluginRecord({ ...record, scope: context.scopeReference }, context.sha256)),
    }) as StateDocumentFor<K>;
  }
  if (kind === "projectLocal") {
    if (context.scope.kind !== "project") throw new Error("project-local state requires project scope");
    return createProjectLocalStateDocument(input, context.scope, context.sha256) as StateDocumentFor<K>;
  }
  if (kind === "portableProject") return PortableProjectDeclarationSchema.parse(input) as StateDocumentFor<K>;
  const pointers = StatePointersDocumentSchema.parse(input);
  if (!sameScope(pointers.scope, context.scopeReference) || pointers.generation !== context.generation) {
    throw new Error("state pointer scope or generation does not match the requested context");
  }
  return pointers as StateDocumentFor<K>;
}

function jsonBytes(value: JsonValue): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(canonicalizeJsonValue(value)));
}

/** Hash the canonical JSON representation used by pointer digests. */
export function hashStateDocument(input: JsonValue, sha256: Sha256): ContentDigest {
  assertSha256(sha256);
  return hashContent(jsonBytes(input), sha256);
}

/** Verify the raw canonical document before any normalization or record isolation. */
function verifyRawDigest(
  kind: StateDocumentKind,
  input: unknown,
  scope: ScopeReference,
  expectedDigest: ContentDigest | undefined,
  sha256: Sha256,
): void {
  if (expectedDigest === undefined) return;
  const raw = JsonValueSchema.safeParse(input);
  const expected = ContentDigestSchema.safeParse(expectedDigest);
  if (!raw.success || !expected.success) {
    fatal(kind, scope, "DIGEST_MISMATCH", { location: { kind: "field", id: "digest" } });
  }
  const actual = hashStateDocument(raw.data, sha256);
  if (actual !== expected.data) {
    fatal(kind, scope, "DIGEST_MISMATCH", { location: { kind: "field", id: "digest" } });
  }
}

export function decodeStateDocument<K extends StateDocumentKind>(
  kind: K,
  input: unknown,
  context: StateCodecContext,
): DecodedDocument<StateDocumentFor<K>> {
  const parsedKind = StateDocumentKindSchema.parse(kind) as K;
  const parsedContext = assertContext(context);
  verifyRawDigest(parsedKind, input, parsedContext.scopeReference, context.expectedDigest, parsedContext.sha256);
  const definition = getStateDocumentDefinition(parsedKind);
  const version = readVersion(input);
  if (version === undefined) {
    fatal(parsedKind, parsedContext.scopeReference, "DOCUMENT_INVALID");
  }
  let root: Record<string, unknown>;
  if (version !== definition.schemaVersion) {
    // Clean cut-over: stale or unknown versions reinitialize to the empty
    // default. Only the pointers index cannot reinitialize a single document,
    // because it names every other blob in the generation.
    if (parsedKind === "pointers") {
      throw new StateVersionCutoverError(parsedKind, version, definition.schemaVersion);
    }
    root = cutoverDocumentRoot(parsedKind, parsedContext);
  } else {
    root = parseRoot(parsedKind, input, parsedContext.scopeReference);
  }
  validateEnclosingContext(parsedKind, root, parsedContext);
  let decoded: DecodedDocument<StateDocumentFor<K>>;
  try {
    decoded = decodeDocument(parsedKind, root, parsedContext);
  } catch (error) {
    if (error instanceof StateCodecError) throw error;
    fatal(parsedKind, parsedContext.scopeReference, "DOCUMENT_INVALID");
  }
  return decoded;
}

export function encodeStateDocument<K extends StateDocumentKind>(
  kind: K,
  input: StateDocumentFor<K>,
  context: StateCodecContext,
): JsonValue {
  const parsedKind = StateDocumentKindSchema.parse(kind) as K;
  const parsedContext = assertContext(context);
  const value = validateForEncoding(parsedKind, input, parsedContext);
  const json = JsonValueSchema.parse(value) as JsonValue;
  return deterministicDocument(parsedKind, json);
}

export type {
  ContentDigest,
  StateDocumentByKind,
  StateDocumentFor,
  StateDocumentKind,
  TrustStateRecord,
};
