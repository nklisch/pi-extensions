import { describe, expect, it, vi } from "vitest";
import { createNativeControlEnvelope } from "../../../src/application/native-control-contract.js";
import type { NativeControlFrameSink } from "../../../src/application/ports/native-control-execution.js";
import { createPluginManagerActionRunner } from "../../../src/pi/manager/plugin-manager-actions.js";
import type { PluginManagerRow } from "../../../src/pi/manager/plugin-manager-model.js";

const executionId = "native-control-execution-v1:123e4567-e89b-42d3-a456-426614174000" as never;
const snapshotId = `inspection-snapshot-v1:sha256:${"a".repeat(64)}`;
const detailId = `inspection-detail-v1:YWJj.${"b".repeat(64)}`;
const row: PluginManagerRow = {
  key: { subject: "installed", key: "user:demo@market", snapshotId, detailId },
  title: "demo",
  subtitle: "market · user",
  status: "ready",
  scope: "user",
  plugin: "demo@market",
  completion: { category: "plugin", value: "demo@market", safe: { text: "demo", escaped: false, truncated: false } },
  data: {},
};

function result(status: "ok" | "stale" | "cancelled" = "ok") {
  return createNativeControlEnvelope({ executionId, command: "lifecycle.enable", status });
}

const confirmed = async () => true;
const marketplaceRow: PluginManagerRow = { ...row, key: { subject: "marketplace", key: "registration-1" } };

describe("plugin manager action runner", () => {
  it("runs an explicit reversible action without a second prompt and streams ordered frames", async () => {
    const frames: unknown[] = [];
    const execute = vi.fn(async (argv: readonly string[], options: { sink: NativeControlFrameSink }, signal: AbortSignal) => {
      await options.sink.write({ schemaVersion: 1, type: "accepted", executionId, sequence: 0, command: "lifecycle.enable" }, signal);
      await options.sink.write({ schemaVersion: 1, type: "progress", executionId, sequence: 1, phase: "activation-transaction", state: "started", safe: [] }, signal);
      const envelope = result();
      await options.sink.write({ schemaVersion: 1, type: "result", executionId, sequence: 2, result: envelope }, signal);
      return { envelope, delivery: "complete" as const, deliveredThrough: 2 };
    });
    const confirm = vi.fn(confirmed);
    const runner = createPluginManagerActionRunner({ execute, confirm, onFrame: (frame) => frames.push(frame) });
    await expect(runner.run({ action: "enable", row })).resolves.toMatchObject({ kind: "completed", presentation: "local", envelope: { status: "ok" } });
    expect(confirm).not.toHaveBeenCalled();
    expect(execute).toHaveBeenCalledWith([
      "enable", "demo@market", "--scope", "user", "--snapshot-id", snapshotId, "--detail-id", detailId, "--yes",
    ], expect.objectContaining({ sink: expect.any(Object) }), expect.any(AbortSignal));
    expect(frames.map((frame: any) => frame.sequence)).toEqual([0, 1, 2]);
  });

  it.each([
    { action: "uninstall-delete", row },
    { action: "marketplace-remove", row: marketplaceRow },
    { action: "project-sync", mode: "apply-intent" },
  ] as const)("cancels fresh $action confirmation with zero facade mutation", async (intent) => {
    const execute = vi.fn();
    const runner = createPluginManagerActionRunner({ execute, confirm: async () => false });
    await expect(runner.run(intent)).resolves.toEqual({ kind: "cancelled", presentation: "local" });
    expect(execute).not.toHaveBeenCalled();
  });

  it.each([
    [{ action: "uninstall-delete", row }, ["remove", "demo@market", "--scope", "user", "--snapshot-id", snapshotId, "--detail-id", detailId, "--yes", "--delete-data"]],
    [{ action: "marketplace-remove", row: marketplaceRow }, ["marketplace", "remove", "registration-1", "--yes"]],
    [{ action: "project-sync", mode: "apply-intent" }, ["project", "sync", "--mode", "apply-intent", "--yes"]],
  ] as const)("executes confirmed destructive intent %# with exact facade argv", async (intent, expectedArgv) => {
    const execute = vi.fn(async () => ({ envelope: result(), delivery: "complete" as const, deliveredThrough: -1 }));
    const confirm = vi.fn(confirmed);
    const runner = createPluginManagerActionRunner({ execute, confirm });
    await runner.run(intent);
    expect(confirm).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledWith(expectedArgv, expect.objectContaining({ sink: expect.any(Object) }), expect.any(AbortSignal));
  });

  it("updates all eligible notices through the bounded batch facade command", async () => {
    const execute = vi.fn(async () => ({ envelope: result(), delivery: "complete" as const, deliveredThrough: -1 }));
    const runner = createPluginManagerActionRunner({ execute });
    await runner.run({ action: "update-all" });
    expect(execute).toHaveBeenCalledWith(["updates", "automatic", "run", "--limit", "100", "--explicit"], expect.objectContaining({ sink: expect.any(Object) }), expect.any(AbortSignal));
  });

  it("runs host diagnostics through the concise doctor command without confirmation", async () => {
    const execute = vi.fn(async () => ({ envelope: result(), delivery: "complete" as const, deliveredThrough: -1 }));
    const confirm = vi.fn(confirmed);
    const runner = createPluginManagerActionRunner({ execute, confirm });
    await runner.run({ action: "diagnose-host" });
    expect(confirm).not.toHaveBeenCalled();
    expect(execute).toHaveBeenCalledWith(["doctor"], expect.objectContaining({ sink: expect.any(Object) }), expect.any(AbortSignal));
  });

  it("adds a marketplace source through the registry-owned facade path without confirmation", async () => {
    const execute = vi.fn(async () => ({ envelope: result(), delivery: "complete" as const, deliveredThrough: -1 }));
    const confirm = vi.fn(confirmed);
    const runner = createPluginManagerActionRunner({ execute, confirm });
    await runner.run({ action: "marketplace-add", source: "owner/repository" });
    expect(confirm).not.toHaveBeenCalled();
    expect(execute).toHaveBeenCalledWith(["marketplace", "add", "owner/repository"], expect.objectContaining({ sink: expect.any(Object) }), expect.any(AbortSignal));

    await runner.run({ action: "marketplace-add", source: "/plugins", sourceKind: "local-git", ref: "main" });
    expect(execute).toHaveBeenLastCalledWith(["marketplace", "add", "/plugins", "--source-kind", "local-git", "--ref", "main"], expect.objectContaining({ sink: expect.any(Object) }), expect.any(AbortSignal));
  });

  it("routes workflow recovery through the public install recover command", async () => {
    const token = `trusted-install-session-v1:123e4567-e89b-42d3-a456-426614174000.${"a".repeat(64)}`;
    const execute = vi.fn(async () => ({ envelope: result(), delivery: "complete" as const, deliveredThrough: -1 }));
    const runner = createPluginManagerActionRunner({ execute });
    await runner.run({ action: "install-recover", token });
    expect(execute).toHaveBeenCalledWith(["install", "recover", token], expect.objectContaining({ sink: expect.any(Object) }), expect.any(AbortSignal));
  });

  it("sends one abort and waits for stronger owner cancellation result", async () => {
    let aborts = 0;
    const execute = vi.fn(async (_argv: readonly string[], _options: unknown, signal: AbortSignal) => {
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => { aborts += 1; resolve(); }, { once: true }));
      return { envelope: result("cancelled"), delivery: "complete" as const, deliveredThrough: -1 };
    });
    const runner = createPluginManagerActionRunner({ execute, confirm: confirmed });
    const pending = runner.run({ action: "enable", row });
    await Promise.resolve();
    runner.cancel();
    runner.cancel();
    await expect(pending).resolves.toMatchObject({ kind: "completed", envelope: { status: "cancelled" } });
    expect(aborts).toBe(1);
  });

  it("refreshes stale authority without replaying the mutation", async () => {
    const onStale = vi.fn();
    const execute = vi.fn(async () => ({ envelope: result("stale"), delivery: "complete" as const, deliveredThrough: -1 }));
    const runner = createPluginManagerActionRunner({ execute, confirm: confirmed, onStale });
    await runner.run({ action: "enable", row });
    expect(execute).toHaveBeenCalledOnce();
    expect(onStale).toHaveBeenCalledWith(expect.objectContaining({ status: "stale" }));
  });

  it("detaches an admitted activating mutation on reload so its successor result remains live", async () => {
    let resolve!: () => void;
    const handoff = {
      open: vi.fn(() => ({ id: "ticket" })),
      publish: vi.fn(() => "successor"),
      fail: vi.fn(),
    } as any;
    const execute = vi.fn(async () => {
      await new Promise<void>((done) => { resolve = done; });
      return { envelope: result(), delivery: "complete" as const, deliveredThrough: -1 };
    });
    const runner = createPluginManagerActionRunner({ execute, confirm: confirmed, handoff, session: { sessionId: "s1", cwd: "/workspace" } });
    const pending = runner.run({ action: "enable", row });
    await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
    runner.close("reload");
    resolve();
    await expect(pending).resolves.toMatchObject({ kind: "completed", presentation: "successor" });
    expect(handoff.open).toHaveBeenCalledWith({ sessionId: "s1", cwd: "/workspace", destination: "operation-result" });
    expect(handoff.publish).toHaveBeenCalledWith({ id: "ticket" }, expect.objectContaining({
      envelope: expect.objectContaining({ status: "ok" }),
      delivery: "complete",
      deliveredThrough: -1,
    }));
  });

  it("serializes foreground mutations", async () => {
    let resolve!: () => void;
    const execute = vi.fn(async () => { await new Promise<void>((done) => { resolve = done; }); return { envelope: result(), delivery: "complete" as const, deliveredThrough: -1 }; });
    const runner = createPluginManagerActionRunner({ execute, confirm: confirmed });
    const first = runner.run({ action: "enable", row });
    await Promise.resolve();
    await expect(runner.run({ action: "disable", row })).rejects.toThrow(/already running/);
    resolve();
    await first;
  });
});
