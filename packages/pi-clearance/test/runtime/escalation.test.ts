import { describe, expect, it } from "vitest";

import type {
  BashBlock,
  BashStage,
  BashStageProgram,
  SourceSpan,
  ToolShape,
} from "../../src/parse/shape.ts";
import {
  createInProcessEscalationTracker,
  DEFAULT_ESCALATION_WINDOW_MS,
  type EscalationConfig,
  escalationFamily,
} from "../../src/runtime/escalation.ts";

const span = (start: number, end: number): SourceSpan => ({ start, end });
const second = 1_000;

const config = (
  overrides: Partial<EscalationConfig> = {},
): EscalationConfig => ({
  enabled: true,
  denialLimit: 3,
  window: "10m",
  ...overrides,
});

function createClockedTracker() {
  let now = 0;
  return {
    setNow(value: number): void {
      now = value;
    },
    advance(ms: number): void {
      now += ms;
    },
    tracker: createInProcessEscalationTracker({
      clock: () => new Date(now),
    }),
  };
}

describe("createInProcessEscalationTracker", () => {
  it("trips only after the configured denial limit within the window", () => {
    const { tracker } = createClockedTracker();
    const escalation = config({ denialLimit: 3, window: "1m" });

    tracker.recordContention("git", escalation);
    tracker.recordContention("git", escalation);
    expect(tracker.isEscalated("git", escalation)).toBe(false);

    tracker.recordContention("git", escalation);
    expect(tracker.isEscalated("git", escalation)).toBe(true);
  });

  it("decays contention after the configured window without an explicit reset", () => {
    const clocked = createClockedTracker();
    const escalation = config({ denialLimit: 3, window: "1s" });

    clocked.tracker.recordContention("git", escalation);
    clocked.tracker.recordContention("git", escalation);
    clocked.tracker.recordContention("git", escalation);
    expect(clocked.tracker.isEscalated("git", escalation)).toBe(true);

    clocked.advance(second + 1);
    expect(clocked.tracker.isEscalated("git", escalation)).toBe(false);
  });

  it("keeps families independent", () => {
    const { tracker } = createClockedTracker();
    const escalation = config({ denialLimit: 2, window: "1m" });

    tracker.recordContention("git", escalation);
    tracker.recordContention("git", escalation);

    expect(tracker.isEscalated("git", escalation)).toBe(true);
    expect(tracker.isEscalated("rm", escalation)).toBe(false);
  });

  it("treats enabled false as disabled and recordContention as a no-op", () => {
    const { tracker } = createClockedTracker();
    const disabled = config({ enabled: false, denialLimit: 1 });

    for (let index = 0; index < 5; index += 1) {
      tracker.recordContention("git", disabled);
    }

    expect(tracker.isEscalated("git", disabled)).toBe(false);
    expect(tracker.isEscalated("git", config({ denialLimit: 1 }))).toBe(false);
  });

  it("treats denialLimit less than one as disabled", () => {
    const { tracker } = createClockedTracker();
    const disabled = config({ denialLimit: 0 });

    for (let index = 0; index < 5; index += 1) {
      tracker.recordContention("git", disabled);
    }

    expect(tracker.isEscalated("git", disabled)).toBe(false);
  });

  it("falls back to the default escalation window when parsing fails", () => {
    const clocked = createClockedTracker();
    const escalation = config({ denialLimit: 2, window: "bogus" });

    clocked.tracker.recordContention("git", escalation);
    clocked.tracker.recordContention("git", escalation);
    expect(clocked.tracker.isEscalated("git", escalation)).toBe(true);

    clocked.setNow(DEFAULT_ESCALATION_WINDOW_MS - 1);
    expect(clocked.tracker.isEscalated("git", escalation)).toBe(true);

    clocked.setNow(DEFAULT_ESCALATION_WINDOW_MS + 1);
    expect(clocked.tracker.isEscalated("git", escalation)).toBe(false);
  });

  it("reads threshold config live on every call", () => {
    const { tracker } = createClockedTracker();

    tracker.recordContention("git", config({ denialLimit: 3 }));
    tracker.recordContention("git", config({ denialLimit: 3 }));

    expect(tracker.isEscalated("git", config({ denialLimit: 3 }))).toBe(false);
    expect(tracker.isEscalated("git", config({ denialLimit: 2 }))).toBe(true);
  });
});

describe("escalationFamily", () => {
  it("returns the primary bash executable when one is resolvable", () => {
    expect(escalationFamily(bashShape([commandStage("git")]), "bash")).toBe(
      "git",
    );
  });

  it("returns toolName for an unknown-tool shape", () => {
    expect(
      escalationFamily(
        {
          kind: "unknown",
          toolName: "read",
          rawInput: { path: "README.md" },
          diagnostics: [],
        },
        "read",
      ),
    ).toBe("read");
  });

  it("returns toolName for a bash shape with no resolvable stage", () => {
    expect(
      escalationFamily(
        bashShape([commandStage("local-alias", { resolvable: false })]),
        "bash",
      ),
    ).toBe("bash");
  });
});

function commandStage(
  programName: string,
  options: { readonly resolvable?: boolean } = {},
): Extract<BashStage, { readonly kind: "command" }> {
  const program: BashStageProgram = {
    program: programName,
    resolvable: options.resolvable ?? true,
    arguments: [],
    flags: [],
    environment: [],
    span: span(0, programName.length),
  };

  return {
    kind: "command",
    program,
    substitutions: [],
    redirects: [],
    span: span(0, programName.length),
  };
}

function bashShape(stages: readonly BashStage[]): ToolShape {
  const blocks: readonly BashBlock[] = [
    {
      pipeline: {
        stages,
        pipeTargets: [],
        span: span(0, 20),
      },
      span: span(0, 20),
    },
  ];

  return {
    kind: "bash",
    rawCommand: "git status",
    blocks,
    stages,
    diagnostics: [],
  };
}
