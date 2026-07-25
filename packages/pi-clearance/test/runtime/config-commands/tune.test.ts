import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";

import { createDefaultAnalyzerRegistry } from "../../../src/parse/registry.ts";
import { handleTuneCommand } from "../../../src/runtime/config-commands/tune.ts";
import {
  formatTuneCueStatus,
  updateTuneActiveCue,
} from "../../../src/runtime/config-commands/tune-cue.ts";
import type {
  AutoReviewerCommandDependencies,
  CommandPi,
} from "../../../src/runtime/config-commands/types.ts";
import type {
  RatchetModeManager,
  RatchetModeResult,
  RatchetModeStatus,
  RatchetToolDefinition,
} from "../../../src/runtime/ratchet-mode.ts";
import { createAuditLogRecentDecisionSource } from "../../../src/runtime/reviewer-context-adapter.ts";

type EnterRatchetModePi = Parameters<RatchetModeManager["enterRatchetMode"]>[0];
type ExitRatchetModePi = Parameters<RatchetModeManager["exitRatchetMode"]>[0];

const INACTIVE_STATUS: RatchetModeStatus = {
  active: false,
  previousActiveTools: [],
  ratchetToolNames: ["clearance_status", "clearance_replay_proposal"],
};

const ACTIVE_STATUS: RatchetModeStatus = {
  active: true,
  previousActiveTools: ["bash"],
  ratchetToolNames: ["clearance_status", "clearance_replay_proposal"],
};

class FakeRatchetModeManager implements RatchetModeManager {
  readonly enterCalls: EnterRatchetModePi[] = [];
  readonly exitCalls: ExitRatchetModePi[] = [];
  status: RatchetModeStatus = INACTIVE_STATUS;
  enterResult: RatchetModeResult = {
    ok: true,
    status: ACTIVE_STATUS,
    message: "Ratchet mode is on; activated 2 ratchet tools.",
  };
  exitResult: RatchetModeResult = {
    ok: true,
    status: INACTIVE_STATUS,
    message: "Ratchet mode is off; restored previous tools.",
  };

  isRatchetActive(): boolean {
    return this.status.active;
  }

  getStatus(): RatchetModeStatus {
    return this.status;
  }

  registerRatchetTool(_tool: RatchetToolDefinition): void {}

  enterRatchetMode(pi: EnterRatchetModePi): RatchetModeResult {
    this.enterCalls.push(pi);
    this.status = this.enterResult.status;
    return this.enterResult;
  }

  exitRatchetMode(pi: ExitRatchetModePi): RatchetModeResult {
    this.exitCalls.push(pi);
    this.status = this.exitResult.status;
    return this.exitResult;
  }
}

type FakeContext = ExtensionCommandContext & {
  readonly __statusCalls: (readonly [string, string | undefined])[];
};

function fakeContext(
  options: {
    readonly hasUI?: boolean;
    readonly includeSetStatus?: boolean;
    readonly throwSetStatus?: boolean;
  } = {},
): FakeContext {
  const statusCalls: (readonly [string, string | undefined])[] = [];
  const ui: Record<string, unknown> = {
    notify: () => {},
    confirm: async () => false,
    select: async () => undefined,
  };

  if (options.includeSetStatus === true) {
    ui.setStatus = (key: string, value: string | undefined): void => {
      if (options.throwSetStatus === true) throw new Error("status failed");
      statusCalls.push([key, value]);
    };
  }

  return {
    hasUI: options.hasUI ?? false,
    cwd: "/repo",
    isProjectTrusted: () => true,
    ui,
    __statusCalls: statusCalls,
  } as unknown as FakeContext;
}

function fakePi(): CommandPi {
  return {
    getActiveTools: () => [],
    getAllTools: () => [],
    setActiveTools: () => {},
    registerTool: () => {},
    sendUserMessage: () => {},
  } as unknown as CommandPi;
}

function dependencies(
  manager: FakeRatchetModeManager,
): AutoReviewerCommandDependencies {
  return {
    manager,
    policyResolver: {
      async resolve() {
        throw new Error("policy resolver should not be called by tune");
      },
      invalidate() {},
    },
    packageRegistration: () => ({
      requestId: null,
      packs: [],
      issues: [],
    }),
    audit: { async log() {} },
    recentDecisionSource: createAuditLogRecentDecisionSource(),
    analyzerRegistry: createDefaultAnalyzerRegistry(),
  };
}

function setup(options: { readonly active?: boolean } = {}) {
  const manager = new FakeRatchetModeManager();
  manager.status = options.active === true ? ACTIVE_STATUS : INACTIVE_STATUS;
  return { manager, deps: dependencies(manager), pi: fakePi() };
}

describe("formatTuneCueStatus", () => {
  it("formats the concrete Tune active-state label", () => {
    expect(formatTuneCueStatus(true)).toBe("Tune active");
    expect(formatTuneCueStatus(false)).toBe("Tune inactive");
  });
});

describe("updateTuneActiveCue", () => {
  it("reads the manager on every call and does not keep a second cache", () => {
    const { manager, deps } = setup();
    const ctx = fakeContext({ hasUI: true, includeSetStatus: true });

    let cue = updateTuneActiveCue(ctx, deps);
    expect(cue).toEqual({
      kind: "status",
      active: false,
      key: "clearance-tune",
      label: undefined,
    });

    manager.status = ACTIVE_STATUS;
    cue = updateTuneActiveCue(ctx, deps);

    expect(cue).toEqual({
      kind: "status",
      active: true,
      key: "clearance-tune",
      label: "Tune active",
    });
    expect(ctx.__statusCalls).toEqual([
      ["clearance-tune", undefined],
      ["clearance-tune", "Tune active"],
    ]);
  });
});

describe("handleTuneCommand", () => {
  it("toggles on when Tune is inactive", () => {
    const { manager, deps, pi } = setup();
    const ctx = fakeContext({ hasUI: true, includeSetStatus: true });

    const report = handleTuneCommand([], ctx, pi, deps);

    expect(manager.enterCalls).toEqual([pi]);
    expect(manager.exitCalls).toEqual([]);
    expect(report.title).toBe("Tune mode enabled");
    expect(report.summary).toContain("Tune mode is on");
    expect(report.summary).toContain(
      "clearance_status, clearance_replay_proposal",
    );
    expect(report.details).toMatchObject({
      action: "toggle",
      status: { active: true },
      toolNames: ["clearance_status", "clearance_replay_proposal"],
      cue: { kind: "status", active: true, label: "Tune active" },
    });
  });

  it("toggles off when Tune is active", () => {
    const { manager, deps, pi } = setup({ active: true });
    const ctx = fakeContext({ hasUI: true, includeSetStatus: true });

    const report = handleTuneCommand([], ctx, pi, deps);

    expect(manager.enterCalls).toEqual([]);
    expect(manager.exitCalls).toEqual([pi]);
    expect(report.title).toBe("Tune mode disabled");
    expect(report.summary).toContain("Tune mode is off");
    expect(report.markdown).toContain("# Tune mode off");
    expect(report.details).toMatchObject({
      action: "toggle",
      status: { active: false },
      cue: { kind: "status", active: false, label: undefined },
    });
  });

  it("accepts explicit hidden on and off forms", () => {
    const on = setup();
    const onReport = handleTuneCommand(["on"], fakeContext(), on.pi, on.deps);
    expect(on.manager.enterCalls).toEqual([on.pi]);
    expect(onReport.details).toMatchObject({ action: "on" });

    const off = setup({ active: true });
    const offReport = handleTuneCommand(
      ["off"],
      fakeContext(),
      off.pi,
      off.deps,
    );
    expect(off.manager.exitCalls).toEqual([off.pi]);
    expect(offReport.details).toMatchObject({ action: "off" });
  });

  it("reports already-on and already-off semantics for explicit forms", () => {
    const alreadyOn = setup({ active: true });
    alreadyOn.manager.enterResult = {
      ok: true,
      status: ACTIVE_STATUS,
      message: "Ratchet mode is already on.",
    };
    const onReport = handleTuneCommand(
      ["on"],
      fakeContext(),
      alreadyOn.pi,
      alreadyOn.deps,
    );
    expect(onReport.title).toBe("Tune mode already on");
    expect(onReport.summary).toContain("already on");
    expect(alreadyOn.manager.exitCalls).toEqual([]);

    const alreadyOff = setup();
    alreadyOff.manager.exitResult = {
      ok: true,
      status: INACTIVE_STATUS,
      message: "Ratchet mode is already off.",
    };
    const offReport = handleTuneCommand(
      ["off"],
      fakeContext(),
      alreadyOff.pi,
      alreadyOff.deps,
    );
    expect(offReport.title).toBe("Tune mode already off");
    expect(offReport.summary).toContain("already off");
    expect(alreadyOff.manager.enterCalls).toEqual([]);
  });

  it("returns a usage report for invalid tokens", () => {
    const { manager, deps, pi } = setup();

    const report = handleTuneCommand(["maybe"], fakeContext(), pi, deps);

    expect(report.level).toBe("error");
    expect(report.markdown).toContain("Expected `tune`");
    expect(manager.enterCalls).toEqual([]);
    expect(manager.exitCalls).toEqual([]);
  });

  it("keeps drift fallback warnings at warning level", () => {
    const { manager, deps, pi } = setup({ active: true });
    manager.exitResult = {
      ok: true,
      status: INACTIVE_STATUS,
      message:
        "Ratchet mode is off; active tools changed, so ratchet tools were removed without exact restore.",
      fallback: {
        kind: "tools-changed",
        restored: ["bash", "edit"],
        expected: ["bash", "clearance_status"],
        actual: ["bash", "clearance_status", "edit"],
        message:
          "Active tools changed while ratchet mode was on; removed ratchet tools and preserved current non-ratchet tools.",
      },
    };

    const report = handleTuneCommand(["off"], fakeContext(), pi, deps);

    expect(report.level).toBe("warning");
    expect(report.details).toMatchObject({
      result: { fallback: { kind: "tools-changed" } },
    });
    expect(report.markdown).toContain(
      "Warning: Active tools changed while ratchet mode was on",
    );
    expect(report.markdown).toContain(
      "Expected active tools: bash, clearance_status",
    );
    expect(report.markdown).toContain(
      "Actual active tools: bash, clearance_status, edit",
    );
    expect(report.markdown).toContain("Restored tools: bash, edit");
  });

  it("uses report text as the no-chrome fallback without claiming a visual cue", () => {
    const { deps, pi } = setup();
    const ctx = fakeContext({ hasUI: true, includeSetStatus: false });

    const report = handleTuneCommand(["on"], ctx, pi, deps);

    expect(report.details).toMatchObject({
      cue: { kind: "none", reason: "chrome-unavailable", active: true },
    });
    expect(report.markdown).toContain("Tune mode on");
    expect(report.markdown).not.toContain("visual cue");
    expect(report.markdown).not.toContain("input chrome");
    expect(ctx.__statusCalls).toEqual([]);
  });
});
