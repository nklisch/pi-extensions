import { describe, expect, it } from "vitest";
import { buildNativeLifecycleConfirmation } from "../../src/application/native-control-lifecycle.js";
import { unavailableNativeControlInput } from "../../src/application/native-control-input.js";

describe("native control lifecycle confirmation", () => {
  it("requires explicit same-preview confirmation before destructive apply", async () => {
    const base = { token: `native-operation-session-v1:123e4567-e89b-42d3-a456-426614174000.${"a".repeat(64)}`, version: 4, state: "previewed", expiresAt: 99, progress: [] };
    const session = { ...base, preview: { previewId: `native-operation-preview-v1:sha256:${"b".repeat(64)}`, operation: "uninstall", admission: "ready", target: {}, diagnostics: [] } };
    await expect(buildNativeLifecycleConfirmation({ executionId: "native-control-execution-v1:123e4567-e89b-42d3-a456-426614174000" as never, input: unavailableNativeControlInput, channel: { kind: "none" }, session: session as never, confirmed: false, persistentData: "keep", signal: new AbortController().signal })).resolves.toEqual({ kind: "input-required" });
    await expect(buildNativeLifecycleConfirmation({ executionId: "native-control-execution-v1:123e4567-e89b-42d3-a456-426614174000" as never, input: unavailableNativeControlInput, channel: { kind: "none" }, session: session as never, confirmed: true, persistentData: "delete-confirmed", signal: new AbortController().signal })).resolves.toMatchObject({ kind: "confirmation", confirmation: { kind: "confirm-uninstall", expectedVersion: 4, persistentData: "delete-confirmed" } });
  });
});
