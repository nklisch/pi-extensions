import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import type { ClearanceMode } from "../../config/schema.ts";
import { buildAutoReviewerStatusView } from "../auto-reviewer-read-models.ts";
import { dispatchSettingsAction } from "./settings/dispatcher.ts";
import { buildSettingsReadModel } from "./settings/read-model.ts";
import {
  type AutoReviewerCommandDependencies,
  type CommandPi,
  type CommandReport,
  resolvePolicyReport,
  usageReport,
} from "./types.ts";

const MODE_OPTIONS: readonly {
  readonly mode: ClearanceMode;
  readonly label: string;
  readonly description: string;
}[] = [
  {
    mode: "off",
    label: "Off",
    description:
      "Nothing is asked or reviewed; catastrophic commands and your deny rules still block.",
  },
  {
    mode: "ask",
    label: "Ask",
    description:
      "Known-safe commands run automatically; anything else asks you. No model is called.",
  },
  {
    mode: "auto",
    label: "Auto",
    description:
      "Known-safe commands run automatically; a model reviews the rest before asking you.",
  },
];

export async function handleSetupCommand(
  tokens: readonly string[],
  ctx: ExtensionCommandContext,
  _pi: CommandPi,
  deps: AutoReviewerCommandDependencies,
): Promise<CommandReport> {
  if (tokens.length !== 0)
    return usageReport("Expected `setup` with no additional arguments.");
  if (ctx.hasUI !== true) {
    return {
      title: "Setup requires UI",
      summary:
        "The setup wizard requires interactive Pi UI; no config changes were written.",
      markdown: "# Setup requires UI\n\nNo config changes were written.",
      details: { reason: "ui-required", applied: [] },
      level: "error",
    };
  }

  const policy = await resolvePolicyReport(ctx, deps);
  if (!policy.ok) return policy.report;
  const status = buildAutoReviewerStatusView({
    ctx,
    policy: policy.policy,
    ratchet: deps.manager.getStatus(),
  });
  const model = buildSettingsReadModel({
    status,
    projectScope: policy.policy.config.projectScope,
    reviewNoteDisplay: policy.policy.config.display.reviewNote,
  });
  const selection = await safeSelect(
    ctx,
    "Setup: choose Clearance mode",
    MODE_OPTIONS.map(
      (option) =>
        `${option.label} — ${option.description}${option.mode === model.currentMode.mode ? " (current)" : ""}`,
    ),
  );
  if (selection === undefined) {
    return {
      title: "Setup cancelled",
      summary: "No mode was selected; no config changes were written.",
      markdown: "# Setup cancelled\n\nNo config changes were written.",
      details: { reason: "cancelled" },
      level: "warning",
    };
  }
  const option = MODE_OPTIONS.find((candidate) =>
    selection.startsWith(`${candidate.label} —`),
  );
  if (option === undefined)
    return {
      title: "Setup failed",
      summary: "Unknown mode selection; no config changes were written.",
      markdown: "# Setup failed\n\nNo config changes were written.",
      details: { reason: "failed" },
      level: "error",
    };

  const report = await dispatchSettingsAction(
    { id: "mode.set", args: { mode: option.mode } },
    ctx,
    deps,
  );
  return {
    ...report,
    title:
      report.title === "Settings updated"
        ? "Pi Clearance setup complete"
        : report.title,
    summary:
      report.title === "Settings updated"
        ? `Clearance mode set to ${option.label}.`
        : report.summary,
    markdown: [
      "# Pi Clearance setup",
      "",
      `- Mode: ${option.label} — ${option.description}`,
      "",
      report.markdown,
    ].join("\n"),
  };
}

async function safeSelect(
  ctx: ExtensionCommandContext,
  title: string,
  options: readonly string[],
): Promise<string | undefined> {
  try {
    return await ctx.ui.select(title, [...options]);
  } catch {
    return undefined;
  }
}
