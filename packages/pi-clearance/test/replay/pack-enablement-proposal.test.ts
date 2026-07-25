import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { loadConfig } from "../../src/config/loader.ts";

import type { PackEnablementPlan } from "../../src/packs/enablement.ts";
import type { PackReplayImpactSummary } from "../../src/packs/validation.ts";
import {
  applyPackEnablementProposal,
  packEnablementPlanToStructuredProposal,
} from "../../src/replay/pack-enablement-proposal.ts";
import type { ProposalEvidence } from "../../src/replay/proposal-schema.ts";
import {
  proposalJsonRoundTrip,
  validateStructuredProposal,
} from "../../src/replay/proposal-schema.ts";

const CREATED_AT = "2026-06-26T00:00:00.000Z";

describe("packEnablementPlanToStructuredProposal", () => {
  it("emits a writable package-pack-enablement proposal that validates and JSON-round-trips", () => {
    const plan = packEnablementPlan({
      action: "enable",
      scope: "global",
      packId: "pack:demo",
      targetPath: "/home/user/.config/pi-auto-approve/config.json",
      requiredAcknowledgementCodes: ["metadata-danger-0"],
      warnings: [
        {
          code: "metadata-danger-0",
          level: "danger",
          message: "package pack can mutate dependencies",
          source: "metadata",
          requiresAcknowledgement: true,
        },
      ],
    });
    const replayImpact = replayImpactSummary();

    const proposal = packEnablementPlanToStructuredProposal({
      plan,
      createdAt: CREATED_AT,
      evidence: evidence(),
      replayImpact,
    });

    expect(validateStructuredProposal(proposal)).toMatchObject({ ok: true });
    expect(proposalJsonRoundTrip(proposal)).toEqual(proposal);
    expect(
      proposal.change.kind === "package-pack-enablement"
        ? proposal.change.plan
        : undefined,
    ).toEqual(plan);
    expect(proposal).toMatchObject({
      id: plan.id,
      kind: "package-pack-enablement",
      applicationMode: "writable-after-approval",
      intendedProvenance: "user-global",
      target: {
        kind: "package-pack-config",
        path: plan.targetPath,
        packId: "pack:demo",
      },
      change: {
        kind: "package-pack-enablement",
        packId: "pack:demo",
        enable: true,
        metadataWarnings: ["package pack can mutate dependencies"],
      },
      validation: {
        packageAvailability: { status: "pass" },
        trust: { status: "pending", code: "warning-ack-required" },
        replay: { status: "pass", code: "replay-ok" },
      },
    });
    expect(proposal.evidence.replayDelta).toMatchObject({
      version: 1,
      status: "passed",
      changedCalls: 3,
      changedUniqueCommands: 2,
      transitions: [
        {
          transition: "review->fast_path",
          calls: 3,
          uniqueCommands: 2,
        },
      ],
      improvement: {
        reviewToAllowCalls: 3,
        reviewToAllowUniqueCommands: 2,
      },
      regressions: [],
    });
    expect(proposal.trustNotes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "metadata",
          severity: "danger",
          message: "package pack can mutate dependencies",
        }),
      ]),
    );
    expect(proposal.warnings).toEqual([
      "[danger][metadata] metadata-danger-0: package pack can mutate dependencies",
    ]);
  });

  it("applies round-tripped persisted proposals through the shared writer", async () => {
    const tempRoot = await mkdtemp(
      path.join(tmpdir(), "pi-auto-approve-pack-proposal-"),
    );
    const targetPath = path.join(tempRoot, "config.json");
    await writeJson(targetPath, { version: 1 });
    const plan = packEnablementPlan({
      action: "enable",
      scope: "global",
      packId: "pack:demo",
      targetPath,
      requiredAcknowledgementCodes: [],
      warnings: [],
    });
    const proposal = proposalJsonRoundTrip(
      packEnablementPlanToStructuredProposal({
        plan,
        createdAt: CREATED_AT,
        evidence: evidence(),
      }),
    );

    const result = await applyPackEnablementProposal(
      {
        proposal,
        acknowledgement: {
          confirmedPlanId: plan.id,
          acknowledgedWarningCodes: [],
        },
      },
      {
        reloadConfig: () => loadConfig({ cwd: tempRoot }),
        validatePostWrite: async () => ({ ok: true }),
      },
    );

    expect(result).toMatchObject({ ok: true, changed: true });
    await expect(readJson(targetPath)).resolves.toMatchObject({
      packEnablement: { enabledPackagePacks: ["pack:demo"] },
    });
  });

  it("applies persisted proposals through the shared writer and refuses missing confirmation", async () => {
    const proposal = proposalJsonRoundTrip(
      packEnablementPlanToStructuredProposal({
        plan: packEnablementPlan({
          action: "enable",
          scope: "global",
          packId: "pack:demo",
          targetPath: "/home/user/.config/pi-auto-approve/config.json",
          requiredAcknowledgementCodes: [],
          warnings: [],
        }),
        createdAt: CREATED_AT,
        evidence: evidence(),
      }),
    );

    const result = await applyPackEnablementProposal(
      {
        proposal,
        acknowledgement: {
          confirmedPlanId: "wrong-plan",
          acknowledgedWarningCodes: [],
        },
      },
      {
        reloadConfig: async () => {
          throw new Error("reload should not run");
        },
        validatePostWrite: async () => {
          throw new Error("validation should not run");
        },
      },
    );

    expect(result).toMatchObject({
      ok: false,
      wrote: false,
      restored: false,
      cacheInvalidated: false,
      reason: expect.stringContaining("does not match plan id"),
    });
  });

  it("serializes replay regressions as failed replay validation without carrying Maps", () => {
    const proposal = packEnablementPlanToStructuredProposal({
      plan: packEnablementPlan({
        action: "disable",
        scope: "global",
        packId: "pack:demo",
        targetPath: "/home/user/.config/pi-auto-approve/config.json",
        requiredAcknowledgementCodes: [],
        warnings: [],
      }),
      createdAt: CREATED_AT,
      evidence: evidence(),
      replayImpact: {
        ...replayImpactSummary(),
        status: "regression",
        denyToAllow: 1,
        changedStatuses: new Map([["hard_block->fast_path", 1]]),
      },
    });

    expect(validateStructuredProposal(proposal)).toMatchObject({ ok: true });
    expect(proposal.validation.replay).toEqual(
      expect.objectContaining({
        status: "fail",
        code: "replay-regression",
        message: expect.stringContaining("not an apply gate"),
      }),
    );
    expect(proposalJsonRoundTrip(proposal)).toEqual(proposal);
  });
});

function packEnablementPlan(input: {
  readonly action: "enable" | "disable";
  readonly subject?: "package" | "config-pack";
  readonly scope: "global" | "project";
  readonly packId: string;
  readonly targetPath: string;
  readonly requiredAcknowledgementCodes: readonly string[];
  readonly warnings: PackEnablementPlan["warnings"];
}): PackEnablementPlan {
  return {
    id: `pack-enable:test-${input.action}-${input.packId}`,
    request: {
      action: input.action,
      scope: input.scope,
      subject: input.subject ?? "package",
      packId: input.packId,
    },
    targetPath: input.targetPath,
    patch: [
      {
        op: "replace",
        path: "/packEnablement/enabledPackagePacks",
        before: input.action === "enable" ? [] : [input.packId],
        value: input.action === "enable" ? [input.packId] : [],
      },
    ],
    before: {
      scope: input.scope,
      packEnablement: {
        enabledPackagePacks: input.action === "enable" ? [] : [input.packId],
        disabledPackagePacks: [],
        disabledConfigPacks: [],
      },
      packs: [],
    },
    after: {
      scope: input.scope,
      packEnablement: {
        enabledPackagePacks: input.action === "enable" ? [input.packId] : [],
        disabledPackagePacks: input.action === "enable" ? [] : [input.packId],
        disabledConfigPacks: [],
      },
      packs: [],
    },
    warnings: input.warnings,
    requiredAcknowledgementCodes: input.requiredAcknowledgementCodes,
  };
}

function evidence(): ProposalEvidence {
  return {
    familyIds: ["family-pack-demo"],
    recordIds: ["record-1"],
    calls: 5,
    uniqueCommands: 2,
    reviewCalls: 3,
    hardBlockCalls: 0,
    modelReviewCalls: 1,
    capturedDenialCalls: 0,
    replayStatusCounts: [{ label: "review", calls: 3 }],
    capturedOutcomeCounts: [{ label: "model-review", calls: 1 }],
    sampleCommands: ["demo-tool --help"],
  };
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function readJson(filePath: string): Promise<unknown> {
  return JSON.parse(await readFile(filePath, "utf8")) as unknown;
}

function replayImpactSummary(): PackReplayImpactSummary {
  return {
    status: "passed",
    changedUnique: 2,
    changedCalls: 3,
    reviewToAllow: 3,
    denyToAllow: 0,
    allowToReviewOrDeny: 0,
    changedStatuses: new Map([["review->fast_path", 3]]),
    issues: [],
  };
}
