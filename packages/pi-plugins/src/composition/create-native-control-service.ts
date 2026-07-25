import { createNativePluginControlService, type ManagedNativePluginControlService } from "../application/native-control-service.js";
import type { NativeControlApplicationDependencies } from "../application/ports/native-control-applications.js";
import type { NativeControlExecutionIdPort, NativeControlTimeoutPort } from "../application/ports/native-control-execution.js";

/** Composition-only factory; application construction performs no I/O. */
export function createNativeControlService(input: Readonly<{
  applications: NativeControlApplicationDependencies;
  ids: NativeControlExecutionIdPort;
  timeouts: NativeControlTimeoutPort;
}>): ManagedNativePluginControlService {
  return createNativePluginControlService(input);
}
