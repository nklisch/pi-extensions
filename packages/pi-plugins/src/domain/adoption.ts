import { z } from "zod";
import {
  MarketplaceNameSchema,
  type MarketplaceName,
} from "./identity.js";
import {
  MarketplaceSourceSchema,
  serializeMarketplaceSource,
  hashCanonicalSource,
  type MarketplaceSource,
  type Sha256,
} from "./source.js";
import {
  ClaimedSchema,
  NativeHostSchema,
  SourceDocumentKindSchema,
  type Claimed,
  type NativeHost,
  type Provenance,
} from "./provenance.js";
import { CollectionReadResultSchema, type CollectionReadResult } from "./errors.js";
import { nonEmptyReadonly } from "./schema.js";

/** Supported foreign documents are one registry, so readers and applications
 * cannot silently grow different host/document vocabularies. */
export const AdoptionDocumentKindRegistry = {
  claudeKnownMarketplaces: { tag: "claude-known-marketplaces", host: "claude" },
  claudeUserSettings: { tag: "claude-user-settings", host: "claude" },
  codexUserConfig: { tag: "codex-user-config", host: "codex" },
} as const;

export type AdoptionDocumentKind = (typeof AdoptionDocumentKindRegistry)[keyof typeof AdoptionDocumentKindRegistry]["tag"];
const adoptionDocumentKinds = Object.values(AdoptionDocumentKindRegistry).map((entry) => entry.tag) as [
  AdoptionDocumentKind,
  ...AdoptionDocumentKind[],
];
export const AdoptionDocumentKindSchema = z.enum(adoptionDocumentKinds);

export const AdoptionCandidateIdSchema = z
  .string()
  .regex(/^adoption-v1:sha256:[0-9a-f]{64}$/)
  .brand<"AdoptionCandidateId">();
export type AdoptionCandidateId = z.infer<typeof AdoptionCandidateIdSchema>;

export const AdoptionDeclarationSchema = z
  .object({
    host: NativeHostSchema,
    document: AdoptionDocumentKindSchema,
    suggestedMarketplace: ClaimedSchema(MarketplaceNameSchema),
    source: ClaimedSchema(MarketplaceSourceSchema),
  })
  .strict()
  .readonly();
export type AdoptionDeclaration = z.infer<typeof AdoptionDeclarationSchema>;

export const AdoptionCandidateSchema = z
  .object({
    id: AdoptionCandidateIdSchema,
    source: ClaimedSchema(MarketplaceSourceSchema),
    suggestedMarketplaces: z
      .array(ClaimedSchema(MarketplaceNameSchema))
      .nonempty()
      .readonly(),
    nativeHosts: z.array(NativeHostSchema).nonempty().readonly(),
  })
  .strict()
  .readonly();
export type AdoptionCandidate = z.infer<typeof AdoptionCandidateSchema>;

/** Candidate identity is bound to canonical source bytes, never to a foreign
 * alias or to the order in which documents happened to be read. */
export function deriveAdoptionCandidateId(
  source: MarketplaceSource,
  sha256: Sha256,
): AdoptionCandidateId {
  const digest = hashCanonicalSource(serializeMarketplaceSource(source), sha256);
  return AdoptionCandidateIdSchema.parse(`adoption-v1:${digest}`);
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
}

function locationKey(location: Claimed<unknown>["provenance"][number]["location"]): string {
  return stableJson([
    location.host,
    location.documentKind,
    location.path,
    location.pointer ?? null,
    location.line ?? null,
    location.column ?? null,
  ]);
}

function sourceDeclarationKey(declaration: AdoptionDeclaration): string {
  const location = declaration.source.provenance[0]?.location;
  return `${location === undefined ? "" : locationKey(location)}\u0000${stableJson(declaration.source.provenance[0]?.declaration)}`;
}

function declarationLocationKey(declaration: AdoptionDeclaration): string {
  const location = declaration.source.provenance[0]?.location;
  return `${declaration.host}\u0000${declaration.document}\u0000${location === undefined ? "" : location.path}\u0000${declaration.suggestedMarketplace.value}`;
}

function diagnosticForConflict(
  left: AdoptionDeclaration,
  right: AdoptionDeclaration,
): import("./error-contract.js").Diagnostic {
  const leftLocation = left.source.provenance[0]?.location;
  const rightLocation = right.source.provenance[0]?.location;
  return {
    code: "CLAIM_CONFLICT",
    severity: "error",
    operation: "reconcileAdoptionDeclarations",
    message: "Conflicting marketplace sources were declared at one foreign-state location",
    ...(leftLocation === undefined ? {} : { location: leftLocation }),
    details: {
      field: "source",
      locations: [
        ...(leftLocation === undefined ? [] : [leftLocation]),
        ...(rightLocation === undefined ? [] : [rightLocation]),
      ],
    } as unknown as import("./schema.js").JsonValue,
  };
}

type ClaimLike<T> = Readonly<{
  value: T;
  provenance: readonly Provenance[];
}>;

function mergeClaims<T>(
  claims: readonly ClaimLike<T>[],
): ClaimLike<T> {
  const ordered = [...claims].sort((left, right) => {
    const leftKey = `${locationKey(left.provenance[0]!.location)}\u0000${stableJson(left.provenance[0]!.declaration)}\u0000${stableJson(left.value)}`;
    const rightKey = `${locationKey(right.provenance[0]!.location)}\u0000${stableJson(right.provenance[0]!.declaration)}\u0000${stableJson(right.value)}`;
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
  });
  const provenance = ordered.flatMap((claim) => claim.provenance).sort((left, right) => {
    const leftKey = `${locationKey(left.location)}\u0000${stableJson(left.declaration)}`;
    const rightKey = `${locationKey(right.location)}\u0000${stableJson(right.declaration)}`;
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
  });
  const unique = provenance.filter((candidate, index) => provenance.findIndex((entry) =>
    locationKey(entry.location) === locationKey(candidate.location) &&
    stableJson(entry.declaration) === stableJson(candidate.declaration)
  ) === index);
  return {
    value: ordered[0]!.value,
    provenance: nonEmptyReadonly(unique) as readonly [Provenance, ...Provenance[]],
  };
}

/** Reconcile already validated declarations. It has no filesystem or source
 * resolution behavior; unsupported declarations have already been diagnosed
 * by their host reader and cannot enter this function. */
export function reconcileAdoptionDeclarations(
  declarations: readonly AdoptionDeclaration[],
  sha256: Sha256,
): CollectionReadResult<AdoptionCandidate> {
  const valid = declarations.map((declaration) => AdoptionDeclarationSchema.parse(declaration));
  const diagnostics: import("./error-contract.js").Diagnostic[] = [];
  const conflicts = new Set<number>();
  const locations = new Map<string, { index: number; declaration: AdoptionDeclaration }[]>();

  for (const [index, declaration] of valid.entries()) {
    const key = declarationLocationKey(declaration);
    const group = locations.get(key);
    if (group === undefined) locations.set(key, [{ index, declaration }]);
    else group.push({ index, declaration });
  }
  for (const group of locations.values()) {
    const canonicalSources = new Set(group.map((entry) => serializeMarketplaceSource(entry.declaration.source.value)));
    if (canonicalSources.size <= 1) continue;
    for (const entry of group) conflicts.add(entry.index);
    const ordered = [...group].sort((left, right) => left.index - right.index);
    const first = ordered[0];
    const second = ordered.find((entry) =>
      serializeMarketplaceSource(entry.declaration.source.value) !== serializeMarketplaceSource(first!.declaration.source.value),
    );
    if (first !== undefined && second !== undefined) {
      diagnostics.push(diagnosticForConflict(first.declaration, second.declaration));
    }
  }

  const survivors = valid.filter((_declaration, index) => !conflicts.has(index));
  const groups = new Map<string, AdoptionDeclaration[]>();
  for (const declaration of survivors) {
    const key = serializeMarketplaceSource(declaration.source.value);
    const group = groups.get(key);
    if (group === undefined) groups.set(key, [declaration]);
    else group.push(declaration);
  }

  const candidates = [...groups.entries()].map(([, group]) => {
    const ordered = [...group].sort((left, right) => {
      const leftKey = sourceDeclarationKey(left);
      const rightKey = sourceDeclarationKey(right);
      return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
    });
    const source = mergeClaims(ordered.map((entry) => entry.source));
    const aliases = new Map<string, ClaimLike<MarketplaceName>[]>();
    for (const declaration of ordered) {
      const aliasClaims = aliases.get(declaration.suggestedMarketplace.value);
      if (aliasClaims === undefined) aliases.set(declaration.suggestedMarketplace.value, [declaration.suggestedMarketplace]);
      else aliasClaims.push(declaration.suggestedMarketplace);
    }
    const suggestedMarketplaces = [...aliases.entries()]
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([, claims]) => mergeClaims(claims));
    const nativeHosts = [...new Set(ordered.map((entry) => entry.host))].sort() as [NativeHost, ...NativeHost[]];
    return AdoptionCandidateSchema.parse({
      id: deriveAdoptionCandidateId(source.value, sha256),
      source,
      suggestedMarketplaces,
      nativeHosts,
    });
  }).sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);

  return CollectionReadResultSchema(AdoptionCandidateSchema).parse({ items: candidates, diagnostics });
}

export type AdoptionDocumentHost = {
  readonly [K in AdoptionDocumentKind]: NativeHost;
};

export const adoptionDocumentHosts: AdoptionDocumentHost = Object.freeze(
  Object.fromEntries(Object.values(AdoptionDocumentKindRegistry).map((entry) => [entry.tag, entry.host])) as AdoptionDocumentHost,
);

export type { Claimed, MarketplaceName, MarketplaceSource, NativeHost };
export { SourceDocumentKindSchema };
