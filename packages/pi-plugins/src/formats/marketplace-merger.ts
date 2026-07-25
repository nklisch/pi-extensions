import {
  MarketplaceReadResultSchema,
  NormalizedMarketplaceEntrySchema,
  NormalizedMarketplaceSchema,
  type MarketplaceReadResult,
  type NormalizedMarketplaceEntry,
  type NormalizedMarketplace,
  type MarketplaceAuthority,
  type MarketplaceEntryDeclaration,
} from "../domain/marketplace.js";
import {
  BoundaryError,
  DomainContractError,
  DiagnosticSchema,
  ErrorCodeRegistry,
  type Diagnostic,
} from "../domain/errors.js";
import {
  MarketplaceNameSchema,
  type MarketplaceName,
  type PluginKey,
} from "../domain/identity.js";
import { serializePluginSource } from "../domain/source.js";
import {
  DEFAULT_HOST_PRECEDENCE,
  hostRank,
  type HostPrecedence,
} from "../domain/host-precedence.js";
import {
  NativeHostSchema,
  type Claimed,
  type NativeHost,
  type Provenance,
  type SourceLocation,
} from "../domain/provenance.js";
import { JsonValueSchema, type JsonValue } from "../domain/schema.js";
import { type RetainedMetadata } from "../domain/components.js";

const OPERATION = "mergeMarketplaces";
const ENTRY_OPERATION = "mergeMarketplaceEntries";
type HostOrder = Readonly<Record<NativeHost, number>>;
const DEFAULT_HOST_ORDER: HostOrder = { claude: 0, codex: 1 };

function hostOrderFor(precedence: HostPrecedence): HostOrder {
  return { claude: hostRank(precedence, "claude"), codex: hostRank(precedence, "codex") };
}

/** Optional reconciliation controls; the canonical default stays Claude-first. */
export type MarketplaceMergeOptions = Readonly<{
  hostPrecedence?: HostPrecedence;
}>;

export type MarketplaceCatalogInput = Readonly<{
  nativeHost: NativeHost;
  result: MarketplaceReadResult;
}>;

type ClaimLike<T> = Readonly<{
  value: T;
  provenance: readonly Provenance[];
}>;

/** A conflict is recoverable at catalog scope: only the overlapping entry is dropped. */
class MarketplaceClaimConflictError extends DomainContractError {
  constructor(input: Readonly<{
    field: string;
    plugin: string;
    location: SourceLocation;
    left: unknown;
    right: unknown;
  }>) {
    super({
      code: ErrorCodeRegistry.claimConflict,
      operation: ENTRY_OPERATION,
      message: `Conflicting marketplace entry claim for ${input.field}`,
      location: input.location,
      plugin: input.plugin as PluginKey,
      details: {
        field: input.field,
        left: claimSnapshot(input.left),
        right: claimSnapshot(input.right),
      },
    });
    this.name = "MarketplaceClaimConflictError";
  }
}

function isClaimed(value: unknown): value is ClaimLike<unknown> {
  return value !== null && typeof value === "object" &&
    "value" in value && "provenance" in value && Array.isArray(value.provenance);
}

function claimSnapshot(value: unknown): JsonValue {
  if (isClaimed(value)) {
    return {
      value: JsonValueSchema.parse(value.value),
      provenance: value.provenance as unknown as JsonValue,
    };
  }
  return JsonValueSchema.parse(value);
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJson(item)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) =>
    `${JSON.stringify(key)}:${stableJson(record[key])}`,
  ).join(",")}}`;
}

function locationKey(location: SourceLocation, order: HostOrder): string {
  // Encode optional fields explicitly. In particular, an omitted pointer is
  // not the same location as the RFC 6901 root ("") or an empty-property
  // pointer ("/"). JSON array encoding keeps the key injective even when a
  // path or pointer contains the old delimiter character. The host is encoded
  // as its precedence rank (a bijection over the two hosts), so canonical
  // ordering follows the configured precedence rather than the host name.
  return stableJson([
    order[location.host],
    location.documentKind,
    location.path,
    location.pointer === undefined ? null : location.pointer,
    location.line === undefined ? null : location.line,
    location.column === undefined ? null : location.column,
  ]);
}

function provenanceKey(provenance: Provenance, order: HostOrder): string {
  return `${locationKey(provenance.location, order)}\u0000${stableJson(provenance.declaration)}`;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareProvenance(left: Provenance, right: Provenance, order: HostOrder): number {
  return compareText(provenanceKey(left, order), provenanceKey(right, order));
}

function firstProvenance<T>(claim: ClaimLike<T>, order: HostOrder): Provenance {
  return [...claim.provenance].sort((a, b) => compareProvenance(a, b, order))[0] as Provenance;
}

function mergeProvenance<T>(
  left: ClaimLike<T>,
  right: ClaimLike<T>,
  field: string,
  plugin: string,
  order: HostOrder,
): readonly [Provenance, ...Provenance[]] {
  const values = [...left.provenance, ...right.provenance];
  for (let leftIndex = 0; leftIndex < values.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < values.length; rightIndex += 1) {
      const first = values[leftIndex] as Provenance;
      const second = values[rightIndex] as Provenance;
      if (
        locationKey(first.location, order) === locationKey(second.location, order) &&
        stableJson(first.declaration) !== stableJson(second.declaration)
      ) {
        // A location identifies one foreign declaration. Keeping one raw
        // value here would make an otherwise valid merge unauditable, so the
        // entry-level merger reports a typed conflict instead.
        conflict(field, left, right, plugin, order);
      }
    }
  }

  const unique: Provenance[] = [];
  for (const candidate of values.sort((a, b) => compareProvenance(a, b, order))) {
    if (!unique.some((existing) =>
      locationKey(existing.location, order) === locationKey(candidate.location, order) &&
      stableJson(existing.declaration) === stableJson(candidate.declaration))) {
      unique.push(candidate);
    }
  }
  return unique as [Provenance, ...Provenance[]];
}

function compareClaims(left: ClaimLike<unknown>, right: ClaimLike<unknown>, order: HostOrder): number {
  const locationComparison = compareProvenance(firstProvenance(left, order), firstProvenance(right, order), order);
  if (locationComparison !== 0) {
    return locationComparison;
  }
  return compareText(stableJson(left.value), stableJson(right.value));
}

function orderedClaims<T>(left: ClaimLike<T>, right: ClaimLike<T>, order: HostOrder): readonly [ClaimLike<T>, ClaimLike<T>] {
  return compareClaims(left as ClaimLike<unknown>, right as ClaimLike<unknown>, order) <= 0
    ? [left, right]
    : [right, left];
}

function conflict(
  field: string,
  left: unknown,
  right: unknown,
  plugin: string,
  order: HostOrder,
): never {
  const leftClaim = isClaimed(left) ? left : undefined;
  const rightClaim = isClaimed(right) ? right : undefined;
  const location = leftClaim === undefined
    ? firstProvenance(rightClaim as ClaimLike<unknown>, order).location
    : firstProvenance(leftClaim, order).location;
  throw new MarketplaceClaimConflictError({
    field,
    plugin,
    location,
    left,
    right,
  });
}

function mergeClaim<T>(
  field: string,
  left: ClaimLike<T>,
  right: ClaimLike<T>,
  plugin: string,
  order: HostOrder,
  equals: (left: T, right: T) => boolean = (a, b) => stableJson(a) === stableJson(b),
): Claimed<T> {
  const [first, second] = orderedClaims(left, right, order);
  if (!equals(first.value, second.value)) {
    conflict(field, first, second, plugin, order);
  }
  return {
    value: first.value,
    provenance: mergeProvenance(first, second, field, plugin, order),
  };
}

/**
 * Presentational and advisory fields never conflict: the canonical host's
 * declaration wins and the other host's declaration survives only in merged
 * provenance. Real hosts apply the same precedence — Claude lets a
 * marketplace entry override plugin.json metadata, and Codex never merges
 * catalog metadata at all — so divergence between equivalent documents is
 * ordinary drift, not an integrity failure that justifies dropping the entry.
 */
function mergePresentationalClaim<T>(
  field: string,
  left: ClaimLike<T>,
  right: ClaimLike<T>,
  plugin: string,
  order: HostOrder,
): Claimed<T> {
  const [first, second] = orderedClaims(left, right, order);
  return {
    value: first.value,
    provenance: mergeProvenance(first, second, field, plugin, order),
  };
}

/** Keep both raw declarations while selecting the canonical host's normalized value. */
function mergeRawClaim<T>(
  field: string,
  left: ClaimLike<T>,
  right: ClaimLike<T>,
  plugin: string,
  order: HostOrder,
): Claimed<T> {
  const [first, second] = orderedClaims(left, right, order);
  return {
    value: first.value,
    provenance: mergeProvenance(first, second, field, plugin, order),
  };
}

function mergeOptionalClaim<T>(
  field: string,
  left: ClaimLike<T> | undefined,
  right: ClaimLike<T> | undefined,
  plugin: string,
  order: HostOrder,
  equals?: (left: T, right: T) => boolean,
): ClaimLike<T> | undefined {
  if (left === undefined) return right;
  if (right === undefined) return left;
  return mergeClaim(field, left, right, plugin, order, equals);
}

function mergeOptionalPresentational<T>(
  field: string,
  left: ClaimLike<T> | undefined,
  right: ClaimLike<T> | undefined,
  plugin: string,
  order: HostOrder,
): ClaimLike<T> | undefined {
  if (left === undefined) return right;
  if (right === undefined) return left;
  return mergePresentationalClaim(field, left, right, plugin, order);
}

function normalizePluginSource(
  claim: NormalizedMarketplaceEntry["source"],
): NormalizedMarketplaceEntry["source"] {
  if (claim.value.kind !== "git-subdir" || !claim.value.path.startsWith("./")) {
    return claim;
  }
  return {
    value: { ...claim.value, path: claim.value.path.slice(2) },
    provenance: claim.provenance,
  };
}

function mergePolicy(
  left: NonNullable<NormalizedMarketplaceEntry["policy"]>,
  right: NonNullable<NormalizedMarketplaceEntry["policy"]>,
  plugin: string,
  order: HostOrder,
): NonNullable<NormalizedMarketplaceEntry["policy"]> {
  // Availability and authentication timing are advisory at compatibility
  // time (the marketplace policy rules are metadata-only), so a cross-host
  // policy mismatch degrades to canonical precedence like other
  // presentational fields.
  const authentication = mergeOptionalPresentational(
    "policy.authentication",
    left.authentication,
    right.authentication,
    plugin,
    order,
  );
  return {
    availability: mergePresentationalClaim("policy.availability", left.availability, right.availability, plugin, order),
    ...(authentication === undefined ? {} : { authentication }),
    // The normalized policy claims above determine compatibility. The raw
    // declaration is retained from both hosts for auditability even when
    // equivalent host documents use different object shapes or key order.
    declaration: mergeRawClaim("policy.declaration", left.declaration, right.declaration, plugin, order),
  };
}

function mergeAuthority(
  left: MarketplaceAuthority,
  right: MarketplaceAuthority,
  plugin: string,
  order: HostOrder,
): MarketplaceAuthority {
  if (left.nativeHost !== right.nativeHost) {
    throw new TypeError("Cannot merge authorities from different native hosts");
  }
  const strict = mergeOptionalClaim("authority.strict", left.strict, right.strict, plugin, order);
  return {
    nativeHost: left.nativeHost,
    ...(strict === undefined ? {} : { strict }),
    manifest: mergeClaim("authority.manifest", left.manifest, right.manifest, plugin, order),
    catalogRuntime: mergeClaim("authority.catalogRuntime", left.catalogRuntime, right.catalogRuntime, plugin, order),
  };
}

function authorityOrder(authority: MarketplaceAuthority, order: HostOrder): string {
  const claim = authority.manifest;
  return `${String(order[authority.nativeHost]).padStart(2, "0")}\u0000${locationKey(firstProvenance(claim, order).location, order)}`;
}

function mergeAuthorities(
  left: readonly MarketplaceAuthority[],
  right: readonly MarketplaceAuthority[],
  plugin: string,
  order: HostOrder,
): readonly MarketplaceAuthority[] {
  const byHost = new Map<NativeHost, MarketplaceAuthority>();
  for (const authority of [...left, ...right]) {
    const existing = byHost.get(authority.nativeHost);
    byHost.set(
      authority.nativeHost,
      existing === undefined ? authority : mergeAuthority(existing, authority, plugin, order),
    );
  }
  return [...byHost.values()].sort((a, b) =>
    compareText(authorityOrder(a, order), authorityOrder(b, order)));
}

function declarationKey(declaration: MarketplaceEntryDeclaration): string {
  return `${declaration.nativeHost}\u0000${declaration.category}\u0000${declaration.field}`;
}

function declarationOrder(declaration: MarketplaceEntryDeclaration, order: HostOrder): string {
  return [
    String(order[declaration.nativeHost]).padStart(2, "0"),
    locationKey(firstProvenance(declaration.declaration, order).location, order),
    declaration.category,
    declaration.field,
  ].join("\u0000");
}

function mergeDeclarations(
  left: readonly MarketplaceEntryDeclaration[],
  right: readonly MarketplaceEntryDeclaration[],
  plugin: string,
  order: HostOrder,
): readonly MarketplaceEntryDeclaration[] {
  const byKey = new Map<string, MarketplaceEntryDeclaration>();
  for (const declaration of [...left, ...right]) {
    const key = declarationKey(declaration);
    const existing = byKey.get(key);
    if (existing === undefined) {
      byKey.set(key, declaration);
      continue;
    }
    byKey.set(key, {
      nativeHost: declaration.nativeHost,
      category: declaration.category,
      field: declaration.field,
      declaration: mergeClaim(
        `declaration.${declaration.nativeHost}.${declaration.field}`,
        existing.declaration,
        declaration.declaration,
        plugin,
        order,
      ),
    });
  }
  return [...byKey.values()].sort((a, b) => compareText(declarationOrder(a, order), declarationOrder(b, order)));
}

function metadataOrder(metadata: RetainedMetadata, order: HostOrder): string {
  return [
    String(order[firstProvenance(metadata.claimed, order).location.host]).padStart(2, "0"),
    locationKey(firstProvenance(metadata.claimed, order).location, order),
    metadata.key,
  ].join("\u0000");
}

function mergeMetadata(
  left: readonly RetainedMetadata[],
  right: readonly RetainedMetadata[],
  plugin: string,
  order: HostOrder,
): readonly RetainedMetadata[] {
  const byKey = new Map<string, RetainedMetadata>();
  for (const metadata of [...left, ...right]) {
    const existing = byKey.get(metadata.key);
    if (existing === undefined) {
      byKey.set(metadata.key, metadata);
      continue;
    }
    byKey.set(metadata.key, {
      key: metadata.key,
      claimed: mergePresentationalClaim(`metadata.${metadata.key}`, existing.claimed, metadata.claimed, plugin, order),
    });
  }
  return [...byKey.values()].sort((a, b) => compareText(metadataOrder(a, order), metadataOrder(b, order)));
}

function entryHost(entry: NormalizedMarketplaceEntry, order: HostOrder): NativeHost {
  return firstProvenance(entry.identity, order).location.host;
}

function entryOrder(entry: NormalizedMarketplaceEntry, order: HostOrder): string {
  return `${String(order[entryHost(entry, order)]).padStart(2, "0")}\u0000${stableJson(entry.identity.value)}\u0000${stableJson(entry.rawDeclaration.value)}`;
}

function normalizeEntryPair(
  left: NormalizedMarketplaceEntry,
  right: NormalizedMarketplaceEntry,
  order: HostOrder,
): readonly [NormalizedMarketplaceEntry, NormalizedMarketplaceEntry] {
  return compareText(entryOrder(left, order), entryOrder(right, order)) <= 0
    ? [left, right]
    : [right, left];
}

function assertIdentity(
  marketplaceName: MarketplaceName,
  left: NormalizedMarketplaceEntry,
  right: NormalizedMarketplaceEntry,
  order: HostOrder,
): void {
  if (left.identity.value.marketplaceName !== marketplaceName) {
    conflict("identity.marketplaceName", left.identity, right.identity, left.identity.value.key, order);
  }
  if (right.identity.value.marketplaceName !== marketplaceName) {
    conflict("identity.marketplaceName", left.identity, right.identity, right.identity.value.key, order);
  }
  if (left.identity.value.key !== right.identity.value.key ||
      left.identity.value.marketplaceEntryName !== right.identity.value.marketplaceEntryName) {
    conflict("identity", left.identity, right.identity, left.identity.value.key, order);
  }
}

/**
 * Reconcile one overlapping entry. This function intentionally throws a typed
 * claim conflict; the catalog-level function catches it and drops only this
 * entry while retaining its valid siblings.
 */
export function mergeMarketplaceEntries(
  marketplaceName: string,
  leftInput: NormalizedMarketplaceEntry,
  rightInput: NormalizedMarketplaceEntry,
  options?: MarketplaceMergeOptions,
): NormalizedMarketplaceEntry {
  const order = hostOrderFor(options?.hostPrecedence ?? DEFAULT_HOST_PRECEDENCE);
  const name = MarketplaceNameSchema.parse(marketplaceName) as MarketplaceName;
  const left = NormalizedMarketplaceEntrySchema.parse(leftInput) as NormalizedMarketplaceEntry;
  const right = NormalizedMarketplaceEntrySchema.parse(rightInput) as NormalizedMarketplaceEntry;
  // Unlike mergeMarketplaces, this public entry-level API has no catalog
  // label to trust. Bind each input to the host declared by its identity and
  // reject any cross-host claim before ordering or merging it.
  assertEntryHost(entryHost(left, order), left, "left", ENTRY_OPERATION);
  assertEntryHost(entryHost(right, order), right, "right", ENTRY_OPERATION);
  const [first, second] = normalizeEntryPair(left, right, order);
  const plugin = first.identity.value.key;

  assertIdentity(name, first, second, order);

  const sourceLeft = normalizePluginSource(first.source);
  const sourceRight = normalizePluginSource(second.source);
  const canonicalLeft = serializePluginSource(sourceLeft.value);
  const canonicalRight = serializePluginSource(sourceRight.value);
  if (canonicalLeft !== canonicalRight) {
    conflict("source", sourceLeft, sourceRight, plugin, order);
  }

  const version = mergeOptionalPresentational("version", first.version, second.version, plugin, order);
  const description = mergeOptionalPresentational("description", first.description, second.description, plugin, order);
  const policy = first.policy === undefined
    ? second.policy
    : second.policy === undefined
      ? first.policy
      : mergePolicy(first.policy, second.policy, plugin, order);

  const merged = {
    identity: mergeClaim("identity", first.identity, second.identity, plugin, order),
    source: mergeClaim("source", sourceLeft, sourceRight, plugin, order, (a, b) =>
      serializePluginSource(a) === serializePluginSource(b),
    ),
    ...(version === undefined ? {} : { version }),
    ...(description === undefined ? {} : { description }),
    ...(policy === undefined ? {} : { policy }),
    authorities: mergeAuthorities(first.authorities, second.authorities, plugin, order),
    declarations: mergeDeclarations(first.declarations, second.declarations, plugin, order),
    metadata: mergeMetadata(first.metadata, second.metadata, plugin, order),
    rawDeclaration: mergeRawClaim("rawDeclaration", first.rawDeclaration, second.rawDeclaration, plugin, order)
  };
  return NormalizedMarketplaceEntrySchema.parse(merged);
}

function diagnosticOrder(diagnostic: Diagnostic, order: HostOrder): string {
  return [
    diagnostic.location === undefined ? "99" : String(order[diagnostic.location.host]).padStart(2, "0"),
    diagnostic.location === undefined ? "" : locationKey(diagnostic.location, order),
    diagnostic.plugin ?? "",
    diagnostic.code,
    diagnostic.message,
    stableJson(diagnostic.details),
  ].join("\u0000");
}

function sourceDocumentOrder(document: NormalizedMarketplace["sourceDocuments"][number], order: HostOrder): string {
  return `${locationKey(document.location, order)}\u0000${stableJson(document.declaration)}`;
}

function rootMetadataOrder(metadata: RetainedMetadata, order: HostOrder): string {
  return metadataOrder(metadata, order);
}

function rootConflict(
  left: NormalizedMarketplace,
  right: NormalizedMarketplace,
  order: HostOrder,
): never {
  const leftClaim = left.name;
  const rightClaim = right.name;
  throw new BoundaryError({
    code: ErrorCodeRegistry.marketplaceRootInvalid,
    operation: OPERATION,
    message: `Marketplace roots declare different names: ${leftClaim.value} and ${rightClaim.value}`,
    location: firstProvenance(leftClaim, order).location,
    details: {
      left: claimSnapshot(leftClaim),
      right: claimSnapshot(rightClaim),
    },
  });
}

function invalidInput(cause: unknown): never {
  throw new BoundaryError({
    code: ErrorCodeRegistry.marketplaceRootInvalid,
    operation: OPERATION,
    message: "Marketplace merger input is invalid",
    details: cause instanceof Error ? { message: cause.message } : { message: String(cause) },
    cause,
  });
}

function hostMismatch(
  nativeHost: NativeHost,
  subject: string,
  actualHost: unknown,
  operation = OPERATION,
): never {
  throw new BoundaryError({
    code: ErrorCodeRegistry.marketplaceRootInvalid,
    operation,
    message: `Marketplace input host does not match ${subject}`,
    details: {
      expectedHost: nativeHost,
      actualHost: actualHost === undefined ? null : String(actualHost),
      subject,
    },
  });
}

function assertProvenanceHost(
  nativeHost: NativeHost,
  provenance: readonly Provenance[],
  subject: string,
  operation = OPERATION,
): void {
  for (const [index, claim] of provenance.entries()) {
    if (claim.location.host !== nativeHost) {
      hostMismatch(nativeHost, `${subject}.provenance[${index}]`, claim.location.host, operation);
    }
  }
}

function assertMetadataHost(
  nativeHost: NativeHost,
  metadata: RetainedMetadata,
  subject: string,
  operation = OPERATION,
): void {
  const expectedPrefix = `${nativeHost}.`;
  if (!metadata.key.startsWith(expectedPrefix) || metadata.key.length === expectedPrefix.length) {
    hostMismatch(nativeHost, `${subject}.key`, metadata.key, operation);
  }
  assertProvenanceHost(nativeHost, metadata.claimed.provenance, `${subject}.claimed`, operation);
}

/**
 * Bind every claim on a normalized entry to one native host. Catalog inputs
 * supply the expected host externally; direct entry callers do not, so their
 * identity provenance supplies it and every other claim is checked against
 * that binding before any reconciliation occurs.
 */
function assertEntryHost(
  nativeHost: NativeHost,
  entry: NormalizedMarketplaceEntry,
  subject: string,
  operation = OPERATION,
): void {
  assertProvenanceHost(nativeHost, entry.identity.provenance, `${subject}.identity`, operation);
  assertProvenanceHost(nativeHost, entry.source.provenance, `${subject}.source`, operation);
  if (entry.version !== undefined) {
    assertProvenanceHost(nativeHost, entry.version.provenance, `${subject}.version`, operation);
  }
  if (entry.description !== undefined) {
    assertProvenanceHost(nativeHost, entry.description.provenance, `${subject}.description`, operation);
  }
  if (entry.policy !== undefined) {
    assertProvenanceHost(nativeHost, entry.policy.availability.provenance, `${subject}.policy.availability`, operation);
    if (entry.policy.authentication !== undefined) {
      assertProvenanceHost(nativeHost, entry.policy.authentication.provenance, `${subject}.policy.authentication`, operation);
    }
    assertProvenanceHost(nativeHost, entry.policy.declaration.provenance, `${subject}.policy.declaration`, operation);
  }
  for (const [index, authority] of entry.authorities.entries()) {
    if (authority.nativeHost !== nativeHost) {
      hostMismatch(nativeHost, `${subject}.authorities[${index}].nativeHost`, authority.nativeHost, operation);
    }
    if (authority.strict !== undefined) {
      assertProvenanceHost(nativeHost, authority.strict.provenance, `${subject}.authorities[${index}].strict`, operation);
    }
    assertProvenanceHost(nativeHost, authority.manifest.provenance, `${subject}.authorities[${index}].manifest`, operation);
    assertProvenanceHost(nativeHost, authority.catalogRuntime.provenance, `${subject}.authorities[${index}].catalogRuntime`, operation);
  }
  for (const [index, declaration] of entry.declarations.entries()) {
    if (declaration.nativeHost !== nativeHost) {
      hostMismatch(nativeHost, `${subject}.declarations[${index}].nativeHost`, declaration.nativeHost, operation);
    }
    assertProvenanceHost(nativeHost, declaration.declaration.provenance, `${subject}.declarations[${index}].declaration`, operation);
  }
  for (const [index, metadata] of entry.metadata.entries()) {
    assertMetadataHost(nativeHost, metadata, `${subject}.metadata[${index}]`, operation);
  }
  assertProvenanceHost(nativeHost, entry.rawDeclaration.provenance, `${subject}.rawDeclaration`, operation);
}

function assertCatalogHost(
  nativeHost: NativeHost,
  result: MarketplaceReadResult,
): void {
  for (const [index, document] of result.marketplace.sourceDocuments.entries()) {
    if (document.location.host !== nativeHost) {
      hostMismatch(nativeHost, `sourceDocuments[${index}]`, document.location.host);
    }
  }
  for (const [index, diagnostic] of result.diagnostics.entries()) {
    if (diagnostic.location === undefined) {
      hostMismatch(nativeHost, `diagnostics[${index}]`, "missing");
    }
    if (diagnostic.location.host !== nativeHost) {
      hostMismatch(nativeHost, `diagnostics[${index}]`, diagnostic.location.host);
    }
  }

  assertProvenanceHost(nativeHost, result.marketplace.name.provenance, "name");
  for (const [index, metadata] of result.marketplace.metadata.entries()) {
    assertMetadataHost(nativeHost, metadata, `metadata[${index}]`);
  }
  for (const [index, entry] of result.marketplace.entries.entries()) {
    assertEntryHost(nativeHost, entry, `entries[${index}]`);
  }
}

function orderedInputs(inputs: readonly MarketplaceCatalogInput[], order: HostOrder): readonly MarketplaceCatalogInput[] {
  if (!Array.isArray(inputs) || inputs.length === 0) {
    invalidInput(new TypeError("mergeMarketplaces requires at least one catalog"));
  }
  const validated: MarketplaceCatalogInput[] = [];
  const hosts = new Set<NativeHost>();
  for (const input of inputs) {
    try {
      const nativeHost = NativeHostSchema.parse(input.nativeHost) as NativeHost;
      if (hosts.has(nativeHost)) {
        throw new BoundaryError({
          code: ErrorCodeRegistry.marketplaceRootInvalid,
          operation: OPERATION,
          message: `Duplicate ${nativeHost} marketplace catalog input`,
          details: { nativeHost },
        });
      }
      hosts.add(nativeHost);
      const result = MarketplaceReadResultSchema.parse(input.result) as MarketplaceReadResult;
      assertCatalogHost(nativeHost, result);
      validated.push({ nativeHost, result });
    } catch (cause) {
      if (cause instanceof BoundaryError) {
        throw cause;
      }
      invalidInput(cause);
    }
  }
  return validated.sort((left, right) => order[left.nativeHost] - order[right.nativeHost]);
}

/**
 * Merge normalized foreign catalogs in a fixed host order. The merger has no
 * source acquisition or manifest semantics; it only reconciles catalog claims.
 */
export function mergeMarketplaces(
  inputs: readonly [MarketplaceCatalogInput, ...MarketplaceCatalogInput[]],
  options?: MarketplaceMergeOptions,
): MarketplaceReadResult {
  const order = hostOrderFor(options?.hostPrecedence ?? DEFAULT_HOST_PRECEDENCE);
  const catalogs = orderedInputs(inputs, order);
  const first = catalogs[0]?.result as MarketplaceReadResult | undefined;
  if (first === undefined) {
    invalidInput(new TypeError("mergeMarketplaces requires at least one catalog"));
  }
  const rootName = first.marketplace.name.value;
  for (const catalog of catalogs.slice(1)) {
    if (catalog.result.marketplace.name.value !== rootName) {
      rootConflict(first.marketplace, catalog.result.marketplace, order);
    }
  }

  const entries = new Map<string, NormalizedMarketplaceEntry>();
  const mergeDiagnostics: Diagnostic[] = [];
  for (const catalog of catalogs) {
    for (const entry of catalog.result.marketplace.entries) {
      const name = entry.identity.value.marketplaceEntryName;
      const existing = entries.get(name);
      if (existing === undefined) {
        entries.set(name, entry);
        continue;
      }
      try {
        entries.set(name, mergeMarketplaceEntries(rootName, existing, entry, options));
      } catch (cause) {
        if (cause instanceof MarketplaceClaimConflictError) {
          mergeDiagnostics.push(cause.toDiagnostic());
          entries.delete(name);
          continue;
        }
        throw cause;
      }
    }
  }

  const mergedMarketplace = NormalizedMarketplaceSchema.parse({
    name: mergeClaim(
      "name",
      first.marketplace.name,
      catalogs.length === 1
        ? first.marketplace.name
        : catalogs[1]?.result.marketplace.name ?? first.marketplace.name,
      OPERATION,
      order,
    ),
    entries: [...entries.values()].sort((left, right) =>
      compareText(left.identity.value.marketplaceEntryName, right.identity.value.marketplaceEntryName)),
    metadata: catalogs
      .flatMap((catalog) => catalog.result.marketplace.metadata)
      .sort((left, right) => compareText(rootMetadataOrder(left, order), rootMetadataOrder(right, order))),
    sourceDocuments: catalogs
      .flatMap((catalog) => catalog.result.marketplace.sourceDocuments)
      .sort((left, right) => compareText(sourceDocumentOrder(left, order), sourceDocumentOrder(right, order))),
  });

  const diagnostics = [
    ...catalogs.flatMap((catalog) => catalog.result.diagnostics).sort((a, b) =>
      compareText(diagnosticOrder(a, order), diagnosticOrder(b, order))),
    ...mergeDiagnostics.sort((a, b) => compareText(diagnosticOrder(a, order), diagnosticOrder(b, order))),
  ].map((diagnostic) => DiagnosticSchema.parse(diagnostic));
  return MarketplaceReadResultSchema.parse({
    marketplace: mergedMarketplace,
    diagnostics,
  });
}
