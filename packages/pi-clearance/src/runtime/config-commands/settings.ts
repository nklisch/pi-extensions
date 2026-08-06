import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import { buildAutoReviewerStatusView } from "../auto-reviewer-read-models.ts";
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
import { availableReviewerModels } from "./settings/model-options.ts";

export { availableReviewerModels } from "./settings/model-options.ts";

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
          agentSupportUseDefaults: rawScope.agentSupportUseDefaults ?? true,
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
    gatedTools: buildGatedToolsReadModel(
      policy.policy.config.gatedTools ?? [],
      deps.toolMetadata?.() ?? { activeToolNames: [], allToolNames: [] },
    ),
  });

  return { ok: true, model };
}

function buildGatedToolsReadModel(
  gatedTools: readonly string[],
  metadata: {
    readonly activeToolNames: readonly string[];
    readonly allToolNames: readonly string[];
  },
): SettingsReadModel["gatedTools"] {
  const names = uniqueToolNames(gatedTools).filter((name) => name !== "bash");
  const activeToolNames = uniqueToolNames(metadata.activeToolNames).filter(
    (name) => name !== "bash",
  );
  const allToolNames = uniqueToolNames(metadata.allToolNames).filter(
    (name) => name !== "bash",
  );
  const addSource = activeToolNames.length > 0 ? activeToolNames : allToolNames;
  return {
    names,
    activeToolNames,
    allToolNames,
    addableToolNames: addSource.filter((name) => !names.includes(name)),
  };
}

function uniqueToolNames(names: readonly string[]): string[] {
  return [...new Set(names.filter((name) => name.trim().length > 0))].sort();
}
