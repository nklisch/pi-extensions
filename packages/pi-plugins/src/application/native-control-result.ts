import {
  createNativeControlEnvelope,
  type NativeControlEnvelope,
  type NativeControlExecutionId,
} from "./native-control-contract.js";
import { type NativeControlCommand } from "./native-control-registry.js";
import type { NativeControlDispatchResult } from "./native-control-projection.js";
import { classifyNativeControlError } from "./native-control-error.js";

export interface NativeControlResultProjector {
  project(command: NativeControlCommand, result: NativeControlDispatchResult, executionId: NativeControlExecutionId): NativeControlEnvelope;
  classifyError(command: NativeControlCommand, error: unknown, executionId: NativeControlExecutionId): NativeControlEnvelope;
}

export function createNativeControlResultProjector(): NativeControlResultProjector {
  const projector: NativeControlResultProjector = {
    project(command: NativeControlCommand, result: NativeControlDispatchResult, executionId: NativeControlExecutionId): NativeControlEnvelope {
      return createNativeControlEnvelope({
        executionId,
        command: command.command,
        status: result.status,
        ...(result.data === undefined ? {} : { data: result.data }),
        ...(result.operation === undefined ? {} : { operation: result.operation }),
        ...(result.page === undefined ? {} : { page: result.page }),
        ...(result.exitOverride === undefined ? {} : { exitOverride: result.exitOverride }),
        diagnostics: result.diagnostics,
        human: result.human,
      });
    },
    classifyError(command: NativeControlCommand, error: unknown, executionId: NativeControlExecutionId): NativeControlEnvelope {
      const classification = classifyNativeControlError(error);
      return createNativeControlEnvelope({
        executionId,
        command: command.command,
        status: classification.status,
        diagnostics: [{ code: classification.code, severity: "error", action: classification.action }],
      });
    },
  };
  return Object.freeze(projector);
}
