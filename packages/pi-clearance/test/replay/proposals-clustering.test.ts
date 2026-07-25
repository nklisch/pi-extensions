import { describe, expect, it, vi } from "vitest";

import type { BashStage, ToolShape } from "../../src/parse/shape.ts";
import { clusterFriction } from "../../src/replay/proposals.ts";
import type {
  CapturedOutcomeLabel,
  PerCommandRow,
  RatchetReport,
  ReplayBashParser,
} from "../../src/replay/ratchet.ts";

function commandShape(options: {
  readonly command: string;
  readonly program: string;
  readonly args?: readonly string[];
  readonly flags?: readonly string[];
  readonly substitution?: boolean;
  readonly stdoutRedirect?: boolean;
  readonly diagnostics?: readonly string[];
}): ToolShape {
  const stage: BashStage = {
    kind: "command",
    program: {
      program: options.program,
      resolvable: true,
      arguments: options.args ?? [],
      flags: (options.flags ?? []).map((flag, index) => ({
        raw: flag,
        name: flag.replace(/^-+/, ""),
        short: !flag.startsWith("--"),
        span: { start: index, end: index + flag.length },
      })),
      environment: [],
      span: { start: 0, end: options.program.length },
    },
    substitutions: options.substitution
      ? [
          {
            kind: "command",
            raw: "$(pwd)",
            span: { start: 0, end: 6 },
          },
        ]
      : [],
    redirects: options.stdoutRedirect
      ? [
          {
            stream: "stdout",
            targetKind: "file",
            target: "out.txt",
            append: false,
            span: { start: 0, end: 1 },
          },
        ]
      : [],
    span: { start: 0, end: options.command.length },
  };

  return {
    kind: "bash",
    rawCommand: options.command,
    blocks: [
      {
        pipeline: {
          stages: [stage],
          pipeTargets: [],
          span: { start: 0, end: options.command.length },
        },
        span: { start: 0, end: options.command.length },
      },
    ],
    stages: [stage],
    diagnostics: (options.diagnostics ?? []).map((message) => ({
      code: "test:diagnostic",
      message,
      severity: "error" as const,
    })),
  };
}

function shapeFromCommand(command: string): ToolShape {
  const [program = "", ...rest] = command.trim().split(/\s+/);
  const args = rest.filter((part) => !part.startsWith("-"));
  const flags = rest.filter((part) => part.startsWith("-"));
  return commandShape({ command, program, args, flags });
}

function parserFor(
  overrides: ReadonlyMap<string, ToolShape | Error> = new Map(),
): ReplayBashParser {
  return async (command) => {
    const override = overrides.get(command);
    if (override instanceof Error) {
      throw override;
    }
    return override ?? shapeFromCommand(command);
  };
}

function outcomes(
  entries: readonly [CapturedOutcomeLabel, number][] = [],
): ReadonlyMap<CapturedOutcomeLabel, number> {
  return new Map(entries);
}

function row(overrides: Partial<PerCommandRow>): PerCommandRow {
  return {
    command: "git status",
    count: 1,
    toolName: "bash",
    executable: "git",
    status: "review",
    reason: "test friction",
    capturedOutcomes: outcomes(),
    fidelity: "high",
    sources: ["session"],
    ...overrides,
  };
}

function report(rows: readonly PerCommandRow[]): RatchetReport {
  return {
    generatedAt: "2026-06-25T12:00:00.000Z",
    corpus: {
      totalCalls: rows.reduce((sum, item) => sum + item.count, 0),
      totalUnique: rows.length,
      sources: new Map([
        ["session", rows.length],
        ["audit", 0],
        ["corpus", 0],
      ]),
      unmatchedAuditEntries: 0,
      warnings: [],
    },
    summary: {
      totalCalls: rows.reduce((sum, item) => sum + item.count, 0),
      totalUnique: rows.length,
      fastPathCalls: 0,
      fastPathUnique: 0,
      reviewCalls: rows.filter((item) => item.status === "review").length,
      reviewUnique: rows.filter((item) => item.status === "review").length,
      hardBlockCalls: rows.filter((item) => item.status === "hard_block")
        .length,
      hardBlockUnique: rows.filter((item) => item.status === "hard_block")
        .length,
      byCapturedOutcome: new Map(),
      modelReviewLoad: { calls: 0, unique: 0 },
      redactedCalls: 0,
    },
    topReviewedExecutables: [],
    topFastPathExecutables: [],
    topReviewedCommands: [],
    topHardBlockedCommands: [],
    topContentiousFamilies: [],
    topUnknownTools: [],
    perCommand: rows,
  };
}

describe("proposal friction clustering", () => {
  it("clusters review and hard-block rows by executable and parsed arg0", async () => {
    const parse = vi.fn(parserFor());
    const clusters = await clusterFriction(
      report([
        row({ command: "git status --short", count: 2 }),
        row({ command: "git status --porcelain", count: 3 }),
        row({ command: "git push origin main", status: "hard_block" }),
        row({ command: "git log --oneline", status: "fast_path" }),
      ]),
      { bashParser: parse },
    );

    expect(parse).toHaveBeenCalledTimes(3);
    expect(clusters).toHaveLength(2);
    expect(clusters.map((cluster) => cluster.signature.arg0Set)).toEqual([
      ["status"],
      ["push"],
    ]);
    expect(clusters[0]).toMatchObject({
      executable: "git",
      evidence: { calls: 5, unique: 2, reviewCalls: 5 },
      sampleCommands: ["git status --short", "git status --porcelain"],
    });
    expect(clusters[1]).toMatchObject({
      evidence: { hardBlockCalls: 1 },
    });
  });

  it("marks risky-allow behavior families as not addressable by an allow", async () => {
    const clusters = await clusterFriction(
      report([
        row({
          command: "git push --force origin main",
          behaviors: ["force-push"],
        }),
      ]),
      { bashParser: parserFor() },
    );

    expect(clusters).toHaveLength(1);
    expect(clusters[0]?.behaviors).toEqual(["force-push"]);
    expect(clusters[0]?.addressableBy).toBe("none");
  });

  it("derives substitution and stdout redirect flags from parsed structure", async () => {
    const command = "echo $(pwd) > out.txt";
    const clusters = await clusterFriction(
      report([row({ command, executable: "echo" })]),
      {
        bashParser: parserFor(
          new Map([
            [
              command,
              commandShape({
                command,
                program: "echo",
                args: ["$(pwd)"],
                substitution: true,
                stdoutRedirect: true,
              }),
            ],
          ]),
        ),
      },
    );

    expect(clusters).toHaveLength(1);
    expect(clusters[0]?.signature.hasSubstitution).toBe(true);
    expect(clusters[0]?.signature.hasStdoutRedirect).toBe(true);
  });

  it("records parser failures and forces the cluster to none", async () => {
    const clusters = await clusterFriction(
      report([row({ command: "git status" })]),
      {
        bashParser: parserFor(
          new Map([["git status", new Error("parser unavailable")]]),
        ),
      },
    );

    expect(clusters).toHaveLength(1);
    expect(clusters[0]?.addressableBy).toBe("none");
    expect(clusters[0]?.signature.parseDiagnostics).toEqual([
      "parser unavailable",
    ]);
    expect(clusters[0]?.notes).toEqual([
      'parser failed for "git status": parser unavailable',
    ]);
  });

  it("is total for empty and malformed reports", async () => {
    await expect(
      clusterFriction(report([]), { bashParser: parserFor() }),
    ).resolves.toEqual([]);
    await expect(
      clusterFriction({ perCommand: null } as never, {
        bashParser: parserFor(),
      }),
    ).resolves.toEqual([]);
  });

  it("caps sample commands at five", async () => {
    const clusters = await clusterFriction(
      report(
        Array.from({ length: 7 }, (_, index) =>
          row({
            command: `pnpm test --filter case-${index}`,
            executable: "pnpm",
          }),
        ),
      ),
      { bashParser: parserFor() },
    );

    expect(clusters).toHaveLength(1);
    expect(clusters[0]?.sampleCommands).toEqual([
      "pnpm test --filter case-0",
      "pnpm test --filter case-1",
      "pnpm test --filter case-2",
      "pnpm test --filter case-3",
      "pnpm test --filter case-4",
    ]);
  });

  it("boosts model-reviewed friction in sorting", async () => {
    const clusters = await clusterFriction(
      report([
        row({ command: "human-tool run", executable: "human-tool" }),
        row({
          command: "model-tool run",
          executable: "model-tool",
          capturedOutcomes: outcomes([["model-review", 1]]),
        }),
      ]),
      { bashParser: parserFor() },
    );

    expect(clusters.map((cluster) => cluster.executable)).toEqual([
      "model-tool",
      "human-tool",
    ]);
    expect(clusters[0]?.frictionScore).toBeGreaterThan(
      clusters[1]?.frictionScore ?? 0,
    );
  });
});
