import { dirname } from "node:path";
import type { ContentStorePort } from "../../application/ports/content-store.js";
import {
  InstalledPluginLoaderRequestSchema,
  LoadedInstalledPluginSchema,
  type InstalledPluginLoader,
  type LoadedInstalledPlugin,
} from "../../application/ports/installed-plugin-loader.js";
import { verifyInstalledRevisionDescriptor } from "../../application/installed-revision-descriptor.js";
import { createInstalledRevisionRecord } from "../../domain/state/installed-state.js";
import { createScopeContext, toScopeReference } from "../../domain/state/scope.js";
import type { Sha256 } from "../../domain/source.js";
import { inspectPublishedRevision } from "./immutable-content-store.js";

export class InstalledPluginLoadError extends Error {
  readonly code:
    | "INSTALLED_DESCRIPTOR_UNAVAILABLE"
    | "INSTALLED_DESCRIPTOR_CORRUPT";

  constructor(code: InstalledPluginLoadError["code"], cause?: unknown) {
    super(code === "INSTALLED_DESCRIPTOR_UNAVAILABLE"
      ? "installed revision cannot be reconstructed"
      : "installed revision reconstruction evidence is corrupt",
    cause === undefined ? undefined : { cause });
    this.name = "InstalledPluginLoadError";
    this.code = code;
  }

  toJSON(): Readonly<{ code: string; message: string }> {
    return Object.freeze({ code: this.code, message: this.message });
  }
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function deepFreeze(value: unknown, seen = new WeakSet<object>()): void {
  if (value === null || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child, seen);
  Object.freeze(value);
}

export function createInstalledPluginLoader(input: Readonly<{
  content: Pick<ContentStorePort, "resolvePlugin">;
  sha256: Sha256;
}>): InstalledPluginLoader {
  if (input === null || typeof input !== "object" || typeof input.sha256 !== "function") {
    throw new TypeError("installed plugin loader dependencies are required");
  }
  return Object.freeze({
    async load(
      requestInput: Parameters<InstalledPluginLoader["load"]>[0],
      signal: AbortSignal,
    ): Promise<LoadedInstalledPlugin> {
      signal.throwIfAborted();
      const request = InstalledPluginLoaderRequestSchema.parse(requestInput);
      const scope = createScopeContext(request.scope, input.sha256);
      const scopeReference = toScopeReference(scope);
      const resolved = await input.content.resolvePlugin(request.revision, signal, scopeReference);
      const published = await inspectPublishedRevision(dirname(resolved.root), input.sha256);
      if (published.descriptor === undefined) {
        throw new InstalledPluginLoadError("INSTALLED_DESCRIPTOR_UNAVAILABLE");
      }
      try {
        const descriptor = verifyInstalledRevisionDescriptor(published.descriptor, request.revision, input.sha256);
        if (!sameJson(descriptor.loaded.content, resolved.manifest) || descriptor.loaded.binding !== request.revision.revision) {
          throw new Error("descriptor content does not match resolved revision");
        }
        const evidence = request.revision.evidence.source;
        const reconstructed = createInstalledRevisionRecord({
          plugin: descriptor.loaded.plugin,
          compatibility: descriptor.loaded.compatibility,
          content: descriptor.loaded.content,
          revision: request.revision.revision,
          contentRef: request.revision.contentRef,
          dataRef: request.revision.dataRef,
          ...(request.revision.configurationRef === undefined ? {} : { configurationRef: request.revision.configurationRef }),
          ...(evidence.marketplaceSourceIdentity === undefined ? {} : { marketplaceSourceIdentity: evidence.marketplaceSourceIdentity }),
          ...(evidence.pluginSourceIdentity === undefined ? {} : { pluginSourceIdentity: evidence.pluginSourceIdentity }),
          ...(evidence.declaredVersion === undefined ? {} : { declaredVersion: evidence.declaredVersion }),
          scope: scopeReference,
        }, input.sha256);
        if (!sameJson(reconstructed, request.revision)) {
          throw new Error("descriptor does not reproduce installed revision evidence");
        }
        const loaded = LoadedInstalledPluginSchema.parse(descriptor.loaded);
        deepFreeze(loaded);
        return loaded;
      } catch (cause) {
        if (cause instanceof InstalledPluginLoadError) throw cause;
        throw new InstalledPluginLoadError("INSTALLED_DESCRIPTOR_CORRUPT", cause);
      }
    },
  });
}
