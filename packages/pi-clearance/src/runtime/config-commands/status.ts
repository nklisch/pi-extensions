import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import {
  buildAutoReviewerStatusView,
  formatReviewerContextModeLabel,
} from "../auto-reviewer-read-models.ts";
import { formatTuneCueStatus } from "./tune-cue.ts";
import {
  type AutoReviewerCommandDependencies,
  type CommandReport,
  resolvePolicyReport,
  usageReport,
} from "./types.ts";

export async function handleStatusCommand(
  tokens: readonly string[],
  ctx: ExtensionCommandContext,
  deps: AutoReviewerCommandDependencies,
): Promise<CommandReport> {
  const includeWarnings = tokens.length === 1 && tokens[0] === "--warnings";
  if (tokens.length > 1 || (tokens.length === 1 && !includeWarnings))
    return usageReport("Expected `status` or `status --warnings`.");
  const policy = await resolvePolicyReport(ctx, deps);
  if (!policy.ok) return policy.report;
  const details = buildAutoReviewerStatusView({
    ctx,
    policy: policy.policy,
    ratchet: deps.manager.getStatus(),
    includeRegistryWarnings: includeWarnings,
  });
  return {
    title: "Pi Clearance status",
    summary: `Mode ${details.mode}; Tune ${details.ratchet.active ? "on" : "off"}; ${details.packs.enabled}/${details.packs.total} packs enabled; ${details.warnings.length} warning(s).`,
    markdown: formatStatusMarkdown(details, includeWarnings),
    details,
    level: details.warnings.length === 0 ? "info" : "warning",
  };
}

function formatStatusMarkdown(
  details: ReturnType<typeof buildAutoReviewerStatusView>,
  includeWarnings: boolean,
): string {
  const lines = [
    "# Pi Clearance status",
    "",
    `- Mode: ${details.mode}`,
    `- Tune mode: ${formatTuneCueStatus(details.ratchet.active)}`,
    `- Project: ${details.project.trusted ? "trusted" : "untrusted"} at \`${details.project.cwd}\``,
    `- Review path: ${details.reviewer.path}; ${details.reviewer.consequence}`,
    `- Reviewer prompt: ${details.reviewer.promptPosture}; context ${formatReviewerContextModeLabel(details.reviewer.contextMode)}`,
    `- Reviewer model configured: ${details.reviewer.configuredModel === null ? "none" : `\`${details.reviewer.configuredModel}\``}`,
    `- Reviewer model resolved: ${details.reviewer.resolvedModel === null ? "none" : `\`${details.reviewer.resolvedModel}\``} (${details.reviewer.resolvedModelSource})`,
    `- Packs: ${details.packs.enabled} enabled / ${details.packs.total} total`,
    `- Warnings: ${details.warnings.length}`,
  ];
  if (includeWarnings && details.warnings.length > 0)
    lines.push(
      "",
      "## Warnings",
      ...details.warnings.map((warning) => `- ${warning}`),
    );
  return lines.join("\n");
}
