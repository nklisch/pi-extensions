import { hashContent } from "../../domain/content-manifest.js";
import { HostConfigDocumentSchema } from "../../domain/state/config-state.js";
import { InstalledUserStateDocumentSchema } from "../../domain/state/installed-state.js";
import {
  ProjectLocalStateDocumentSchema,
  UNSYNCHRONIZED_PORTABLE_INTENT,
} from "../../domain/state/project-state.js";
import { TrustStateDocumentSchema } from "../../domain/state/trust-state.js";
import type { ScopeContext } from "../../domain/state/scope.js";
import type { Sha256 } from "../../domain/source.js";
import type {
  HostConfigDocument,
  InstalledUserStateDocument,
  ProjectLocalStateDocument,
  TrustStateDocument,
} from "../../application/state-contract.js";

export { UNSYNCHRONIZED_PORTABLE_INTENT };

export type LifecycleStateDefaultDocuments =
  | Readonly<{
      config: HostConfigDocument;
      installed: InstalledUserStateDocument;
      trust: TrustStateDocument;
    }>
  | Readonly<{ project: ProjectLocalStateDocument }>;

export function createLifecycleStateDefaultDocuments(
  scope: ScopeContext,
  sha256: Sha256,
): LifecycleStateDefaultDocuments {
  if (scope.kind === "user") {
    return Object.freeze({
      config: HostConfigDocumentSchema.parse({
        schemaVersion: 4,
        generation: 0,
        global: { application: "manual", cadence: "balanced" },
        scope: {},
        records: [],
      }),
      installed: InstalledUserStateDocumentSchema.parse({ schemaVersion: 2, generation: 0, marketplaces: [], plugins: [] }),
      trust: TrustStateDocumentSchema.parse({ schemaVersion: 1, generation: 0, records: [] }),
    });
  }
  const declarationDigest = hashContent(
    new TextEncoder().encode(UNSYNCHRONIZED_PORTABLE_INTENT),
    sha256,
  );
  return Object.freeze({
    project: ProjectLocalStateDocumentSchema.parse({
      schemaVersion: 4,
      generation: 0,
      projectKey: scope.projectKey,
      identity: scope.identity,
      declarationDigest,
      scope: {},
      marketplaces: [],
      plugins: [],
      marketplaceUpdates: [],
    }),
  });
}
