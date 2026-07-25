import { BoundaryError } from "../domain/errors.js";
import {
  ContentDigestSchema,
  normalizeContentPath,
  createMaterializationBinding,
  verifyContentManifest,
  type ContentDigest,
  type ContentManifest,
} from "../domain/content-manifest.js";
import {
  MarketplaceSourceSchema,
  PluginSourceSchema,
  createResolvedPluginSource,
  serializeMarketplaceSource,
  serializePluginSource,
  verifyResolvedMarketplaceSource,
  verifyResolvedPluginSource,
  matchesGitRevisionSelector,
  isFullGitRevision,
  type MarketplaceSource,
  type PluginSource,
  type ResolvedMarketplaceSource,
  type ResolvedPluginSource,
} from "../domain/source.js";
import type { JsonValue } from "../domain/schema.js";
import type {
  MarketplacePathAcquirer,
  SecureContentSession,
  SourceMaterializationPortDependencies,
  StagingSlot,
} from "./ports/source-acquisition.js";

export type { StagingSlot } from "./ports/source-acquisition.js";
export type {
  ContentEntry,
  GitSourceAcquirer,
  MarketplacePathAcquirer,
  MaterializationLimits,
  NpmSourceAcquirer,
  SecureContentSession,
  SecureContentWriterFactory,
} from "./ports/source-acquisition.js";
export { DEFAULT_MATERIALIZATION_LIMITS } from "./ports/source-acquisition.js";

export type MaterializedMarketplace = Readonly<{
  root: string;
  source: ResolvedMarketplaceSource;
  content: ContentManifest;
  binding: ContentDigest;
}>;
export type MaterializedPlugin = Readonly<{
  root: string;
  source: ResolvedPluginSource;
  content: ContentManifest;
  binding: ContentDigest;
}>;

export type SourceContext =
  | Readonly<{ kind: "external" }>
  | Readonly<{
      kind: "marketplace";
      root: string;
      source: ResolvedMarketplaceSource;
      contentRootDigest: ContentDigest;
      /** The complete verified manifest, retained for context revalidation. */
      content: ContentManifest;
      /** Digest binding the resolved source identity to contentRootDigest. */
      binding: ContentDigest;
    }>;

export type MaterializationFailureClassification = "security" | "permanent" | "transient";

export class SourceMaterializationError extends BoundaryError {
  readonly classification: MaterializationFailureClassification;

  constructor(input: Readonly<{
    code: "PATH_CONTAINMENT_FAILED" | "SOURCE_RESOLUTION_FAILED" | "ADAPTER_FAILED";
    classification: MaterializationFailureClassification;
    operation: string;
    message: string;
    details?: JsonValue;
    cause?: unknown;
  }>) {
    super(input);
    if (!(["security", "permanent", "transient"] as const).includes(input.classification)) {
      throw new TypeError("source materialization classification is invalid");
    }
    this.name = "SourceMaterializationError";
    this.classification = input.classification;
  }
}

export type SourceMaterializationDependencies = SourceMaterializationPortDependencies;

function abortIfRequested(signal: AbortSignal): void {
  if (!signal.aborted) return;
  throw signal.reason ?? new DOMException("The operation was aborted", "AbortError");
}

function safeMessage(error: unknown): string {
  if (error instanceof SourceMaterializationError) return error.message;
  // Adapter messages may contain URLs, credentials, or remote stderr. Keep
  // those details in the native cause for the owning redacted logger only.
  return "source materialization adapter failed";
}

function safeDetails(operation: string): JsonValue {
  return { operation };
}

function asAdapterFailure(operation: string, error: unknown): SourceMaterializationError {
  if (error instanceof SourceMaterializationError) return error;
  return new SourceMaterializationError({
    code: "ADAPTER_FAILED",
    classification: "permanent",
    operation,
    message: safeMessage(error),
    details: safeDetails(operation),
    cause: error,
  });
}

function asResolutionFailure(operation: string, error: unknown): SourceMaterializationError {
  if (error instanceof SourceMaterializationError) return error;
  return new SourceMaterializationError({
    code: "SOURCE_RESOLUTION_FAILED",
    classification: "permanent",
    operation,
    message: safeMessage(error),
    details: safeDetails(operation),
    cause: error,
  });
}

async function cleanupOrThrow(
  session: SecureContentSession,
  original: unknown,
  signal: AbortSignal,
): Promise<never> {
  try {
    await session.abort(original);
  } catch (cleanupError) {
    const cleanup = asAdapterFailure("abortMaterialization", cleanupError);
    throw new SourceMaterializationError({
      code: "ADAPTER_FAILED",
      classification: "permanent",
      operation: "abortMaterialization",
      message: "materialization failed and cleanup also failed",
      details: {
        operation: "abortMaterialization",
        cleanup: cleanup.message,
      },
      cause: new AggregateError([original, cleanupError], "materialization cleanup failed"),
    });
  }
  if (signal.aborted) throw signal.reason ?? original;
  throw original instanceof SourceMaterializationError
    ? original
    : asAdapterFailure("materializeSource", original);
}

function checkedMarketplaceContext(
  context: SourceContext,
  sha256: SourceMaterializationDependencies["sha256"],
): Extract<SourceContext, { kind: "marketplace" }> {
  if (context === null || typeof context !== "object" || context.kind !== "marketplace") {
    throw new SourceMaterializationError({
      code: "PATH_CONTAINMENT_FAILED",
      classification: "security",
      operation: "materializePlugin",
      message: "marketplace-relative source requires marketplace context",
      details: { operation: "materializePlugin" },
    });
  }
  if (typeof context.root !== "string" || context.root.length === 0) {
    throw new SourceMaterializationError({
      code: "PATH_CONTAINMENT_FAILED",
      classification: "security",
      operation: "materializePlugin",
      message: "marketplace context root is empty",
      details: { operation: "materializePlugin" },
    });
  }
  try {
    ContentDigestSchema.parse(context.contentRootDigest);
    const manifest = verifyContentManifest(context.content, sha256);
    if (manifest.rootDigest !== context.contentRootDigest) throw new Error("marketplace context manifest digest does not match");
  } catch (error) {
    throw new SourceMaterializationError({
      code: "PATH_CONTAINMENT_FAILED",
      classification: "security",
      operation: "materializePlugin",
      message: "marketplace context manifest digest is invalid",
      details: { operation: "materializePlugin" },
      cause: error,
    });
  }
  try {
    const verified = verifyResolvedMarketplaceSource(context.source, sha256);
    if (context.binding !== createMaterializationBinding(verified.hash, context.contentRootDigest, sha256)) {
      throw new Error("marketplace context source/content binding does not match");
    }
  } catch (error) {
    throw new SourceMaterializationError({
      code: "SOURCE_RESOLUTION_FAILED",
      classification: "permanent",
      operation: "materializePlugin",
      message: "marketplace context source is not verified",
      details: { operation: "materializePlugin" },
      cause: error,
    });
  }
  return context;
}

function verifyMarketplaceResult(result: unknown, sha256: SourceMaterializationDependencies["sha256"]): ResolvedMarketplaceSource {
  try {
    return verifyResolvedMarketplaceSource(result, sha256);
  } catch (error) {
    throw asResolutionFailure("materializeMarketplace", error);
  }
}

function verifyPluginResult(result: unknown, sha256: SourceMaterializationDependencies["sha256"]): ResolvedPluginSource {
  try {
    return verifyResolvedPluginSource(result, sha256);
  } catch (error) {
    throw asResolutionFailure("materializePlugin", error);
  }
}

function assertMarketplaceDeclarationBinding(
  declared: MarketplaceSource,
  resolved: ResolvedMarketplaceSource,
): void {
  if (serializeMarketplaceSource(declared) !== serializeMarketplaceSource(resolved.declared)) {
    throw new SourceMaterializationError({
      code: "SOURCE_RESOLUTION_FAILED",
      classification: "permanent",
      operation: "materializeMarketplace",
      message: "resolved marketplace source does not match its declaration",
      details: { operation: "materializeMarketplace" },
    });
  }
  assertGitRevisionBinding(declared, resolved.revision, "materializeMarketplace");
}

function canonicalPrefix(source: PluginSource): string {
  const canonical = serializePluginSource(source);
  const marker = canonical.indexOf("|ref:") >= 0 ? "|ref:" : canonical.indexOf("|sha:") >= 0 ? "|sha:" : "";
  return marker.length === 0 ? canonical : canonical.slice(0, canonical.indexOf(marker));
}

function sourceMismatch(
  message: string,
  operation: "materializeMarketplace" | "materializePlugin" = "materializePlugin",
): SourceMaterializationError {
  return new SourceMaterializationError({
    code: "SOURCE_RESOLUTION_FAILED",
    classification: "permanent",
    operation,
    message,
    details: { operation },
  });
}

function assertGitRevisionBinding(
  declared: Readonly<{ ref?: string | undefined; sha?: string | undefined }>,
  revision: string,
  operation: "materializeMarketplace" | "materializePlugin",
): void {
  if (matchesGitRevisionSelector(declared, revision)) return;
  if (declared.sha !== undefined) {
    throw sourceMismatch("resolved Git revision does not match the authoritative SHA", operation);
  }
  if (declared.ref !== undefined && isFullGitRevision(declared.ref)) {
    throw sourceMismatch("resolved Git revision does not match the SHA-shaped ref", operation);
  }
  throw sourceMismatch("resolved Git revision does not match its declaration", operation);
}

const EXACT_NPM_VERSION = /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-(?:0|[1-9A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9A-Za-z-][0-9A-Za-z-]*))*)?(?:\+(?:0|[1-9A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9A-Za-z-][0-9A-Za-z-]*))*)?$/u;

/**
 * Catalogs spell repository-relative paths with a leading `./`, while content
 * manifests intentionally forbid dot segments. Remove only that catalog sigil
 * before applying the shared containment validator; every other path rule is
 * preserved unchanged.
 */
export function normalizeMarketplaceSourcePath(path: string): string {
  return normalizeContentPath(path.startsWith("./") ? path.slice(2) : path);
}

function assertPluginDeclarationBinding(
  declared: PluginSource,
  resolved: ResolvedPluginSource,
): void {
  if (declared.kind === "marketplace-path") {
    if (resolved.kind !== "marketplace-path" || resolved.path !== declared.path) throw sourceMismatch("resolved marketplace path does not match its declaration");
    return;
  }
  if (declared.kind === "npm") {
    if (resolved.kind !== "npm") throw sourceMismatch("resolved plugin source kind does not match its declaration");
    const expectedRegistry = declared.registry ?? "https://registry.npmjs.org/";
    if (resolved.package !== declared.package || serializePluginSource({ kind: "npm", package: resolved.package, registry: resolved.registry }) !== serializePluginSource({ kind: "npm", package: declared.package, registry: expectedRegistry })) {
      throw sourceMismatch("resolved npm source does not match its declaration");
    }
    if (declared.selector !== undefined && EXACT_NPM_VERSION.test(declared.selector) && resolved.version !== declared.selector) {
      throw sourceMismatch("resolved npm version does not match the exact selector");
    }
    return;
  }
  if (declared.kind === "git") {
    if (resolved.kind !== "git") throw sourceMismatch("resolved plugin source kind does not match its declaration");
    if (canonicalPrefix(declared) !== canonicalPrefix({ kind: "git", url: resolved.url })) throw sourceMismatch("resolved Git source does not match its declaration");
    assertGitRevisionBinding(declared, resolved.revision, "materializePlugin");
    return;
  }
  if (resolved.kind !== "git-subdir") throw sourceMismatch("resolved plugin source kind does not match its declaration");
  if (canonicalPrefix(declared) !== canonicalPrefix({ kind: "git-subdir", url: resolved.url, path: resolved.path })) throw sourceMismatch("resolved Git subdirectory does not match its declaration");
  assertGitRevisionBinding(declared, resolved.revision, "materializePlugin");
}

function expectedContentRoot(slotRoot: string): string {
  const trimmed = slotRoot.replace(/[\\/]+$/u, "");
  return slotRoot.includes("\\") ? `${trimmed}\\content` : `${trimmed}/content`;
}

async function canonicalizeDestination(
  content: SourceMaterializationDependencies["content"],
  destination: StagingSlot,
  operation: string,
): Promise<StagingSlot> {
  try {
    const canonical = await content.canonicalize(destination);
    if (canonical === null || typeof canonical !== "object" || typeof canonical.root !== "string" || canonical.root.length === 0) {
      throw new Error("content writer returned a malformed canonical staging slot");
    }
    // A canonical slot is an absolute filesystem identity. Passing a relative
    // value through would recreate the forged-root ambiguity at finalization.
    if (!/^[/\\]|^[A-Za-z]:[/\\]/u.test(canonical.root)) {
      throw new Error("content writer returned a non-absolute staging slot");
    }
    return canonical;
  } catch (error) {
    throw asAdapterFailure(operation, error);
  }
}

async function finalize(
  session: SecureContentSession,
  destination: StagingSlot,
  signal: AbortSignal,
  sha256: SourceMaterializationDependencies["sha256"],
  operation: string,
): Promise<Readonly<{ root: string; content: ContentManifest }>> {
  abortIfRequested(signal);
  const result = await session.finalize(signal);
  abortIfRequested(signal);
  try {
    const expected = expectedContentRoot(destination.root);
    if (session.contentRoot !== expected || result.root !== expected) {
      throw new Error("materializer returned a content root outside the canonical staging slot");
    }
    return { root: result.root, content: verifyContentManifest(result.content, sha256) };
  } catch (error) {
    throw asAdapterFailure(operation, error);
  }
}

export function createSourceMaterializers(
  dependencies: SourceMaterializationDependencies,
): Readonly<{
  marketplaces: MarketplaceMaterializer;
  plugins: PluginMaterializer;
}> {
  const marketplaces: MarketplaceMaterializer = {
    async materialize(source, destination, signal) {
      abortIfRequested(signal);
      let declaration: MarketplaceSource;
      try {
        declaration = MarketplaceSourceSchema.parse(source);
      } catch (error) {
        throw asResolutionFailure("materializeMarketplace", error);
      }
      const canonicalDestination = await canonicalizeDestination(dependencies.content, destination, "openContentWriter");
      abortIfRequested(signal);
      let session: SecureContentSession | undefined;
      try {
        session = await dependencies.content.open(canonicalDestination);
        abortIfRequested(signal);
        const resolved = verifyMarketplaceResult(
          await dependencies.git.materializeMarketplace(declaration, session, signal),
          dependencies.sha256,
        );
        assertMarketplaceDeclarationBinding(declaration, resolved);
        const content = await finalize(session, canonicalDestination, signal, dependencies.sha256, "finalizeContentManifest");
        abortIfRequested(signal);
        return {
          root: content.root,
          source: resolved,
          content: content.content,
          binding: createMaterializationBinding(resolved.hash, content.content.rootDigest, dependencies.sha256),
        };
      } catch (error) {
        if (session !== undefined) return cleanupOrThrow(session, error, signal);
        if (signal.aborted) throw signal.reason ?? error;
        throw asAdapterFailure("materializeMarketplace", error);
      }
    },
  };

  const plugins: PluginMaterializer = {
    async materialize(source, context, destination, signal) {
      abortIfRequested(signal);
      let declaration: PluginSource;
      try {
        declaration = PluginSourceSchema.parse(source);
      } catch (error) {
        throw asResolutionFailure("materializePlugin", error);
      }
      const canonicalDestination = await canonicalizeDestination(dependencies.content, destination, "openContentWriter");
      abortIfRequested(signal);
      let session: SecureContentSession | undefined;
      try {
        if (declaration.kind === "marketplace-path") {
          const marketplace = checkedMarketplaceContext(context, dependencies.sha256);
          try {
            normalizeMarketplaceSourcePath(declaration.path);
          } catch (error) {
            throw new SourceMaterializationError({
              code: "PATH_CONTAINMENT_FAILED",
              classification: "security",
              operation: "copyMarketplacePath",
              message: "marketplace source path is unsafe",
              details: { operation: "copyMarketplacePath" },
              cause: error,
            });
          }
          const copier: MarketplacePathAcquirer | undefined = dependencies.marketplace;
          if (copier === undefined) {
            throw new SourceMaterializationError({
              code: "ADAPTER_FAILED",
              classification: "permanent",
              operation: "copyMarketplacePath",
              message: "no marketplace path acquirer is configured",
              details: { operation: "copyMarketplacePath" },
            });
          }
          session = await dependencies.content.open(canonicalDestination);
          abortIfRequested(signal);
          await copier.materialize(declaration, marketplace, session, signal);
          const resolved = createMarketplacePluginSource(declaration, marketplace, dependencies.sha256);
          assertPluginDeclarationBinding(declaration, resolved);
          if (resolved.kind !== "marketplace-path" || resolved.marketplaceRevision !== marketplace.source.revision) {
            throw new SourceMaterializationError({
              code: "SOURCE_RESOLUTION_FAILED",
              classification: "permanent",
              operation: "materializePlugin",
              message: "resolved marketplace plugin revision does not match its context",
              details: { operation: "materializePlugin" },
            });
          }
          const content = await finalize(session, canonicalDestination, signal, dependencies.sha256, "finalizeContentManifest");
          abortIfRequested(signal);
          return {
            root: content.root,
            source: resolved,
            content: content.content,
            binding: createMaterializationBinding(resolved.hash, content.content.rootDigest, dependencies.sha256),
          };
        }

        if (context === null || typeof context !== "object" || context.kind !== "external") {
          throw new SourceMaterializationError({
            code: "SOURCE_RESOLUTION_FAILED",
            classification: "permanent",
            operation: "materializePlugin",
            message: "external plugin source cannot use marketplace context",
            details: { operation: "materializePlugin" },
          });
        }

        session = await dependencies.content.open(canonicalDestination);
        abortIfRequested(signal);
        const resolved = declaration.kind === "npm"
          ? await dependencies.npm.materialize(declaration, session, signal)
          : await dependencies.git.materializePlugin(declaration, session, signal);
        const verified = verifyPluginResult(resolved, dependencies.sha256);
        assertPluginDeclarationBinding(declaration, verified);
        const content = await finalize(session, canonicalDestination, signal, dependencies.sha256, "finalizeContentManifest");
        abortIfRequested(signal);
        return {
          root: content.root,
          source: verified,
          content: content.content,
          binding: createMaterializationBinding(verified.hash, content.content.rootDigest, dependencies.sha256),
        };
      } catch (error) {
        if (session !== undefined) return cleanupOrThrow(session, error, signal);
        if (signal.aborted) throw signal.reason ?? error;
        throw asAdapterFailure("materializePlugin", error);
      }
    },
  };

  return { marketplaces, plugins };
}

function createMarketplacePluginSource(
  source: Extract<PluginSource, { kind: "marketplace-path" }>,
  context: Extract<SourceContext, { kind: "marketplace" }>,
  sha256: SourceMaterializationDependencies["sha256"],
): ResolvedPluginSource {
  try {
    return createResolvedPluginSource({
      kind: "marketplace-path",
      marketplaceRevision: context.source.revision,
      path: source.path,
    }, sha256);
  } catch (error) {
    throw asResolutionFailure("materializePlugin", error);
  }
}

export interface MarketplaceMaterializer {
  materialize(source: MarketplaceSource, destination: StagingSlot, signal: AbortSignal): Promise<MaterializedMarketplace>;
}
export interface PluginMaterializer {
  materialize(source: PluginSource, context: SourceContext, destination: StagingSlot, signal: AbortSignal): Promise<MaterializedPlugin>;
}
