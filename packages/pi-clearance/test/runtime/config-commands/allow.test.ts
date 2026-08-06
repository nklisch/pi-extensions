import { readFile } from "node:fs/promises";

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";

import { createDefaultAnalyzerRegistry } from "../../../src/parse/registry.ts";
import { getClearanceArgumentCompletions } from "../../../src/runtime/command-registry.ts";
import {
  buildAllowBrief,
  buildStructuralSummary,
  handleAllowCommand,
  MODE_OFF_COPY_CONTRACT,
  selectRecentAllowEntry,
} from "../../../src/runtime/config-commands/allow.ts";
import type {
  AutoReviewerCommandDependencies,
  CommandPi,
  RecentDecisionEntry,
} from "../../../src/runtime/config-commands/types.ts";
import type { ResolvedPolicy } from "../../../src/runtime/policy-cache.ts";

const analyzerRegistry = createDefaultAnalyzerRegistry();

function decision(
  effect: RecentDecisionEntry["effect"],
  overrides: Partial<RecentDecisionEntry> = {},
): RecentDecisionEntry {
  return {
    timestamp: "2026-07-23T00:00:00.000Z",
    entryType: "policy.decision",
    toolName: "bash",
    effect,
    reason: "baseline decision",
    ...overrides,
  };
}

function fakeContext(idle = true): ExtensionCommandContext {
  return {
    hasUI: true,
    cwd: "/repo",
    isIdle: () => idle,
    isProjectTrusted: () => true,
    ui: { notify: () => {} },
  } as unknown as ExtensionCommandContext;
}

function dependencies(
  entries: readonly RecentDecisionEntry[] = [],
  mode: "off" | "ask" | "auto" = "ask",
): AutoReviewerCommandDependencies {
  const config = { mode } as ResolvedPolicy["config"];
  return {
    manager: {} as AutoReviewerCommandDependencies["manager"],
    policyResolver: {
      async resolve() {
        return {
          ok: true,
          policy: { config } as ResolvedPolicy,
        };
      },
      invalidate() {},
    },
    packageRegistration: () => ({
      requestId: null,
      packs: [],
      issues: [],
    }),
    audit: { async log() {} },
    recentDecisionSource: {
      readRecent: () => ({ items: entries, warnings: [] }),
    },
    analyzerRegistry,
  };
}

function fakePi() {
  const calls: { readonly brief: string; readonly options?: unknown }[] = [];
  const pi = {
    getActiveTools: () => [],
    getAllTools: () => [],
    setActiveTools: () => {},
    registerTool: () => {},
    sendMessage: (
      message: { readonly content: unknown; readonly display: boolean },
      options?: unknown,
    ) => {
      calls.push({
        brief: typeof message.content === "string" ? message.content : "",
        ...(options === undefined ? {} : { options }),
      });
      expect(message.display).toBe(true);
    },
  } as unknown as CommandPi;
  return { pi, calls };
}

describe("/clearance allow brief builders", () => {
  it("includes the verbatim free-text request, mode, rules, and batch guidance", () => {
    const brief = buildAllowBrief({
      mode: "ask",
      rawRequest: "pnpm   test and any node test runner",
    });

    expect(brief).toContain("pnpm   test and any node test runner");
    expect(brief).toContain("Current mode: ask.");
    expect(brief).toContain('Draft kind "data-pack-policy"');
    expect(brief).toContain("STRUCTURAL matchers");
    expect(brief).toContain("Never match a raw full-command string");
    expect(brief).toContain("one draft per family in a single");
    expect(brief).toContain("clearance_propose");
    expect(brief).toContain("clearance_present");
  });

  it("adds the exact off-mode copy contract and summary instruction", () => {
    const brief = buildAllowBrief({
      mode: "off",
      rawRequest: "pnpm test",
    });

    expect(brief).toContain(MODE_OFF_COPY_CONTRACT);
    expect(brief).toContain(
      "Prepend that exact sentence to the draft `summary`.",
    );
  });

  it("tells the agent to ask when bounded scan-back finds no recent block", () => {
    const brief = buildAllowBrief({ mode: "auto", noRecentCommand: true });
    expect(brief).toContain("No recent blocked/asked command was found");
    expect(brief).toContain("Ask the user what they'd like to allow");
  });
});

describe("allow structural summaries", () => {
  it("summarizes a clean pnpm family", async () => {
    const shape = await analyzerRegistry.analyze("bash", {
      command: "pnpm test --run",
    });
    const summary = buildStructuralSummary("bash", shape);

    expect(summary.nonBash).toBe(false);
    expect(summary.text).toContain("program `pnpm`");
    expect(summary.text).toContain("subcommand `test`");
    expect(summary.text).toContain("stages: 1 joined by none");
    expect(summary.text).toContain("substitution: no");
    expect(summary.text).toContain("stdout redirect: no");
    expect(summary.text).toContain("parse diagnostics: none");
  });

  it("exposes substitution, pipeline, and redirect risk flags", async () => {
    const substitution = await analyzerRegistry.analyze("bash", {
      command: "cat $(ls)",
    });
    const pipeline = await analyzerRegistry.analyze("bash", {
      command: "foo | sh",
    });
    const redirect = await analyzerRegistry.analyze("bash", {
      command: "cmd > out",
    });

    expect(buildStructuralSummary("bash", substitution).text).toContain(
      "substitution: yes",
    );
    expect(buildStructuralSummary("bash", pipeline).text).toContain(
      "joined by pipe",
    );
    expect(buildStructuralSummary("bash", redirect).text).toContain(
      "stdout redirect: yes",
    );
  });

  it("degrades non-bash input to tool name and raw input", async () => {
    const shape = await analyzerRegistry.analyze("edit", {
      path: "src/example.ts",
      edits: [],
    });
    const summary = buildStructuralSummary("edit", shape);

    expect(summary.nonBash).toBe(true);
    expect(summary.text).toContain("non-bash tool `edit`");
    expect(summary.text).toContain("src/example.ts");
  });
});

describe("allow recent selection and handoff", () => {
  it("scans back to the latest usable blocked or asked entry", () => {
    const result = selectRecentAllowEntry([
      decision("allow", { command: "pnpm test" }),
      decision("review", { command: "npm test" }),
    ]);
    expect(result).toMatchObject({ kind: "entry", index: 1 });
  });

  it("refuses a floor denial", () => {
    const result = selectRecentAllowEntry([
      decision("deny", {
        command: "rm -rf /",
        provenance: { ruleId: "floor:system-root-deletion" },
      }),
    ]);
    expect(result).toMatchObject({ kind: "floor-refusal", index: 0 });
  });

  it("returns no recent context after the bounded scan", () => {
    const result = selectRecentAllowEntry(
      Array.from({ length: 6 }, () => decision("allow", { command: "true" })),
    );
    expect(result).toEqual({ kind: "none", scanned: 5 });
  });

  it("hands free-text requests to an idle agent with no delivery override", async () => {
    const { pi, calls } = fakePi();
    const report = await handleAllowCommand(
      ["pnpm", "test"],
      fakeContext(true),
      pi,
      dependencies(),
      "pnpm   test",
    );

    expect(report.level).toBe("info");
    expect(report.summary).toContain("Request handed to the agent");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.brief).toContain("pnpm   test");
    expect(calls[0]?.options).toEqual({ triggerTurn: true });
  });

  it("queues the brief as a follow-up while the agent is busy", async () => {
    const { pi, calls } = fakePi();
    await handleAllowCommand(
      ["pnpm", "test"],
      fakeContext(false),
      pi,
      dependencies(),
    );

    expect(calls[0]?.options).toEqual({ deliverAs: "followUp" });
  });

  it("builds a family summary for the recent blocked command", async () => {
    const { pi, calls } = fakePi();
    await handleAllowCommand(
      [],
      fakeContext(),
      pi,
      dependencies([decision("deny", { command: "pnpm test --run" })]),
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]?.brief).toContain(
      "Most recent blocked/asked command (selected by bounded scan-back)",
    );
    expect(calls[0]?.brief).toContain("program `pnpm`; subcommand `test`");
    expect(calls[0]?.brief).toContain("stages: 1 joined by none");
  });

  it("hands no-argument requests to the agent when no block is recent", async () => {
    const { pi, calls } = fakePi();
    const report = await handleAllowCommand(
      [],
      fakeContext(),
      pi,
      dependencies(),
    );

    expect(report.details).toMatchObject({ form: "no-recent-command" });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.brief).toContain("Ask the user what they'd like to allow");
  });

  it("refuses floor no-argument requests without handing them off", async () => {
    const { pi, calls } = fakePi();
    const report = await handleAllowCommand(
      [],
      fakeContext(),
      pi,
      dependencies([
        decision("deny", {
          command: "rm -rf /",
          provenance: { ruleId: "floor:system-root-deletion" },
        }),
      ]),
    );

    expect(report.level).toBe("error");
    expect(calls).toHaveLength(0);
  });
});

describe("allow command registration and boundary", () => {
  it("offers allow at the first level but no free-text completions", () => {
    const deps = dependencies();
    expect(getClearanceArgumentCompletions("all", deps)).toEqual([
      expect.objectContaining({ value: "allow" }),
    ]);
    expect(getClearanceArgumentCompletions("allow ", deps)).toEqual([]);
    expect(getClearanceArgumentCompletions("allow p", deps)).toBeNull();
  });

  it("does not import reviewer-model or writer modules", async () => {
    const source = await readFile(
      new URL("../../../src/runtime/config-commands/allow.ts", import.meta.url),
      "utf8",
    );
    const imports = [...source.matchAll(/from\s+["']([^"']+)["']/gu)].map(
      (match) => match[1],
    );
    expect(imports.join("\n")).not.toMatch(/reviewer|writer/u);
  });
});
