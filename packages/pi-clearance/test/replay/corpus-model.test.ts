import { describe, expect, it } from "vitest";
import type {
  CapturedOutcomeLabel,
  CountByLabel,
  ReplayStatus,
} from "../../src/replay/corpus-model.ts";
import {
  CAPTURED_OUTCOME_LABELS,
  classifyCapturedOutcome as classifyCapturedOutcomeFromModel,
  countByLabel,
  effectToStatus as effectToStatusFromModel,
  REPLAY_STATUSES,
  recordIdForEntry,
  sortCountsByOrder,
  sourceFidelityForEntry,
} from "../../src/replay/corpus-model.ts";
import type { CorpusEntry } from "../../src/replay/history.ts";
import {
  classifyCapturedOutcome,
  effectToStatus,
} from "../../src/replay/ratchet.ts";

function entry(overrides: Partial<CorpusEntry> = {}): CorpusEntry {
  const source = overrides.source ?? "session";
  return {
    command: "git status",
    toolName: "bash",
    source,
    sources: overrides.sources ?? [source],
    provenance: overrides.provenance ?? "test",
    fidelity: overrides.fidelity ?? "high",
    ...overrides,
  };
}

describe("corpus-model record ids", () => {
  it("is deterministic for the same entry and index", () => {
    const e = entry({
      toolCallId: "call-1",
      sessionId: "s-1",
      timestamp: "t-1",
    });
    expect(recordIdForEntry(e, 0)).toBe(recordIdForEntry(e, 0));
  });

  it("uses the index as a collision-safe suffix", () => {
    const e = entry();
    const id0 = recordIdForEntry(e, 0);
    const id1 = recordIdForEntry(e, 1);
    expect(id0).not.toBe(id1);
    expect(id0.endsWith("-0")).toBe(true);
    expect(id1.endsWith("-1")).toBe(true);
  });

  it("derives a content component so different entries at the same index differ", () => {
    const left = entry({ command: "git status" });
    const right = entry({ command: "git push --force" });
    expect(recordIdForEntry(left, 0)).not.toBe(recordIdForEntry(right, 0));
  });

  it("differentiates entries that differ only by toolCallId", () => {
    const a = entry({ toolCallId: "call-a" });
    const b = entry({ toolCallId: "call-b" });
    expect(recordIdForEntry(a, 0)).not.toBe(recordIdForEntry(b, 0));
  });

  it("produces a stable, JSON-serializable string without embedding the raw command", () => {
    const command = "cat /home/nathan/secret/path.txt";
    const id = recordIdForEntry(entry({ command }), 7);
    expect(typeof id).toBe("string");
    expect(id.length).toBeGreaterThan(0);
    expect(id.startsWith("rec-")).toBe(true);
    expect(id.endsWith("-7")).toBe(true);
    // Record ids must not leak raw commands or paths (good hygiene even though
    // the hard "no raw path values" rule applies to family ids in the next story).
    expect(id.includes(command)).toBe(false);
    expect(() => JSON.stringify(id)).not.toThrow();
  });
});

describe("corpus-model count primitives", () => {
  it("counts labels in canonical order, omitting zeros, as a JSON array", () => {
    const values: readonly ReplayStatus[] = [
      "review",
      "review",
      "fast_path",
      "hard_block",
      "review",
    ];
    const counts = countByLabel(REPLAY_STATUSES, values);
    expect(counts).toEqual([
      { label: "fast_path", calls: 1 },
      { label: "review", calls: 3 },
      { label: "hard_block", calls: 1 },
    ]);
    // JSON-compatible: round-trips through stringify without custom Map handling.
    const json = JSON.stringify(counts);
    expect(JSON.parse(json)).toEqual(counts);
    expect(Array.isArray(counts)).toBe(true);
  });

  it("omits labels with zero calls", () => {
    expect(countByLabel(REPLAY_STATUSES, ["review", "review"])).toEqual([
      { label: "review", calls: 2 },
    ]);
  });

  it("counts captured-outcome labels using CAPTURED_OUTCOME_LABELS order", () => {
    const labels: readonly CapturedOutcomeLabel[] = [
      "model-review",
      "deterministic-allow",
      "model-review",
      "no-captured-outcome",
    ];
    expect(countByLabel(CAPTURED_OUTCOME_LABELS, labels)).toEqual([
      { label: "deterministic-allow", calls: 1 },
      { label: "model-review", calls: 2 },
      { label: "no-captured-outcome", calls: 1 },
    ]);
  });

  it("returns an empty array when no label matches", () => {
    expect(countByLabel(REPLAY_STATUSES, [])).toEqual([]);
  });

  it("sortCountsByOrder reorders by canonical order, dropping unknown labels and zeros", () => {
    const counts: readonly CountByLabel<ReplayStatus>[] = [
      { label: "hard_block", calls: 2, uniqueCommands: 1 },
      { label: "fast_path", calls: 0 },
      { label: "review", calls: 4, uniqueCommands: 3 },
      { label: "nonsense" as ReplayStatus, calls: 9 },
    ];
    expect(sortCountsByOrder(counts, REPLAY_STATUSES)).toEqual([
      { label: "review", calls: 4, uniqueCommands: 3 },
      { label: "hard_block", calls: 2, uniqueCommands: 1 },
    ]);
  });

  it("sortCountsByOrder preserves uniqueCommands and returns empty when nothing matches", () => {
    const counts: readonly CountByLabel<ReplayStatus>[] = [
      { label: "fast_path", calls: 0 },
    ];
    expect(sortCountsByOrder(counts, REPLAY_STATUSES)).toEqual([]);
  });

  it("sortCountsByOrder is last-wins on duplicate labels (documented normalizer contract)", () => {
    const counts: readonly CountByLabel<ReplayStatus>[] = [
      { label: "review", calls: 4, uniqueCommands: 3 },
      { label: "review", calls: 1, uniqueCommands: 1 },
    ];
    expect(sortCountsByOrder(counts, REPLAY_STATUSES)).toEqual([
      { label: "review", calls: 1, uniqueCommands: 1 },
    ]);
  });
});

describe("corpus-model source fidelity", () => {
  it("marks high-fidelity session entries as not redacted with no low-fidelity reasons", () => {
    const sf = sourceFidelityForEntry(
      entry({ source: "session", sources: ["session"], fidelity: "high" }),
    );
    expect(sf).toMatchObject({
      source: "session",
      sources: ["session"],
      fidelity: "high",
      redacted: false,
      lowFidelityReasons: [],
    });
  });

  it("marks redacted audit-only entries and explains why", () => {
    const sf = sourceFidelityForEntry(
      entry({
        command: "rm -rf /tmp",
        source: "audit",
        sources: ["audit"],
        provenance: "audit:index:0",
        fidelity: "redacted",
      }),
    );
    expect(sf.redacted).toBe(true);
    expect(sf.fidelity).toBe("redacted");
    expect(sf.lowFidelityReasons).toEqual([
      "audit-only: command recovered without a matching session call",
    ]);
  });

  it("mirrors redacted from fidelity for non-audit redacted entries", () => {
    // No current adapter produces this shape, but the builder must stay coherent
    // if one ever does: a redacted fidelity yields redacted=true and a reason.
    const sf = sourceFidelityForEntry(
      entry({ source: "session", sources: ["session"], fidelity: "redacted" }),
    );
    expect(sf.redacted).toBe(true);
    expect(sf.lowFidelityReasons).toEqual(["redacted"]);
  });

  it("preserves source, sources, and provenance from the entry", () => {
    const sf = sourceFidelityForEntry(
      entry({
        source: "session",
        sources: ["session", "audit"],
        provenance: "session:s-1:call-1",
      }),
    );
    expect(sf.source).toBe("session");
    expect(sf.sources).toEqual(["session", "audit"]);
    expect(sf.provenance).toBe("session:s-1:call-1");
  });
});

describe("corpus-model ratchet re-export parity", () => {
  it("re-exports the same classifier and status mapper identities from ratchet.ts", () => {
    // Existing imports from ratchet.ts must keep resolving to the moved symbols.
    expect(classifyCapturedOutcome).toBe(classifyCapturedOutcomeFromModel);
    expect(effectToStatus).toBe(effectToStatusFromModel);
  });

  it("classifies a deterministic outcome via the re-exported symbols", () => {
    expect(
      classifyCapturedOutcome(entry({ deterministicOutcome: "allow" })).label,
    ).toBe("deterministic-allow");
    expect(effectToStatus("allow")).toBe("fast_path");
  });
});
