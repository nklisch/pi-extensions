import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import { buildAutoReviewerStatusView } from "../auto-reviewer-read-models.ts";
import type { ReviewerModelRegistry } from "../reviewer-model.ts";
import {
  canOpenSettingsNativeUi,
  openSettingsNativeUi,
} from "./settings/native-ui.ts";
import {
  buildSettingsReadModel,
  type SettingsReadModel,
} from "./settings/read-model.ts";
import {
  type AutoReviewerCommandDependencies,
  type CommandReport,
  resolvePolicyReport,
  usageReport,
} from "./types.ts";

type SettingsNativePanel = SettingsReadModel["panels"][number]["id"];

interface SettingsCommandDetails {
  readonly controlCenter?: SettingsReadModel;
  readonly nativeUi?: unknown;
  readonly reason?: "native-ui-unavailable";
}

export async function handleSettingsCommand(
  tokens: readonly string[],
  ctx: ExtensionCommandContext,
  deps: AutoReviewerCommandDependencies,
): Promise<CommandReport<SettingsCommandDetails | unknown>> {
  if (tokens.length !== 0) {
    return usageReport("Expected `settings` with no additional arguments.");
  }

  const built = await buildSettingsCommandView(ctx, deps);
  if (!built.ok) {
    return built.report;
  }

  return await openSettingsUiCommand({
    ctx,
    deps,
    model: built.model,
    title: "Pi Clearance settings",
  });
}

export async function handleScopeSettingsPanelCommand(
  ctx: ExtensionCommandContext,
  deps: AutoReviewerCommandDependencies,
): Promise<CommandReport> {
  const built = await buildSettingsCommandView(ctx, deps);
  if (!built.ok) {
    return built.report;
  }

  return await openSettingsUiCommand({
    ctx,
    deps,
    model: built.model,
    title: "Project scope settings",
    initialPanel: "scope",
  });
}

async function openSettingsUiCommand(input: {
  readonly ctx: ExtensionCommandContext;
  readonly deps: AutoReviewerCommandDependencies;
  readonly model: SettingsReadModel;
  readonly title: string;
  readonly initialPanel?: SettingsNativePanel;
}): Promise<CommandReport<SettingsCommandDetails | unknown>> {
  if (!canOpenSettingsNativeUi(input.ctx)) {
    return nativeUiUnavailableReport(input.model);
  }

  const native = await openSettingsNativeUi({
    ctx: input.ctx,
    deps: input.deps,
    initialModel: input.model,
    ...(input.initialPanel === undefined
      ? {}
      : { initialPanel: input.initialPanel }),
    reload: async () => {
      const refreshed = await buildSettingsCommandView(input.ctx, input.deps);
      return refreshed.ok
        ? { ok: true, model: refreshed.model }
        : { ok: false, report: refreshed.report };
    },
  });

  if (!native.ok) {
    return native.report;
  }

  return {
    title: input.title,
    summary: native.summary,
    markdown: "",
    details: {
      controlCenter: input.model,
      nativeUi: native.details,
    },
    level: native.level,
  };
}

function nativeUiUnavailableReport(
  model: SettingsReadModel,
): CommandReport<SettingsCommandDetails> {
  const summary =
    "Pi Clearance settings require Pi's native custom UI; no markdown fallback was rendered and no config changes were written.";
  return {
    title: "Pi Clearance settings unavailable",
    summary,
    // Keep this to one notice line: hosts without custom UI need visible
    // feedback, but settings must not degrade into a transcript report.
    markdown: summary,
    details: {
      reason: "native-ui-unavailable",
      controlCenter: model,
    },
    level: "error",
  };
}

async function buildSettingsCommandView(
  ctx: ExtensionCommandContext,
  deps: AutoReviewerCommandDependencies,
): Promise<
  | {
      readonly ok: true;
      readonly model: SettingsReadModel;
    }
  | { readonly ok: false; readonly report: CommandReport }
> {
  const policy = await resolvePolicyReport(ctx, deps);
  if (!policy.ok) {
    return { ok: false, report: policy.report };
  }

  const status = buildAutoReviewerStatusView({
    ctx,
    policy: policy.policy,
    ratchet: deps.manager.getStatus(),
  });
  // Thread the raw configured behavior toggles through: the resolved scope
  // loses them, and preset inference compares configured (not derived)
  // values.
  const rawScope = policy.policy.config.sourceSnapshots?.project.projectScope;
  const projectScope =
    rawScope === undefined
      ? policy.policy.config.projectScope
      : {
          ...policy.policy.config.projectScope,
          safeHomeUseDefaults: rawScope.safeHomeUseDefaults,
          ...(rawScope.agentSupportUseDefaults === undefined
            ? {}
            : { agentSupportUseDefaults: rawScope.agentSupportUseDefaults }),
          homePathBehavior: rawScope.homePathBehavior,
          sensitivePathBehavior: rawScope.sensitivePathBehavior,
        };
  const model = buildSettingsReadModel({
    status,
    projectScope,
    reviewNoteDisplay: policy.policy.config.display.reviewNote,
    packs: policy.policy.registry.entries.map((entry) => {
      const enablement = policy.policy.config.packEnablement;
      return {
        id: entry.id,
        title: entry.metadata.title,
        enabled: entry.availability.enabled,
        toggleable: entry.source.kind === "package",
        source: entry.source.kind,
        enabledInGlobal:
          enablement.global.enabledPackagePacks.includes(entry.id) &&
          !enablement.global.disabledPackagePacks.includes(entry.id),
        enabledInProject:
          enablement.project.enabledPackagePacks.includes(entry.id) &&
          !enablement.project.disabledPackagePacks.includes(entry.id),
      };
    }),
    reviewerModels: availableReviewerModels(ctx),
  });

  return { ok: true, model };
}

const REVIEWER_MODEL_OPTION_LIMIT = 12;

/** Available reviewer model specs (provider/modelId) with configured auth. */
export function availableReviewerModels(
  ctx: ExtensionCommandContext,
): readonly { readonly spec: string; readonly label: string }[] {
  // Pi's ModelRegistry.hasConfiguredAuth takes the MODEL, not a provider
  // string — passing a string silently filters out every model.
  const registry = (ctx as { readonly modelRegistry?: unknown })
    .modelRegistry as ReviewerModelRegistry | undefined;
  if (
    registry === undefined ||
    typeof registry.getAll !== "function" ||
    typeof registry.hasConfiguredAuth !== "function"
  ) {
    return [];
  }

  try {
    return registry
      .getAll()
      .filter((model) => registry.hasConfiguredAuth(model))
      .map((model) => ({
        spec: `${model.provider}/${model.id}`,
        label:
          typeof model.name === "string" && model.name.length > 0
            ? `${model.name} (${model.provider}/${model.id})`
            : `${model.provider}/${model.id}`,
      }))
      .sort((a, b) => a.spec.localeCompare(b.spec))
      .slice(0, REVIEWER_MODEL_OPTION_LIMIT);
  } catch {
    return [];
  }
}
