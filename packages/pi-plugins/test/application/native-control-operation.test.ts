import { describe, expect, it, vi } from "vitest";
import { createNativeControlOperationRouter, parseNativeControlOperationHandle } from "../../src/application/native-control-operation.js";

const trusted = `trusted-install-session-v1:123e4567-e89b-42d3-a456-426614174000.${"a".repeat(64)}`;
const lifecycle = `native-operation-session-v1:123e4567-e89b-42d3-a456-426614174000.${"b".repeat(64)}`;

describe("native control operation routing", () => {
  it("validates owner token schemas and never falls back", async () => {
    expect(parseNativeControlOperationHandle(trusted)).toEqual({ kind: "trusted-install", token: trusted });
    expect(parseNativeControlOperationHandle(lifecycle)).toEqual({ kind: "lifecycle", token: lifecycle });
    expect(parseNativeControlOperationHandle("trusted-install-session-v1:forged")).toBeUndefined();
    expect(parseNativeControlOperationHandle("unknown")).toBeUndefined();

    const installStatus = vi.fn(async () => ({ kind: "missing" as const }));
    const lifecycleStatus = vi.fn(async () => ({ kind: "missing" as const }));
    const router = createNativeControlOperationRouter({ trustedInstallation: { status: installStatus, cancel: vi.fn() } as never, operations: { status: lifecycleStatus, cancel: vi.fn() } as never });
    await router.status(parseNativeControlOperationHandle(trusted)!, new AbortController().signal);
    expect(installStatus).toHaveBeenCalledOnce();
    expect(lifecycleStatus).not.toHaveBeenCalled();
  });
});
