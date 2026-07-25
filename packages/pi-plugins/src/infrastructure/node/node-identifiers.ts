import { randomBytes, randomUUID } from "node:crypto";
import { ConfigurationWriteIdSchema } from "../../domain/configured-values.js";
import { RefreshClaimIdSchema, UpdateSchedulerLeaseIdSchema } from "../../domain/update-policy.js";
import {
  LifecycleOperationIdSchema,
  type LifecycleOperationIdPort,
} from "../../application/ports/lifecycle-operation-id.js";
import type { ConfigurationWriteIdPort } from "../../application/ports/configuration-write-id.js";
import type { RefreshClaimIdPort } from "../../application/ports/refresh-claim-id.js";
import { ProjectIntentWriteIdSchema, type ProjectIntentWriteIdPort } from "../../application/ports/project-intent-write-id.js";
import type { UpdateSchedulerLeaseIdPort } from "../../application/ports/update-scheduler-lease-id.js";
import { NativeControlExecutionIdSchema } from "../../application/native-control-contract.js";
import type { NativeControlExecutionIdPort } from "../../application/ports/native-control-execution.js";

export type NodeHostIdentifiers = Readonly<{
  operationIds: LifecycleOperationIdPort;
  configurationWriteIds: ConfigurationWriteIdPort;
  refreshClaimIds: RefreshClaimIdPort;
  updateSchedulerLeaseIds: UpdateSchedulerLeaseIdPort;
  projectIntentWriteIds: ProjectIntentWriteIdPort;
  controlExecutionIds: NativeControlExecutionIdPort;
}>;

/** One stateless cryptographic identifier authority for the composed host. */
export function createNodeHostIdentifiers(): NodeHostIdentifiers {
  return Object.freeze({
    operationIds: Object.freeze({
      async create(signal: AbortSignal) {
        signal.throwIfAborted();
        return LifecycleOperationIdSchema.parse(randomUUID());
      },
    }),
    configurationWriteIds: Object.freeze({
      async create(signal: AbortSignal) {
        signal.throwIfAborted();
        return ConfigurationWriteIdSchema.parse(`config-write-v1:${randomBytes(24).toString("base64url")}`);
      },
    }),
    refreshClaimIds: Object.freeze({
      create() {
        return RefreshClaimIdSchema.parse(`refresh-claim-v1:uuid:${randomUUID()}`);
      },
    }),
    updateSchedulerLeaseIds: Object.freeze({
      async create(signal: AbortSignal) {
        signal.throwIfAborted();
        return UpdateSchedulerLeaseIdSchema.parse(`update-scheduler-lease-v1:uuid:${randomUUID()}`);
      },
    }),
    projectIntentWriteIds: Object.freeze({
      async create(signal: AbortSignal) {
        signal.throwIfAborted();
        return ProjectIntentWriteIdSchema.parse(`project-intent-write-v1:${randomBytes(24).toString("base64url")}`);
      },
    }),
    controlExecutionIds: Object.freeze({
      async issue(signal: AbortSignal) {
        signal.throwIfAborted();
        return NativeControlExecutionIdSchema.parse(`native-control-execution-v1:${randomUUID()}`);
      },
    }),
  });
}
