import { z } from "zod";
import { ContentDigestSchema, hashContent } from "../domain/content-manifest.js";
import { InstalledRevisionRecordSchema, type InstalledRevisionRecord } from "../domain/state/installed-state.js";
import type { Sha256 } from "../domain/source.js";
import {
  LoadedInstalledPluginSchema,
  type LoadedInstalledPlugin,
} from "./ports/installed-plugin-loader.js";

export const InstalledRevisionDescriptorSchemaV1 = z.object({
  schemaVersion: z.literal(1),
  loaded: LoadedInstalledPluginSchema,
  digest: ContentDigestSchema,
}).strict().readonly();
export type InstalledRevisionDescriptor = z.infer<typeof InstalledRevisionDescriptorSchemaV1>;

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(record).sort().map((key) => [key, canonicalize(record[key])]));
  }
  return value;
}

function descriptorDigest(loaded: LoadedInstalledPlugin, sha256: Sha256) {
  return hashContent(
    new TextEncoder().encode(`installed-revision-descriptor-v1\0${JSON.stringify(canonicalize(loaded))}`),
    sha256,
  );
}

function verifyRevisionBinding(loaded: LoadedInstalledPlugin, revision: InstalledRevisionRecord): void {
  if (loaded.binding !== revision.revision || loaded.content.rootDigest !== revision.contentDigest ||
      loaded.plugin.identity.key !== revision.evidence.plugin.key ||
      loaded.compatibility.plugin.key !== revision.evidence.plugin.key ||
      loaded.plugin.source.hash !== revision.evidence.source.sourceHash ||
      loaded.compatibility.activatable !== revision.evidence.compatibility.activatable) {
    throw new Error("installed reconstruction descriptor does not match installed revision evidence");
  }
}

export function createInstalledRevisionDescriptor(input: Readonly<{
  loaded: LoadedInstalledPlugin;
  revision: InstalledRevisionRecord;
  sha256: Sha256;
}>): InstalledRevisionDescriptor {
  if (typeof input.sha256 !== "function") throw new TypeError("installed descriptor requires SHA-256");
  const loaded = LoadedInstalledPluginSchema.parse(input.loaded);
  const revision = InstalledRevisionRecordSchema.parse(input.revision);
  verifyRevisionBinding(loaded, revision);
  return InstalledRevisionDescriptorSchemaV1.parse({
    schemaVersion: 1,
    loaded,
    digest: descriptorDigest(loaded, input.sha256),
  });
}

export function verifyInstalledRevisionDescriptor(input: unknown, revision: InstalledRevisionRecord, sha256: Sha256): InstalledRevisionDescriptor {
  const descriptor = InstalledRevisionDescriptorSchemaV1.parse(input);
  verifyRevisionBinding(descriptor.loaded, InstalledRevisionRecordSchema.parse(revision));
  if (descriptor.digest !== descriptorDigest(descriptor.loaded, sha256)) {
    throw new Error("installed reconstruction descriptor digest does not match its evidence");
  }
  return descriptor;
}
