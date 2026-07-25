import {
  NativeLifecycleOperationSessionPolicy,
  NativeLifecycleProgressEventSchema,
  type NativeLifecycleOperationKind,
  type NativeLifecycleProgressEvent,
  type NativeLifecycleProgressPhase,
  type NativeLifecycleProgressSink,
  type NativeLifecycleStableCode,
} from "./native-lifecycle-operation-contract.js";
import type { PluginKey } from "../domain/identity.js";
import type { ProjectSyncActionId } from "./project-sync-contract.js";

export type NativeLifecycleProgressRecorder = Readonly<{
  events(): readonly NativeLifecycleProgressEvent[];
  emit(input: Readonly<{
    phase: NativeLifecycleProgressPhase;
    state: NativeLifecycleProgressEvent["state"];
    plugin?: PluginKey;
    actionId?: ProjectSyncActionId;
    code?: NativeLifecycleStableCode;
  }>): Promise<void>;
}>;

/** Progress is bounded observer output, never operation authority. */
export function createNativeLifecycleProgressRecorder(
  operation: NativeLifecycleOperationKind,
  sink?: NativeLifecycleProgressSink,
): NativeLifecycleProgressRecorder {
  const values: NativeLifecycleProgressEvent[] = [];
  let deliveryFailureRecorded = false;

  function append(input: Parameters<NativeLifecycleProgressRecorder["emit"]>[0]): NativeLifecycleProgressEvent {
    const event = NativeLifecycleProgressEventSchema.parse({ sequence: values.length === 0 ? 0 : values.at(-1)!.sequence + 1, operation, ...input });
    values.push(event);
    while (values.length > NativeLifecycleOperationSessionPolicy.maxProgressEvents) values.shift();
    return event;
  }

  return Object.freeze({
    events: () => Object.freeze([...values]),
    async emit(input) {
      const event = append(input);
      if (sink === undefined) return;
      try { await sink(event); }
      catch {
        if (!deliveryFailureRecorded) {
          deliveryFailureRecorded = true;
          append({ phase: input.phase, state: "failed", ...(input.plugin === undefined ? {} : { plugin: input.plugin }), ...(input.actionId === undefined ? {} : { actionId: input.actionId }), code: "PROGRESS_DELIVERY_FAILED" });
        }
      }
    },
  });
}
