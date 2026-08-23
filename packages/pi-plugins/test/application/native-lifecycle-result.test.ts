import { describe, expect, it } from "vitest";
import { projectPluginLifecycleResult } from "../../src/application/native-lifecycle-result.js";
import type { GenerationSnapshot } from "../../src/application/state-contract.js";
import type { PluginLifecycleResult } from "../../src/application/plugin-lifecycle-service.js";

const selected = `sha256:${"a".repeat(64)}` as never;
const previous = `sha256:${"b".repeat(64)}` as never;
const previewId = `native-operation-preview-v1:sha256:${"c".repeat(64)}` as never;
const sha256 = (bytes: Uint8Array): Uint8Array => new Uint8Array(32).fill(bytes.length);

function snapshot(withPrevious: boolean): GenerationSnapshot {
  const record = {
    plugin: "demo@community",
    activation: "enabled",
    selectedRevision: selected,
    ...(withPrevious ? { previousRevision: previous } : {}),
    revisions: [
      { revision: selected },
      ...(withPrevious ? [{ revision: previous }] : []),
    ],
  };
  return {
    scope: { kind: "user" },
    generation: 7,
    installed: { plugins: [record] },
  } as unknown as GenerationSnapshot;
}

function result(snapshotValue: GenerationSnapshot, runningRevision?: typeof previous): PluginLifecycleResult {
  return {
    kind: "degraded",
    operation: "update",
    snapshot: snapshotValue,
    failure: { plugin: "demo@community", code: "MCP_MUTATION_OUTCOME_UNKNOWN", explanation: "MCP registration failed" },
    ...(runningRevision === undefined ? {} : { runningRevision }),
  };
}

function project(value: PluginLifecycleResult) {
  return projectPluginLifecycleResult({
    result: value,
    target: {} as never,
    previewId,
    progress: [],
    sha256,
  });
}

describe("native lifecycle degraded repair hints", () => {
  it("suggests rollback when a live previous revision exists but is not running", () => {
    expect(project(result(snapshot(true)))).toMatchObject({ kind: "degraded", repairHint: "rollback" });
  });

  it("suggests both actions when the previous revision is already running", () => {
    expect(project(result(snapshot(true), previous))).toMatchObject({ kind: "degraded", repairHint: "both" });
  });

  it("suggests repair when no previous revision is available", () => {
    expect(project(result(snapshot(false)))).toMatchObject({ kind: "degraded", repairHint: "repair" });
  });
});
