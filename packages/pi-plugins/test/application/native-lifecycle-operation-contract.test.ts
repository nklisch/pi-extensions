import { describe, expect, it } from "vitest";
import {
  NativeLifecycleEffectSchema,
  NativeLifecycleOperationConfirmationSchema,
  NativeLifecycleOperationRequestSchema,
  NativeLifecycleOperationResultSchema,
  NativeLifecycleOperationTokenSchema,
} from "../../src/application/native-lifecycle-operation-contract.js";
import { SensitiveValue } from "../../src/application/sensitive-value.js";

const digest = (value: string) => `sha256:${value.repeat(64)}`;
const previewId = `native-operation-preview-v1:sha256:${"1".repeat(64)}`;

describe("native lifecycle operation contract", () => {
  it("keeps request and confirmation variants strict and paired", () => {
    const target = {
      inspectionSnapshotId: `inspection-snapshot-v1:sha256:${"2".repeat(64)}`,
      detailId: `inspection-detail-v1:e30.${"3".repeat(64)}`,
    };
    expect(NativeLifecycleOperationRequestSchema.safeParse({ operation: "enable", target }).success).toBe(true);
    expect(NativeLifecycleOperationRequestSchema.safeParse({ operation: "enable", target, candidate: target }).success).toBe(false);
    expect(NativeLifecycleOperationConfirmationSchema.safeParse({ kind: "confirm", previewId, expectedVersion: 0, operation: "uninstall" }).success).toBe(false);
    expect(NativeLifecycleOperationConfirmationSchema.safeParse({
      kind: "confirm-update",
      previewId,
      expectedVersion: 0,
      input: {
        nonSensitive: [],
        sensitive: [{ key: "TOKEN", value: SensitiveValue.fromUnknown("CANARY_SECRET") }],
        consent: { kind: "grant", consentId: `trusted-install-consent-v1:sha256:${"4".repeat(64)}` },
        authority: { configurationRevision: null, trustFingerprint: digest("7") },
      },
    }).success).toBe(true);
    expect(NativeLifecycleOperationConfirmationSchema.safeParse({
      kind: "confirm-project-sync",
      previewId,
      expectedVersion: 0,
      resolutions: [
        { conflictId: `project-sync-conflict-v1:sha256:${"5".repeat(64)}`, choose: "file" },
        { conflictId: `project-sync-conflict-v1:sha256:${"5".repeat(64)}`, choose: "machine" },
      ],
    }).success).toBe(false);
  });

  it("rejects forged tokens and contradictory effect/result evidence", () => {
    const token = `native-operation-session-v1:2d6737b6-7482-4a50-9310-cd35ce7ddcad.${"a".repeat(64)}`;
    expect(NativeLifecycleOperationTokenSchema.safeParse(token).success).toBe(true);
    expect(NativeLifecycleOperationTokenSchema.safeParse(`${token}0`).success).toBe(false);
    expect(NativeLifecycleEffectSchema.safeParse({
      state: "unchanged",
      projectFile: "written",
      completedActionIds: [],
      pendingActionIds: [],
    }).success).toBe(false);
    expect(NativeLifecycleOperationResultSchema.safeParse({
      kind: "succeeded",
      operation: "project-sync",
      previewId,
      progress: [],
      diagnostics: [],
      effects: { state: "changed", projectFile: "unchanged", completedActionIds: [], pendingActionIds: [] },
      before: { root: "/CANARY_PATH" },
      syncDigest: digest("6"),
    }).success).toBe(false);
  });
});
