import {
  createMarketplaceStoreIdentity,
  createPluginStoreIdentity,
  ContentStoreIdentitySchema,
  type ContentStoreIdentity,
} from "../domain/content-store.js";
import {
  ContentDigestSchema,
  verifyContentManifest,
  type ContentDigest,
} from "../domain/content-manifest.js";
import { DomainContractError, ErrorCodeRegistry } from "../domain/errors.js";
import {
  verifyResolvedMarketplaceSource,
  verifyResolvedPluginSource,
  type ResolvedMarketplaceSource,
  type ResolvedPluginSource,
  type Sha256,
} from "../domain/source.js";
import type {
  MaterializedMarketplace,
  MaterializedPlugin,
} from "./source-materialization.js";
import type {
  StagingAllocation,
  VerifiedPromotionPlan,
} from "./ports/content-store.js";
import {
  InstalledRevisionDescriptorSchemaV1,
  type InstalledRevisionDescriptor,
} from "./installed-revision-descriptor.js";

export type PromotionPlanInput = Readonly<{
  kind: "marketplace" | "plugin";
  allocation: StagingAllocation;
  /** The completed materializer handoff. `handoff` is accepted as an alias for adapters. */
  materialized?: MaterializedMarketplace | MaterializedPlugin;
  handoff?: MaterializedMarketplace | MaterializedPlugin;
  /** Exact restart reconstruction evidence; only plugin plans may carry it. */
  descriptor?: InstalledRevisionDescriptor;
}>;

const verifiedPlans = new WeakSet<object>();

function invalidPlan(message: string, cause?: unknown): DomainContractError {
  return new DomainContractError({
    code: ErrorCodeRegistry.contentVerificationFailed,
    operation: "createPromotionPlan",
    message,
    details: { operation: "createPromotionPlan" },
    ...(cause === undefined ? {} : { cause }),
  });
}

function checkedAllocation(input: unknown): StagingAllocation {
  if (input === null || typeof input !== "object") throw invalidPlan("staging allocation is invalid");
  const value = input as { readonly slot?: unknown; readonly allocationId?: unknown };
  if (
    value.slot === null ||
    typeof value.slot !== "object" ||
    typeof (value.slot as { readonly root?: unknown }).root !== "string" ||
    (value.slot as { readonly root: string }).root.length === 0 ||
    typeof value.allocationId !== "string" ||
    value.allocationId.length === 0
  ) {
    throw invalidPlan("staging allocation is invalid");
  }
  return input as StagingAllocation;
}

function materializedValue(input: PromotionPlanInput): MaterializedMarketplace | MaterializedPlugin {
  const value = input.materialized ?? input.handoff;
  if (value === undefined || value === null || typeof value !== "object") {
    throw invalidPlan("materialization handoff is missing");
  }
  return value;
}

function checkedMaterialized(
  kind: PromotionPlanInput["kind"],
  value: MaterializedMarketplace | MaterializedPlugin,
  sha256: Sha256,
): Readonly<{
  root: string;
  source: ResolvedMarketplaceSource | ResolvedPluginSource;
  manifest: ReturnType<typeof verifyContentManifest>;
  binding: ContentDigest;
  identity: ContentStoreIdentity;
}> {
  if (typeof value.root !== "string" || value.root.length === 0) {
    throw invalidPlan("materialization handoff root is invalid");
  }
  ContentDigestSchema.parse(value.binding);
  const manifest = verifyContentManifest(value.content, sha256);
  if (kind === "marketplace") {
    const source = verifyResolvedMarketplaceSource(value.source as ResolvedMarketplaceSource, sha256);
    const identity = createMarketplaceStoreIdentity(source, manifest, value.binding, sha256);
    return { root: value.root, source, manifest, binding: value.binding, identity };
  }
  const source = verifyResolvedPluginSource(value.source, sha256);
  const identity = createPluginStoreIdentity(source, manifest, value.binding, sha256);
  return { root: value.root, source, manifest, binding: value.binding, identity };
}

/**
 * The only application factory for a promotion plan. Filesystem adapters must
 * still prove allocation ownership; this private membership mark merely keeps
 * structural plan objects from crossing the application boundary.
 */
export function createPromotionPlan(
  input: PromotionPlanInput,
  sha256: Sha256,
): VerifiedPromotionPlan {
  if (input === null || typeof input !== "object") throw invalidPlan("promotion plan input is invalid");
  if (input.kind !== "marketplace" && input.kind !== "plugin") throw invalidPlan("promotion store kind is invalid");
  const allocation = checkedAllocation(input.allocation);
  const materialized = checkedMaterialized(input.kind, materializedValue(input), sha256);
  if (input.kind === "marketplace" && input.descriptor !== undefined) {
    throw invalidPlan("marketplace promotion cannot carry an installed plugin descriptor");
  }
  let descriptor: InstalledRevisionDescriptor | undefined;
  if (input.descriptor !== undefined) {
    descriptor = InstalledRevisionDescriptorSchemaV1.parse(input.descriptor);
    if (descriptor.loaded.binding !== materialized.binding ||
        descriptor.loaded.content.rootDigest !== materialized.manifest.rootDigest ||
        descriptor.loaded.plugin.source.hash !== materialized.source.hash) {
      throw invalidPlan("installed plugin descriptor does not match materialized promotion evidence");
    }
  }
  const plan = Object.freeze({
    kind: input.kind,
    allocation,
    root: materialized.root,
    source: materialized.source,
    manifest: materialized.manifest,
    binding: materialized.binding,
    identity: materialized.identity,
    ...(descriptor === undefined ? {} : { descriptor }),
  }) as VerifiedPromotionPlan;
  verifiedPlans.add(plan);
  return plan;
}

/** Internal runtime guard used by physical adapters before mutation. */
export function isVerifiedPromotionPlan(value: unknown): value is VerifiedPromotionPlan {
  return typeof value === "object" && value !== null && verifiedPlans.has(value);
}

/** Revalidate the plan's canonical evidence without touching the filesystem. */
export function assertVerifiedPromotionPlan(
  value: unknown,
  sha256: Sha256,
): VerifiedPromotionPlan {
  if (!isVerifiedPromotionPlan(value)) {
    throw new DomainContractError({
      code: ErrorCodeRegistry.contentVerificationFailed,
      operation: "promoteContent",
      message: "promotion plan is not an application-issued capability",
      details: { operation: "promoteContent" },
    });
  }
  const expected = checkedMaterialized(value.kind, {
    root: value.root,
    source: value.source,
    content: value.manifest,
    binding: value.binding,
  } as MaterializedMarketplace | MaterializedPlugin, sha256);
  const parsedIdentity = ContentStoreIdentitySchema.parse(value.identity);
  if (JSON.stringify(parsedIdentity) !== JSON.stringify(expected.identity)) {
    throw new DomainContractError({
      code: ErrorCodeRegistry.contentVerificationFailed,
      operation: "promoteContent",
      message: "promotion plan identity is not bound to its source evidence",
      details: { operation: "promoteContent" },
    });
  }
  if (value.kind === "marketplace" && value.descriptor !== undefined) {
    throw invalidPlan("marketplace promotion cannot carry an installed plugin descriptor");
  }
  if (value.descriptor !== undefined) {
    const descriptor = InstalledRevisionDescriptorSchemaV1.parse(value.descriptor);
    if (descriptor.loaded.binding !== value.binding ||
        descriptor.loaded.content.rootDigest !== value.manifest.rootDigest ||
        descriptor.loaded.plugin.source.hash !== value.source.hash) {
      throw invalidPlan("installed plugin descriptor does not match promotion evidence");
    }
  }
  return value;
}

export type { VerifiedPromotionPlan, StagingAllocation };
