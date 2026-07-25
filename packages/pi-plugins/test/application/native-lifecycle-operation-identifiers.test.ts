import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  createNativeLifecycleOperationToken,
  deriveNativeLifecyclePreviewId,
  deriveProjectIntentObservationId,
  deriveProjectSyncActionId,
  deriveProjectSyncConflictId,
  verifyNativeLifecycleOperationToken,
} from "../../src/application/native-lifecycle-operation-identifiers.js";

const sha256 = (bytes: Uint8Array) => new Uint8Array(createHash("sha256").update(bytes).digest());
const digest = (value: string) => `sha256:${value.repeat(64)}` as never;

describe("native lifecycle operation identifiers", () => {
  it("binds opaque session capabilities to one host epoch", () => {
    const id = "2d6737b6-7482-4a50-9310-cd35ce7ddcad";
    const token = createNativeLifecycleOperationToken(id, digest("1"), sha256);
    expect(verifyNativeLifecycleOperationToken(token, digest("1"), sha256)).toBe(id);
    expect(verifyNativeLifecycleOperationToken(token, digest("2"), sha256)).toBeUndefined();
    expect(token).not.toContain("project");
  });

  it("changes preview identity across every supplied authority dimension", () => {
    const base = {
      hostEpoch: digest("1"), projectEpoch: digest("2"), capability: digest("3"),
      scope: { kind: "user" }, generation: 4, revision: digest("5"), activation: "enabled",
      targetDigest: digest("6"), candidate: digest("7"), file: digest("8"), mode: "merge",
      actions: ["a"], conflicts: ["b"], desired: digest("9"), pending: "absent",
    };
    const original = deriveNativeLifecyclePreviewId(base, sha256);
    for (const [key, value] of Object.entries(base)) {
      const changed = { ...base, [key]: typeof value === "number" ? value + 1 : `${JSON.stringify(value)}-changed` };
      expect(deriveNativeLifecyclePreviewId(changed, sha256)).not.toBe(original);
    }
  });

  it("derives separate opaque observation, action, and conflict namespaces", () => {
    const evidence = { project: digest("a"), value: "same" };
    const ids = [
      deriveProjectIntentObservationId(evidence, sha256),
      deriveProjectSyncActionId(evidence, sha256),
      deriveProjectSyncConflictId(evidence, sha256),
    ];
    expect(new Set(ids).size).toBe(3);
    expect(ids.every((id) => !id.includes("same"))).toBe(true);
  });
});
