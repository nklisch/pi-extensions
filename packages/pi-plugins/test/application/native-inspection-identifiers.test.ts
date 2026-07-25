import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  decodeInspectionCursor,
  decodeInspectionDetailId,
  deriveInspectionDetailId,
  deriveInspectionFilterHash,
  deriveInspectionSnapshotId,
  encodeInspectionCursor,
} from "../../src/application/native-inspection-identifiers.js";

const sha256 = (bytes: Uint8Array) => new Uint8Array(createHash("sha256").update(bytes).digest());
const revision = `sha256:${"11".repeat(32)}` as never;
const projectKey = `project-v1:sha256:${"22".repeat(32)}` as never;

describe("native inspection identifiers", () => {
  it("is canonical, scope qualified, and checksum verified", () => {
    const user = deriveInspectionDetailId({ version: 1, subject: "installed", scope: { kind: "user" }, plugin: "demo@market" as never, selectedRevision: revision }, sha256);
    const userAgain = deriveInspectionDetailId({ plugin: "demo@market" as never, selectedRevision: revision, scope: { kind: "user" }, subject: "installed", version: 1 }, sha256);
    const project = deriveInspectionDetailId({ version: 1, subject: "installed", scope: { kind: "project", projectKey }, plugin: "demo@market" as never, selectedRevision: revision }, sha256);
    expect(userAgain).toBe(user);
    expect(project).not.toBe(user);
    expect(decodeInspectionDetailId(user, sha256)).toEqual({ version: 1, subject: "installed", scope: { kind: "user" }, plugin: "demo@market", selectedRevision: revision });
    expect(decodeInspectionDetailId(`${user.slice(0, -1)}0`, sha256)).toBeUndefined();
    expect(user).not.toContain("https:");
    expect(user).not.toContain("/");
  });

  it("separates candidate authority fields", () => {
    const base = {
      version: 1 as const,
      subject: "marketplace-candidate" as const,
      scope: { kind: "user" as const },
      plugin: "demo@market" as never,
      registrationId: `marketplace-registration-v1:sha256:${"33".repeat(32)}` as never,
      candidateId: `marketplace-candidate-v1:sha256:${"44".repeat(32)}` as never,
      catalogSnapshot: `marketplace-snapshot-v1:sha256:${"55".repeat(32)}` as never,
    };
    const first = deriveInspectionDetailId(base, sha256);
    expect(deriveInspectionDetailId({ ...base, catalogSnapshot: `marketplace-snapshot-v1:sha256:${"66".repeat(32)}` as never }, sha256)).not.toBe(first);
  });

  it("binds cursors to exact filters and snapshots", () => {
    const snapshotId = deriveInspectionSnapshotId({ runtime: "a", state: [1, 2] }, sha256);
    expect(snapshotId).toBe(deriveInspectionSnapshotId({ state: [1, 2], runtime: "a" }, sha256));
    const filterHash = deriveInspectionFilterHash({ query: "demo", subjects: ["installed"] }, sha256);
    const cursor = encodeInspectionCursor({ version: 1, snapshotId, filterHash, lastSort: ["installed", "user", "demo"] }, sha256);
    expect(decodeInspectionCursor(cursor, { snapshotId, filterHash }, sha256).kind).toBe("valid");
    expect(decodeInspectionCursor(cursor, { snapshotId: deriveInspectionSnapshotId({ state: [2] }, sha256), filterHash }, sha256).kind).toBe("stale");
    expect(decodeInspectionCursor(cursor, { snapshotId, filterHash: deriveInspectionFilterHash({ query: "other" }, sha256) }, sha256).kind).toBe("stale");
    expect(decodeInspectionCursor(`${cursor.slice(0, -1)}f`, { snapshotId, filterHash }, sha256).kind).toBe("invalid");
  });
});
