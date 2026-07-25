import { describe, expect, it } from "vitest";
import { createNativeControlEnvelope } from "../../src/application/native-control-contract.js";
import { createNativeControlHelp } from "../../src/application/native-control-help.js";
import { nativeControlHumanLines } from "../../src/pi/native-control-human.js";

const executionId = "native-control-execution-v1:123e4567-e89b-42d3-a456-426614174000" as never;

describe("native control human projection", () => {
  it("shows safe result data instead of repeating the command summary", () => {
    const envelope = createNativeControlEnvelope({
      executionId,
      command: "status",
      status: "ok",
      data: {
        status: "ready",
        local: { recovery: "settled", runtime: "reconciled" },
        update: { state: "standby", unresolvedCount: 0, unreadCount: 0, scopes: [] },
        blocked: [],
        capabilities: {
          mcp: { status: "available", explanation: "ready" },
          subagents: { status: "unavailable", explanation: "not composed" },
          piReload: { status: "available", explanation: "ready" },
          secrets: { status: "unavailable", explanation: "not configured" },
        },
      } as never,
    });
    const text = nativeControlHumanLines(envelope).join("\n");
    expect(text).toContain("Host ready · recovery settled · runtime reconciled");
    expect(text).toContain("mcp: available · ready");
    expect(text).not.toContain("Show plugin host status");
  });

  it("renders concise primary help instead of a machine metadata dump", () => {
    const envelope = createNativeControlEnvelope({ executionId, command: "help", status: "ok", data: createNativeControlHelp() as never });
    const text = nativeControlHumanLines(envelope).join("\n");
    expect(text).toContain("add <plugin-key> — Add a plugin");
    expect(text).toContain("remove <plugin-key> — Remove a plugin");
    expect(text).not.toContain("install open");
    expect(text).not.toContain('"commands"');
  });

  it("never dumps raw result JSON for unknown commands", () => {
    const envelope = {
      command: { id: "status", path: ["status"] },
      status: "ok",
      exit: { classification: "success", code: 0 },
      data: { value: `\u001b]52;c;bad\u0007${"x".repeat(100_000)}` },
      human: [],
      diagnostics: [],
    } as never;
    const text = nativeControlHumanLines(envelope).join("\n");
    expect(text.length).toBeLessThan(1_000);
    expect(text).not.toContain("\u001b");
    expect(text).not.toContain('"value"');
    expect(text).toContain("status: ok");
  });

  it("renders lifecycle uninstall results as concise lines instead of JSON", () => {
    const envelope = {
      command: { id: "lifecycle.uninstall", path: ["remove"] },
      status: "ok",
      exit: { classification: "success", code: 0 },
      data: {
        kind: "succeeded",
        operation: "uninstall",
        previewId: "native-operation-preview-v1:sha256:" + "a".repeat(64),
        progress: [],
        diagnostics: [],
        effects: { state: "changed", projectFile: "unchanged", completedActionIds: [], pendingActionIds: [] },
        before: {
          scope: { kind: "user" },
          plugin: "demo@catalog",
          stateGeneration: 3,
          selectedRevision: "sha256:" + "b".repeat(64),
          activation: "enabled",
          targetDigest: "sha256:" + "c".repeat(64),
          inspectionSnapshotId: "inspection-snapshot-v1:sha256:" + "d".repeat(64),
          detailId: "inspection-detail-v1:e30." + "e".repeat(64),
          transition: "none",
        },
        cleanup: { persistentData: "deleted", configuration: "retained", trust: "retained", revisions: "collection-deferred" },
      },
      human: [],
      diagnostics: [],
    } as never;
    const text = nativeControlHumanLines(envelope).join("\n");
    expect(text).toContain("demo@catalog · uninstall · succeeded");
    expect(text).toContain("persistent data deleted");
    expect(text).not.toContain('"kind"');
  });
});
