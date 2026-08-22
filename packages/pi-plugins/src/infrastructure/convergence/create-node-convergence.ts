import { join } from "node:path";
import { createConvergenceService, type ConvergenceService } from "../../application/convergence-service.js";
import type { LifecycleStateStore } from "../../application/ports/lifecycle-state-store.js";
import type { LifecycleStateInventoryPort } from "../../application/ports/lifecycle-state-inventory.js";
import type { PersistentDataRemovalPort } from "../../application/ports/persistent-data-removal.js";
import type { LifecycleClock } from "../../application/ports/lifecycle-clock.js";
import type { Sha256 } from "../../domain/source.js";
import { createPendingDeleteMarkerStore } from "../cleanup/pending-data-deletion.js";
import { createArtifactGc } from "./artifact-gc.js";

export function createNodeConvergenceService(input: Readonly<{ state: LifecycleStateStore; hostRoot: string; dataRemoval?: PersistentDataRemovalPort; inventory: LifecycleStateInventoryPort; sha256: Sha256; clock?: LifecycleClock; projectionReferences?: () => ReadonlySet<string> | undefined }>): ConvergenceService {
  const pendingDeletes = createPendingDeleteMarkerStore({ root: join(input.hostRoot, "cleanup", "v1", "pending-deletes") });
  return createConvergenceService({ ...input, pendingDeletes, artifacts: createArtifactGc({ hostRoot: input.hostRoot }) });
}
