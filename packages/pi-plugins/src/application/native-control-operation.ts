import { NativeLifecycleOperationTokenSchema, type NativeLifecycleOperationService } from "./native-lifecycle-operation-contract.js";
import { NativeControlOperationHandleSchema, type NativeControlOperationHandle } from "./native-control-contract.js";
import { TrustedInstallSessionTokenSchema, type TrustedInstallationService } from "./trusted-install-contract.js";

export function parseNativeControlOperationHandle(token: string): NativeControlOperationHandle | undefined {
  if (token.startsWith("trusted-install-session-v1:")) {
    const parsed = TrustedInstallSessionTokenSchema.safeParse(token);
    return parsed.success ? NativeControlOperationHandleSchema.parse({ kind: "trusted-install", token: parsed.data }) : undefined;
  }
  if (token.startsWith("native-operation-session-v1:")) {
    const parsed = NativeLifecycleOperationTokenSchema.safeParse(token);
    return parsed.success ? NativeControlOperationHandleSchema.parse({ kind: "lifecycle", token: parsed.data }) : undefined;
  }
  return undefined;
}

export function createNativeControlOperationRouter(dependencies: Readonly<{
  trustedInstallation: Pick<TrustedInstallationService, "status" | "cancel">;
  operations: Pick<NativeLifecycleOperationService, "status" | "cancel">;
}>) {
  return Object.freeze({
    status(handleInput: NativeControlOperationHandle, signal: AbortSignal) {
      const handle = NativeControlOperationHandleSchema.parse(handleInput);
      return handle.kind === "trusted-install"
        ? dependencies.trustedInstallation.status({ token: handle.token }, signal)
        : dependencies.operations.status({ token: handle.token }, signal);
    },
    cancel(handleInput: NativeControlOperationHandle, signal: AbortSignal) {
      const handle = NativeControlOperationHandleSchema.parse(handleInput);
      return handle.kind === "trusted-install"
        ? dependencies.trustedInstallation.cancel({ token: handle.token }, signal)
        : dependencies.operations.cancel({ token: handle.token }, signal);
    },
  });
}
