import { BoundaryError, ErrorCodeRegistry } from "../domain/errors.js";
import { ContentManifestSchema, createMaterializationBinding, type ContentManifest } from "../domain/content-manifest.js";
import { JsonValueSchema } from "../domain/schema.js";
import { verifyResolvedMarketplaceSource, type Sha256 } from "../domain/source.js";
import { createContentIndex } from "./content-index.js";
import type { ContentReadPort } from "./ports/content-read.js";
import {
  DEFAULT_HOST_PRECEDENCE,
  HostPrecedenceSchema,
  type HostPrecedence,
} from "../domain/host-precedence.js";
import {
  MarketplaceInspectionLimitsSchema,
  type MarketplaceInspectionLimits,
  type MarketplaceInspectionReaders,
  type MarketplaceInspectionService,
  type MaterializedMarketplaceInspectionInput,
} from "./marketplace-inspection-contract.js";

const CATALOG_PATHS = {
  claude: ".claude-plugin/marketplace.json",
  codex: ".agents/plugins/marketplace.json",
} as const;

function abortIfRequested(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason ?? new DOMException("The operation was aborted", "AbortError");
}

function boundary(message: string, cause?: unknown): BoundaryError {
  return new BoundaryError({
    code: ErrorCodeRegistry.marketplaceRootInvalid,
    operation: "inspectMarketplace",
    message,
    details: { operation: "inspectMarketplace" },
    ...(cause === undefined ? {} : { cause }),
  });
}

function parseJson(bytes: Uint8Array, limit: number): unknown {
  if (bytes.byteLength > limit) throw boundary("marketplace catalog exceeds the inspection limit");
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    throw boundary("marketplace catalog is not valid UTF-8", error);
  }
  try {
    return JsonValueSchema.parse(JSON.parse(text) as unknown);
  } catch (error) {
    throw boundary("marketplace catalog is not valid JSON", error);
  }
}

function createService(dependencies: Readonly<{
  content: ContentReadPort;
  readers: MarketplaceInspectionReaders;
  sha256: Sha256;
  limits?: Partial<MarketplaceInspectionLimits>;
  /** Resolves the user's canonical host order at call time; defaults to Claude-first. */
  hostPrecedence?: () => Promise<HostPrecedence>;
}>): MarketplaceInspectionService {
  const limits = MarketplaceInspectionLimitsSchema.parse({ maxCatalogBytes: 1024 * 1024, ...(dependencies.limits ?? {}) });
  if (typeof dependencies.sha256 !== "function") throw new TypeError("marketplace inspection requires SHA-256");
  if (dependencies.content === null || typeof dependencies.content.readFile !== "function") throw new TypeError("marketplace inspection requires a content reader");
  if (dependencies.readers === null || typeof dependencies.readers.merge !== "function") throw new TypeError("marketplace inspection requires marketplace readers");

  return {
    async inspect(input: MaterializedMarketplaceInspectionInput, signal: AbortSignal) {
      abortIfRequested(signal);
      if (input === null || typeof input !== "object") throw boundary("marketplace materialization handoff is invalid");
      let content: ContentManifest;
      try {
        content = ContentManifestSchema.parse(input.content);
        const source = verifyResolvedMarketplaceSource(input.source, dependencies.sha256);
        if (input.binding !== createMaterializationBinding(source.hash, content.rootDigest, dependencies.sha256)) throw new Error("marketplace source/content binding does not match");
      } catch (error) {
        throw boundary("marketplace materialization handoff is not verified", error);
      }
      const index = createContentIndex(content);
      const inputs: Array<{ nativeHost: "claude" | "codex"; result: Awaited<ReturnType<NonNullable<MarketplaceInspectionReaders["claude"]>>> }> = [];
      for (const nativeHost of ["claude", "codex"] as const) {
        abortIfRequested(signal);
        const path = CATALOG_PATHS[nativeHost];
        const entry = index.get(path);
        if (entry === undefined) continue;
        if (entry.kind !== "file") throw boundary(`${path} is not a regular file`);
        const reader = dependencies.readers[nativeHost];
        if (reader === undefined) throw boundary(`${nativeHost} marketplace reader is not configured`);
        let bytes: Uint8Array;
        try {
          bytes = await dependencies.content.readFile({ root: input.root, entry }, limits.maxCatalogBytes, signal);
        } catch (error) {
          if (signal.aborted) throw signal.reason ?? error;
          throw boundary("marketplace catalog could not be read", error);
        }
        abortIfRequested(signal);
        const result = reader(parseJson(bytes, limits.maxCatalogBytes), { path });
        inputs.push({ nativeHost, result });
      }
      if (inputs.length === 0) throw boundary("materialized marketplace has no supported catalog");
      if (inputs.length === 1) return inputs[0]!.result;
      const precedence = dependencies.hostPrecedence === undefined
        ? DEFAULT_HOST_PRECEDENCE
        : HostPrecedenceSchema.parse(await dependencies.hostPrecedence());
      return dependencies.readers.merge(inputs as unknown as Parameters<MarketplaceInspectionReaders["merge"]>[0], { hostPrecedence: precedence });
    },
  };
}

export function createMarketplaceInspectionService(dependencies: Readonly<{
  content: ContentReadPort;
  readers: MarketplaceInspectionReaders;
  sha256: Sha256;
  limits?: Partial<MarketplaceInspectionLimits>;
  /** Resolves the user's canonical host order at call time; defaults to Claude-first. */
  hostPrecedence?: () => Promise<HostPrecedence>;
}>): MarketplaceInspectionService {
  return createService(dependencies);
}

export type { MarketplaceInspectionLimits } from "./marketplace-inspection-contract.js";
