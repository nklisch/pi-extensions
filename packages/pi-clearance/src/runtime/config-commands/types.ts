import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import type { AuditLogger } from "../../audit/logger.ts";
import type { PackageRegistrationSnapshot } from "../../packs/package-registration.ts";
import type { ToolAnalyzerRegistry } from "../../parse/registry.ts";
import type { PolicyResolver, ResolvedPolicy } from "../policy-cache.ts";
import type { RatchetModeManager } from "../ratchet-mode.ts";
import type { RecentDecisionSource } from "../reviewer-context.ts";

export type {
  RecentDecisionEntry,
  RecentDecisionSource,
} from "../reviewer-context.ts";

export interface CommandToolMetadata {
  /** Currently active tool names, when the host exposes them. */
  readonly activeToolNames: readonly string[];
  /** All configured tool names, when the host exposes them. */
  readonly allToolNames: readonly string[];
}

export interface AutoReviewerCommandDependencies {
  readonly manager: RatchetModeManager;
  readonly policyResolver: PolicyResolver;
  readonly packageRegistration: () => PackageRegistrationSnapshot;
  readonly audit: AuditLogger;
  /** Optional host tool catalog used by the exact gated-tools settings control. */
  readonly toolMetadata?: () => CommandToolMetadata;
  /** Bounded recent audit decisions used by `/clearance allow` with no text. */
  readonly recentDecisionSource: RecentDecisionSource;
  /** Structural analyzer used only to summarize the recent command for the agent. */
  readonly analyzerRegistry: ToolAnalyzerRegistry;
  /** Refresh the active-session footer after a confirmed config write resolves. */
  readonly refreshOperatorStatus?: (
    ctx: ExtensionContext,
    policy: ResolvedPolicy,
  ) => void;
}

export interface CommandReport<TDetails = unknown> {
  readonly title: string;
  readonly summary: string;
  readonly markdown: string;
  readonly details: TDetails;
  readonly level?: "info" | "warning" | "error";
}

export interface AutoReviewerAutocompleteItem {
  readonly value: string;
  readonly label: string;
  readonly description?: string;
}

export type CommandPi = Pick<
  ExtensionAPI,
  | "getActiveTools"
  | "getAllTools"
  | "setActiveTools"
  | "registerTool"
  | "sendMessage"
>;

export const USAGE_MARKDOWN = [
  "# Pi Clearance commands",
  "",
  "Primary surface:",
  "- `/clearance setup` — open the guided setup entry point.",
  "- `/clearance settings` — open the settings control center.",
  "- `/clearance status [--warnings]` — show current status.",
  "- `/clearance mode [off|ask|auto]` — show or set the global Clearance mode.",
  "- `/clearance packs [--source <kind>] [--enabled|--disabled] [--baseline] [--tag <tag>]` — open Policy dossiers.",
  "- `/clearance scope` — open Safe Zones settings.",
  "- `/clearance tune` — toggle Tune mode.",
  "- `/clearance why [count]` — open a Debrief for recent clearance decisions.",
  "- `/clearance allow <plain language>` or `/clearance allow` — hand a focused allow request to the agent for the approval card.",
  "",
  "",
  "Tune analysis tools are available only while `/clearance tune` is active; proposal tools remain available in every mode.",
  "",
  "Reviewer prompt posture and model pinning are available as confirm-backed settings selectors; context mode, token budget, escalation, and other advanced fields are edited in user-owned global config.",
].join("\n");

export function refreshOperatorStatus(
  ctx: ExtensionContext,
  deps: Pick<AutoReviewerCommandDependencies, "refreshOperatorStatus">,
  policy: ResolvedPolicy,
): void {
  try {
    deps.refreshOperatorStatus?.(ctx, policy);
  } catch {
    // Footer visibility is advisory and must never turn an applied config write
    // into a reported failure or trigger rollback after durable validation.
  }
}

export async function resolvePolicyForCommand(
  ctx: ExtensionCommandContext,
  deps: Pick<AutoReviewerCommandDependencies, "policyResolver">,
): Promise<ResolvedPolicy> {
  const result = await deps.policyResolver.resolve(ctx);
  if (!result.ok) {
    throw new Error(`Pi Clearance policy resolution failed: ${result.reason}`);
  }

  return result.policy;
}

export async function resolvePolicyReport(
  ctx: ExtensionCommandContext,
  deps: Pick<AutoReviewerCommandDependencies, "policyResolver">,
): Promise<
  | { readonly ok: true; readonly policy: ResolvedPolicy }
  | {
      readonly ok: false;
      readonly report: CommandReport<{ readonly error: string }>;
    }
> {
  try {
    return { ok: true, policy: await resolvePolicyForCommand(ctx, deps) };
  } catch (error: unknown) {
    const message = errorMessage(error);
    return {
      ok: false,
      report: {
        title: "Pi Clearance command failed",
        summary: message,
        markdown: [
          "# Pi Clearance command failed",
          "",
          `- Error: ${message}`,
          "- No config changes were written.",
        ].join("\n"),
        details: { error: message },
        level: "error",
      },
    };
  }
}

export function usageReport(
  reason?: string,
): CommandReport<{ readonly usage: true; readonly reason?: string }> {
  return {
    title: "Pi Clearance usage",
    summary: reason ?? "Show Pi Clearance command usage.",
    markdown:
      reason === undefined
        ? USAGE_MARKDOWN
        : [`# Pi Clearance usage`, "", `- ${reason}`, "", USAGE_MARKDOWN].join(
            "\n",
          ),
    details: reason === undefined ? { usage: true } : { usage: true, reason },
    level: reason === undefined ? "info" : "error",
  };
}

export function completion(
  value: string,
  description: string,
): AutoReviewerAutocompleteItem {
  return { value, label: value, description };
}

export function filterCompletions(
  items: readonly AutoReviewerAutocompleteItem[],
  current: string,
): AutoReviewerAutocompleteItem[] | null {
  const filtered = items.filter((item) => item.value.startsWith(current));
  return filtered.length === 0 ? null : filtered;
}

export function stableUnique<T>(values: readonly T[]): readonly T[] {
  const seen = new Set<T>();
  const result: T[] = [];
  for (const value of values) {
    if (seen.has(value)) {
      continue;
    }
    seen.add(value);
    result.push(value);
  }
  return result;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
