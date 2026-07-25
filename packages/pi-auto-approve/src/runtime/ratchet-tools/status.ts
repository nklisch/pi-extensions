import type {
  AgentToolResult,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";

import {
  buildAutoReviewerStatusView,
  formatReviewerContextModeLabel,
  formatReviewerPathLabel,
} from "../auto-reviewer-read-models.ts";
import { formatTuneCueStatus } from "../config-commands/tune-cue.ts";
import type { ResolvedPolicy } from "../policy-cache.ts";
import type {
  RatchetModeManager,
  RatchetModeStatus,
  RatchetToolDefinition,
} from "../ratchet-mode.ts";
import type { ReviewerModelSource } from "../reviewer-model.ts";
import { resolveRatchetPolicy } from "./analysis.ts";
import { RATCHET_TOOL_IDS } from "./ids.ts";
import { formatRatchetToolError, formatRatchetToolResult } from "./result.ts";
import type { RatchetToolDependencies } from "./types.ts";

const STRICT = { additionalProperties: false } as const;

export const AutoReviewerStatusParameters = Type.Object(
  {
    includeRegistryWarnings: Type.Optional(
      Type.Boolean({
        description:
          "Include pack registry warnings and package-registration issues.",
      }),
    ),
  },
  STRICT,
);

export interface AutoReviewerStatusDetails {
  readonly ratchet: RatchetModeStatus;
  readonly project: {
    readonly trusted: boolean;
    readonly cwd: string;
  };
  readonly mode: ResolvedPolicy["config"]["mode"];
  readonly reviewer: {
    readonly promptPosture: string;
    readonly configuredModel: string | null;
    readonly resolvedModel: string | null;
    readonly resolvedModelSource: ReviewerModelSource;
    readonly resolvedModelNote?: string;
    readonly modelHighCost: boolean;
    readonly contextMode: ResolvedPolicy["config"]["reviewer"]["contextMode"];
    readonly path: "model" | "human" | "passthrough" | "unattended-fallback";
    readonly consequence: string;
  };
  readonly packs: {
    readonly total: number;
    readonly enabled: number;
  };
  readonly warnings: readonly string[];
}

interface StatusParametersInput {
  readonly includeRegistryWarnings?: boolean;
}

export function createAutoReviewerStatusTool(
  deps: RatchetToolDependencies,
  manager: RatchetModeManager,
): RatchetToolDefinition {
  return {
    name: RATCHET_TOOL_IDS.status,
    label: "Clearance Status",
    description:
      "Return ratchet mode, Clearance mode, reviewer configuration, project trust, pack counts, and current warnings.",
    promptSnippet:
      "Inspect current Clearance Tune, policy, reviewer, and pack status.",
    promptGuidelines: [
      "Use clearance_status first in ratchet mode to understand the current policy, reviewer, trust, and pack context.",
    ],
    parameters: AutoReviewerStatusParameters,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      try {
        const input = parseStatusParameters(params);
        const policy = await resolveRatchetPolicy(ctx, deps);
        const details = buildStatusDetails(ctx, policy, manager, input);

        return formatRatchetToolResult(
          details,
          formatStatusMarkdown(details),
        ) as unknown as AgentToolResult<AutoReviewerStatusDetails>;
      } catch (error: unknown) {
        return formatRatchetToolError(
          RATCHET_TOOL_IDS.status,
          error,
        ) as unknown as AgentToolResult<AutoReviewerStatusDetails>;
      }
    },
  };
}

function parseStatusParameters(params: unknown): StatusParametersInput {
  if (typeof params !== "object" || params === null || Array.isArray(params)) {
    return {};
  }

  const includeRegistryWarnings = (
    params as { includeRegistryWarnings?: unknown }
  ).includeRegistryWarnings;
  return typeof includeRegistryWarnings === "boolean"
    ? { includeRegistryWarnings }
    : {};
}

function buildStatusDetails(
  ctx: ExtensionContext,
  policy: ResolvedPolicy,
  manager: RatchetModeManager,
  input: StatusParametersInput,
): AutoReviewerStatusDetails {
  const view = buildAutoReviewerStatusView({
    ctx,
    policy,
    ratchet: manager.getStatus(),
    includeRegistryWarnings: input.includeRegistryWarnings === true,
  });

  return {
    ratchet: view.ratchet,
    project: view.project,
    mode: view.mode,
    reviewer: {
      promptPosture: view.reviewer.promptPosture,
      configuredModel: view.reviewer.configuredModel,
      resolvedModel: view.reviewer.resolvedModel,
      resolvedModelSource: view.reviewer.resolvedModelSource,
      ...(view.reviewer.resolvedModelNote === undefined
        ? {}
        : { resolvedModelNote: view.reviewer.resolvedModelNote }),
      modelHighCost: view.reviewer.modelHighCost,
      contextMode: view.reviewer.contextMode,
      path: view.reviewer.path,
      consequence: view.reviewer.consequence,
    },
    packs: view.packs,
    warnings: view.warnings,
  };
}

function formatStatusMarkdown(details: AutoReviewerStatusDetails): string {
  const tune = formatTuneCueStatus(details.ratchet.active);
  const trusted = details.project.trusted ? "trusted" : "untrusted";
  return [
    "# Clearance status",
    "",
    `- Tune mode: ${tune}`,
    `- Tune tools: ${details.ratchet.ratchetToolNames.length === 0 ? "(none)" : details.ratchet.ratchetToolNames.join(", ")}`,
    `- Project: ${trusted} at \`${details.project.cwd}\``,
    `- Mode: ${details.mode}`,
    `- Reviewer: prompt posture ${details.reviewer.promptPosture}; reviewer path: ${formatReviewerPathLabel(details.reviewer.path)}; context ${formatReviewerContextModeLabel(details.reviewer.contextMode)}. ${details.reviewer.consequence}`,
    `- Reviewer model configured: ${details.reviewer.configuredModel === null ? "none" : `\`${details.reviewer.configuredModel}\``}`,
    `- Reviewer model resolved: ${details.reviewer.resolvedModel === null ? "none" : `\`${details.reviewer.resolvedModel}\``} (${details.reviewer.resolvedModelSource})`,
    ...(details.reviewer.resolvedModelNote === undefined
      ? []
      : [`- Reviewer model note: ${details.reviewer.resolvedModelNote}`]),
    ...(details.reviewer.modelHighCost
      ? ["- Reviewer model cost: high-cost warning"]
      : []),
    `- Packs: ${details.packs.enabled} enabled / ${details.packs.total} total`,
    `- Warnings: ${details.warnings.length}`,
  ].join("\n");
}
