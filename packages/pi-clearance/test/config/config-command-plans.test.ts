import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  planReviewNoteDisplayCommandChange,
  type ReviewNoteDisplayCommandChange,
} from "../../src/config/config-command-plans.ts";
import { loadConfig } from "../../src/config/loader.ts";
import type { JsonPatchOperation } from "../../src/replay/proposal-schema.ts";

const ORIGINAL_PLATFORM = process.platform;
const ORIGINAL_ENV = { ...process.env };

let tempRoot: string;
let cwd: string;
let configHome: string;

beforeEach(async () => {
  setPlatform("linux");
  tempRoot = await mkdtemp(
    path.join(tmpdir(), "pi-clearance-config-plans-"),
  );
  cwd = path.join(tempRoot, "repo");
  configHome = path.join(tempRoot, "xdg-config");
  process.env = { ...ORIGINAL_ENV, XDG_CONFIG_HOME: configHome };
  await mkdir(cwd, { recursive: true });
});

afterEach(() => {
  setPlatform(ORIGINAL_PLATFORM);
  process.env = { ...ORIGINAL_ENV };
});

describe("planReviewNoteDisplayCommandChange", () => {
  it.each([
    [
      { kind: "mode", mode: "accent-only" },
      {
        op: "replace",
        path: "/display/reviewNote/mode",
        before: "reason+accent",
        value: "accent-only",
      },
    ],
    [
      { kind: "show-model-label", enabled: true },
      {
        op: "replace",
        path: "/display/reviewNote/showModelLabel",
        before: false,
        value: true,
      },
    ],
    [
      { kind: "accent", enabled: false },
      {
        op: "replace",
        path: "/display/reviewNote/accent",
        before: true,
        value: false,
      },
    ],
  ] as const satisfies readonly (readonly [
    ReviewNoteDisplayCommandChange,
    JsonPatchOperation,
  ])[])("plans a global %s patch", async (change, patch) => {
    const resolved = await loadConfig({ cwd });
    const result = planReviewNoteDisplayCommandChange({
      change,
      resolvedConfig: resolved,
      cwd,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.reason);
    expect(result.plan.target).toEqual({
      kind: "global",
      path: resolved.sourceSnapshots?.paths.globalConfigFile,
    });
    expect(result.plan.patch).toEqual([patch]);
    expect(result.plan.before).toMatchObject({
      display: {
        reviewNote: {
          mode: "reason+accent",
          showModelLabel: false,
          accent: true,
        },
      },
    });
    expect(result.plan.after).toMatchObject({
      display: { reviewNote: { [fieldFor(change)]: valueFor(change) } },
    });
    expect(result.plan.requiredAcknowledgementCodes).toEqual([]);
    expect(result.plan.warnings).toEqual([]);
  });

  it("returns an empty patch when the requested value is already set", async () => {
    const resolved = await loadConfig({ cwd });
    const result = planReviewNoteDisplayCommandChange({
      change: { kind: "mode", mode: "reason+accent" },
      resolvedConfig: resolved,
      cwd,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.reason);
    expect(result.plan.patch).toEqual([]);
    expect(result.plan.before).toEqual(result.plan.after);
  });

  it("rejects unknown mode values defensively", async () => {
    const resolved = await loadConfig({ cwd });
    const result = planReviewNoteDisplayCommandChange({
      change: {
        kind: "mode",
        mode: "verbose",
      } as unknown as ReviewNoteDisplayCommandChange,
      resolvedConfig: resolved,
      cwd,
    });

    expect(result).toEqual({
      ok: false,
      reason: "unknown review-note display mode: verbose",
    });
  });
});

function fieldFor(change: ReviewNoteDisplayCommandChange) {
  switch (change.kind) {
    case "mode":
      return "mode";
    case "show-model-label":
      return "showModelLabel";
    case "accent":
      return "accent";
  }
}

function valueFor(change: ReviewNoteDisplayCommandChange) {
  switch (change.kind) {
    case "mode":
      return change.mode;
    case "show-model-label":
    case "accent":
      return change.enabled;
  }
}

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", {
    configurable: true,
    value: platform,
  });
}
