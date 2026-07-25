import { createHash } from "node:crypto";

import type { JsonPatchOperation } from "../replay/proposal-schema.ts";
import { isHighCostReviewerModel } from "../runtime/reviewer-model.ts";
import type {
  ConfigCommandPlan,
  ConfigCommandTargetKind,
  ConfigCommandWarning,
} from "./config-command-writer.ts";
import {
  type ResolvedConfig,
  type ResolvedProjectScope,
  validateProjectScopeConfig,
} from "./loader.ts";
import type { ClearanceMode } from "./schema.ts";
import {
  type GlobalConfig,
  isReviewNoteMode,
  type ProjectOverlayConfig,
  type ProjectScopeConfig,
  type ReviewNoteMode,
} from "./schema.ts";

export type { ReviewNoteMode } from "./schema.ts";

export type ReviewerContextMode = "minimal" | "recentContext";
export type ReviewerPromptAppendTarget = "global" | "project";

export type ProjectScopeListField =
  | "roots"
  | "writableDirectories"
  | "tempDirectories"
  | "deniedDirectories"
  | "safeHomeDirectories"
  | "agentSupportDirectories";

/**
 * Named scope presets. A preset is a bundle write over the behavior fields of
 * `projectScope`; it never touches path lists (roots, writable, temp, denied)
 * because those carry user-curated content orthogonal to the preset.
 */
export type ScopePreset = "project" | "home" | "unrestricted";

export const SCOPE_PRESET_LABELS = {
  project: "Project only",
  home: "Home + project",
  unrestricted: "Full minus danger list",
} as const satisfies Record<ScopePreset, string>;

interface ScopePresetFields {
  readonly safeHomeUseDefaults: boolean;
  readonly agentSupportUseDefaults: boolean;
  readonly homePathBehavior: "allow" | "review";
  readonly sensitivePathBehavior: "review" | "deny";
  readonly unknownPathBehavior: "review" | "deny";
}

export const SCOPE_PRESET_FIELDS = {
  project: {
    safeHomeUseDefaults: false,
    agentSupportUseDefaults: false,
    homePathBehavior: "review",
    sensitivePathBehavior: "review",
    unknownPathBehavior: "review",
  },
  home: {
    safeHomeUseDefaults: true,
    agentSupportUseDefaults: true,
    homePathBehavior: "allow",
    sensitivePathBehavior: "review",
    unknownPathBehavior: "review",
  },
  unrestricted: {
    safeHomeUseDefaults: true,
    agentSupportUseDefaults: true,
    homePathBehavior: "allow",
    sensitivePathBehavior: "deny",
    unknownPathBehavior: "review",
  },
} as const satisfies Record<ScopePreset, ScopePresetFields>;

/**
 * Infer which preset a scope config matches, or "custom" when the behavior
 * fields are mixed. Used by the settings panel to show current state; presets
 * are bundles, never stored state.
 */
export function inferScopePreset(
  scope: ProjectScopeConfig,
): ScopePreset | "custom" {
  for (const preset of ["project", "home", "unrestricted"] as const) {
    const fields = SCOPE_PRESET_FIELDS[preset];
    if (
      scope.safeHomeUseDefaults === fields.safeHomeUseDefaults &&
      (scope.agentSupportUseDefaults ?? true) ===
        fields.agentSupportUseDefaults &&
      (scope.homePathBehavior ?? "allow") === fields.homePathBehavior &&
      (scope.sensitivePathBehavior ?? "review") ===
        fields.sensitivePathBehavior &&
      scope.unknownPathBehavior === fields.unknownPathBehavior
    ) {
      return preset;
    }
  }
  return "custom";
}

export type ScopeCommandChange =
  | {
      readonly kind: "add-path";
      readonly field: ProjectScopeListField;
      readonly path: string;
    }
  | {
      readonly kind: "remove-path";
      readonly field: ProjectScopeListField;
      readonly path: string;
    }
  | {
      readonly kind: "unknown-path-behavior";
      readonly behavior: "review" | "deny";
    }
  | {
      readonly kind: "safe-home-defaults";
      readonly enabled: boolean;
    }
  | {
      readonly kind: "agent-support-defaults";
      readonly enabled: boolean;
    }
  | {
      readonly kind: "preset";
      readonly preset: ScopePreset;
    };

export type ReviewNoteDisplayCommandChange =
  | { readonly kind: "mode"; readonly mode: ReviewNoteMode }
  | { readonly kind: "show-model-label"; readonly enabled: boolean }
  | { readonly kind: "accent"; readonly enabled: boolean };

export type ReviewerCommandChange =
  | { readonly kind: "prompt-posture"; readonly promptPosture: string }
  | { readonly kind: "context-mode"; readonly contextMode: ReviewerContextMode }
  | {
      readonly kind: "token-budget";
      readonly limit: number | null;
      readonly window?: string;
    }
  | {
      readonly kind: "escalation";
      readonly enabled?: boolean;
      readonly denialLimit?: number;
      readonly window?: string;
    }
  | {
      readonly kind: "prompt-append";
      readonly target: ReviewerPromptAppendTarget;
      readonly text: string;
    }
  | { readonly kind: "prompt-override"; readonly prompt: string | null }
  | { readonly kind: "reviewer-model"; readonly model: string | null };

type Mutable<T> = T extends readonly (infer U)[]
  ? Mutable<U>[]
  : T extends object
    ? { -readonly [K in keyof T]: Mutable<T[K]> }
    : T;

export type PlanReviewerCommandChangeResult =
  | { readonly ok: true; readonly plan: ConfigCommandPlan }
  | { readonly ok: false; readonly reason: string };

export type PlanReviewNoteDisplayCommandChangeResult =
  | { readonly ok: true; readonly plan: ConfigCommandPlan }
  | { readonly ok: false; readonly reason: string };

export type PlanProjectScopeCommandChangeResult =
  | {
      readonly ok: true;
      readonly plan: ConfigCommandPlan;
      readonly resolvedAfter: ResolvedProjectScope;
    }
  | { readonly ok: false; readonly reason: string };

export function planModeCommandChange(input: {
  readonly mode: ClearanceMode;
  readonly resolvedConfig: ResolvedConfig;
}):
  | { readonly ok: true; readonly plan: ConfigCommandPlan }
  | { readonly ok: false; readonly reason: string } {
  const snapshots = input.resolvedConfig.sourceSnapshots;
  if (snapshots === undefined) {
    return {
      ok: false,
      reason:
        "resolved config did not include source snapshots; reload config before planning a mode write",
    };
  }
  const before = cloneJsonish(snapshots.global);
  const after = cloneJsonish(before) as Mutable<GlobalConfig>;
  after.mode = input.mode;
  const patch = fieldPatch("/mode", before.mode, input.mode);
  const title = `Set Clearance mode to ${input.mode}`;
  const planWithoutId = {
    target: { kind: "global", path: snapshots.paths.globalConfigFile },
    title,
    summary:
      patch.length === 0
        ? `Clearance mode is already ${input.mode}; no config write is needed.`
        : `${title}; deterministic review results will be dispatched according to this mode.`,
    patch,
    before,
    after,
    requiredAcknowledgementCodes: [],
    warnings: [],
  } satisfies Omit<ConfigCommandPlan, "id">;
  return {
    ok: true,
    plan: {
      id: deterministicPlanId({ mode: input.mode, ...planWithoutId }),
      ...planWithoutId,
    },
  };
}

export function planReviewerCommandChange(input: {
  readonly change: ReviewerCommandChange;
  readonly resolvedConfig: ResolvedConfig;
  readonly cwd: string;
}): PlanReviewerCommandChangeResult {
  const snapshots = input.resolvedConfig.sourceSnapshots;
  if (snapshots === undefined) {
    return {
      ok: false,
      reason:
        "resolved config did not include source snapshots; reload config before planning a reviewer write",
    };
  }

  const paths = snapshots.paths;
  const globalBefore = cloneJsonish(snapshots.global);
  const projectBefore = cloneJsonish(snapshots.project);
  const globalAfter = cloneJsonish(globalBefore) as Mutable<GlobalConfig>;
  const projectAfter = cloneJsonish(
    projectBefore,
  ) as Mutable<ProjectOverlayConfig>;

  const planned = buildReviewerPatch({
    change: input.change,
    globalBefore,
    globalAfter,
    projectBefore,
    projectAfter,
  });
  const targetPath =
    planned.targetKind === "global"
      ? paths.globalConfigFile
      : paths.projectOverlayFile;
  const warnings = reviewerPlanWarnings({
    change: input.change,
    resolvedConfig: input.resolvedConfig,
  });
  const requiredAcknowledgementCodes = warnings
    .filter((warning) => warning.requiresAcknowledgement)
    .map((warning) => warning.code);
  const before = planned.targetKind === "global" ? globalBefore : projectBefore;
  const after = planned.targetKind === "global" ? globalAfter : projectAfter;
  const label = labelForReviewerChange(input.change);
  const planWithoutId = {
    target: { kind: planned.targetKind, path: targetPath },
    title: label,
    summary:
      planned.patch.length === 0
        ? `${label} is already reflected in config; no config write is needed.`
        : `${label} in ${planned.targetKind === "global" ? "global reviewer config" : "project prompt overlay"}.`,
    patch: planned.patch,
    before,
    after,
    requiredAcknowledgementCodes,
    warnings,
  } satisfies Omit<ConfigCommandPlan, "id">;

  return {
    ok: true,
    plan: {
      id: deterministicPlanId({
        reviewerChange: input.change,
        ...planWithoutId,
      }),
      ...planWithoutId,
    },
  };
}

export function planReviewNoteDisplayCommandChange(input: {
  readonly change: ReviewNoteDisplayCommandChange;
  readonly resolvedConfig: ResolvedConfig;
  readonly cwd: string;
}): PlanReviewNoteDisplayCommandChangeResult {
  if (input.change.kind === "mode" && !isReviewNoteMode(input.change.mode)) {
    return {
      ok: false,
      reason: `unknown review-note display mode: ${String(input.change.mode)}`,
    };
  }

  const snapshots = input.resolvedConfig.sourceSnapshots;
  if (snapshots === undefined) {
    return {
      ok: false,
      reason:
        "resolved config did not include source snapshots; reload config before planning a review-note display write",
    };
  }

  const globalBefore = cloneJsonish(snapshots.global);
  const globalAfter = cloneJsonish(globalBefore) as Mutable<GlobalConfig>;
  const patch = buildReviewNoteDisplayPatch({
    change: input.change,
    globalBefore,
    globalAfter,
  });
  const label = labelForReviewNoteDisplayChange(input.change);
  const planWithoutId = {
    target: { kind: "global", path: snapshots.paths.globalConfigFile },
    title: label,
    summary:
      patch.length === 0
        ? `${label} is already reflected in global display config; no config write is needed.`
        : `${label} in global display config.`,
    patch,
    before: globalBefore,
    after: globalAfter,
    requiredAcknowledgementCodes: [],
    warnings: [],
  } satisfies Omit<ConfigCommandPlan, "id">;

  return {
    ok: true,
    plan: {
      id: deterministicPlanId({
        reviewNoteDisplayChange: input.change,
        ...planWithoutId,
      }),
      ...planWithoutId,
    },
  };
}

export function planProjectScopeCommandChange(input: {
  readonly change: ScopeCommandChange;
  readonly resolvedConfig: ResolvedConfig;
  readonly cwd: string;
}): PlanProjectScopeCommandChangeResult {
  const snapshots = input.resolvedConfig.sourceSnapshots;
  if (snapshots === undefined) {
    return {
      ok: false,
      reason:
        "resolved config did not include source snapshots; reload config before planning a project-scope write",
    };
  }

  const projectBefore = cloneJsonish(snapshots.project);
  const projectAfter = cloneJsonish(
    projectBefore,
  ) as Mutable<ProjectOverlayConfig>;
  const patch = buildProjectScopePatch({
    change: input.change,
    projectBefore,
    projectAfter,
  });
  const validation = validateProjectScopeConfig({
    cwd: input.cwd,
    projectScope: projectAfter.projectScope,
    pathForErrors: snapshots.paths.projectOverlayFile,
  });
  if (validation.errors.length > 0) {
    return {
      ok: false,
      reason: validation.errors.map((error) => error.message).join("; "),
    };
  }

  const warnings = projectScopePlanWarnings(input.change);
  const requiredAcknowledgementCodes = warnings
    .filter((warning) => warning.requiresAcknowledgement)
    .map((warning) => warning.code);
  const label = labelForProjectScopeChange(input.change);
  const planWithoutId = {
    target: { kind: "project", path: snapshots.paths.projectOverlayFile },
    title: label,
    summary:
      patch.length === 0
        ? `${label} is already reflected in the project overlay; no config write is needed.`
        : `${label} in the user-owned project overlay.`,
    patch,
    before: projectBefore,
    after: projectAfter,
    requiredAcknowledgementCodes,
    warnings,
  } satisfies Omit<ConfigCommandPlan, "id">;

  return {
    ok: true,
    plan: {
      id: deterministicPlanId({
        projectScopeChange: input.change,
        ...planWithoutId,
      }),
      ...planWithoutId,
    },
    resolvedAfter: validation.scope,
  };
}

function buildProjectScopePatch(input: {
  readonly change: ScopeCommandChange;
  readonly projectBefore: ProjectOverlayConfig;
  readonly projectAfter: Mutable<ProjectOverlayConfig>;
}): readonly JsonPatchOperation[] {
  switch (input.change.kind) {
    case "add-path":
      return buildProjectScopePathListPatch({
        field: input.change.field,
        path: input.change.path,
        action: "add",
        projectBefore: input.projectBefore,
        projectAfter: input.projectAfter,
      });
    case "remove-path":
      return buildProjectScopePathListPatch({
        field: input.change.field,
        path: input.change.path,
        action: "remove",
        projectBefore: input.projectBefore,
        projectAfter: input.projectAfter,
      });
    case "unknown-path-behavior":
      input.projectAfter.projectScope.unknownPathBehavior =
        input.change.behavior;
      return fieldPatch(
        "/projectScope/unknownPathBehavior",
        input.projectBefore.projectScope.unknownPathBehavior,
        input.change.behavior,
      );
    case "safe-home-defaults":
      input.projectAfter.projectScope.safeHomeUseDefaults =
        input.change.enabled;
      return fieldPatch(
        "/projectScope/safeHomeUseDefaults",
        input.projectBefore.projectScope.safeHomeUseDefaults,
        input.change.enabled,
      );
    case "agent-support-defaults":
      input.projectAfter.projectScope.agentSupportUseDefaults =
        input.change.enabled;
      return fieldPatch(
        "/projectScope/agentSupportUseDefaults",
        input.projectBefore.projectScope.agentSupportUseDefaults,
        input.change.enabled,
      );
    case "preset": {
      const fields = SCOPE_PRESET_FIELDS[input.change.preset];
      const before = input.projectBefore.projectScope;
      const after = input.projectAfter.projectScope;
      after.safeHomeUseDefaults = fields.safeHomeUseDefaults;
      after.agentSupportUseDefaults = fields.agentSupportUseDefaults;
      after.homePathBehavior = fields.homePathBehavior;
      after.sensitivePathBehavior = fields.sensitivePathBehavior;
      after.unknownPathBehavior = fields.unknownPathBehavior;
      return [
        ...fieldPatch(
          "/projectScope/safeHomeUseDefaults",
          before.safeHomeUseDefaults,
          fields.safeHomeUseDefaults,
        ),
        ...fieldPatch(
          "/projectScope/agentSupportUseDefaults",
          before.agentSupportUseDefaults,
          fields.agentSupportUseDefaults,
        ),
        ...fieldPatch(
          "/projectScope/homePathBehavior",
          before.homePathBehavior,
          fields.homePathBehavior,
        ),
        ...fieldPatch(
          "/projectScope/sensitivePathBehavior",
          before.sensitivePathBehavior,
          fields.sensitivePathBehavior,
        ),
        ...fieldPatch(
          "/projectScope/unknownPathBehavior",
          before.unknownPathBehavior,
          fields.unknownPathBehavior,
        ),
      ];
    }
  }
}

function buildProjectScopePathListPatch(input: {
  readonly field: ProjectScopeListField;
  readonly path: string;
  readonly action: "add" | "remove";
  readonly projectBefore: ProjectOverlayConfig;
  readonly projectAfter: Mutable<ProjectOverlayConfig>;
}): readonly JsonPatchOperation[] {
  const configuredBefore = input.projectBefore.projectScope[input.field];
  const before = configuredBefore ?? [];
  const after =
    input.action === "add"
      ? before.includes(input.path)
        ? before
        : [...before, input.path]
      : before.filter((entry) => entry !== input.path);

  input.projectAfter.projectScope[input.field] = [...after];
  if (configuredBefore === undefined && after.length === 0) {
    return [];
  }
  return fieldPatch(`/projectScope/${input.field}`, configuredBefore, after);
}

function projectScopePlanWarnings(
  change: ScopeCommandChange,
): readonly ConfigCommandWarning[] {
  const warnings: ConfigCommandWarning[] = [
    {
      code: "project-scope-lexical-only",
      message:
        "Project-scope paths are resolved lexically only; this is not a sandbox and does not follow symlinks or prove filesystem containment.",
      requiresAcknowledgement: false,
    },
  ];

  if (change.kind === "preset") {
    if (change.preset === "unrestricted") {
      warnings.push({
        code: "preset-unrestricted-breadth",
        message:
          "Full minus danger list auto-allows read-only commands across the home directory and project; credential and key paths (sensitive home) are hard-denied. This is the broadest shipped posture.",
        requiresAcknowledgement: true,
      });
    }
    if (change.preset === "project") {
      warnings.push({
        code: "preset-project-restrictive",
        message:
          "Project only sends any command touching paths outside the project to review, including common home-directory reads.",
        requiresAcknowledgement: false,
      });
    }
  }

  if (change.kind === "add-path" && change.field === "safeHomeDirectories") {
    warnings.push({
      code: "safe-home-home-relative",
      message:
        "Safe-home paths are resolved relative to $HOME, reject sensitive home entries, and do not check whether the directories exist.",
      requiresAcknowledgement: false,
    });
  }

  if (
    change.kind === "add-path" &&
    change.field === "agentSupportDirectories"
  ) {
    warnings.push({
      code: "agent-support-read-only",
      message:
        "Agent-support roots enable typed read/search/list only; paths are lexical, and Pi auth/provider credential paths retain sensitive-home review.",
      requiresAcknowledgement: false,
    });
  }

  return warnings;
}

function labelForProjectScopeChange(change: ScopeCommandChange): string {
  switch (change.kind) {
    case "add-path":
      return `Add ${projectScopeFieldLabel(change.field)} path ${change.path}`;
    case "remove-path":
      return `Remove ${projectScopeFieldLabel(change.field)} path ${change.path}`;
    case "unknown-path-behavior":
      return `Set unknown-path behavior to ${change.behavior}`;
    case "safe-home-defaults":
      return `${change.enabled ? "Enable" : "Disable"} safe-home defaults`;
    case "agent-support-defaults":
      return `${change.enabled ? "Enable" : "Disable"} agent-support defaults`;
    case "preset":
      return `Apply scope preset: ${SCOPE_PRESET_LABELS[change.preset]}`;
  }
}

function projectScopeFieldLabel(field: ProjectScopeListField): string {
  switch (field) {
    case "roots":
      return "project root";
    case "writableDirectories":
      return "writable directory";
    case "tempDirectories":
      return "temp directory";
    case "deniedDirectories":
      return "denied directory";
    case "safeHomeDirectories":
      return "safe-home directory";
    case "agentSupportDirectories":
      return "agent-support directory";
  }
}

function buildReviewNoteDisplayPatch(input: {
  readonly change: ReviewNoteDisplayCommandChange;
  readonly globalBefore: GlobalConfig;
  readonly globalAfter: Mutable<GlobalConfig>;
}): readonly JsonPatchOperation[] {
  switch (input.change.kind) {
    case "mode":
      input.globalAfter.display.reviewNote.mode = input.change.mode;
      return fieldPatch(
        "/display/reviewNote/mode",
        input.globalBefore.display.reviewNote.mode,
        input.change.mode,
      );
    case "show-model-label":
      input.globalAfter.display.reviewNote.showModelLabel =
        input.change.enabled;
      return fieldPatch(
        "/display/reviewNote/showModelLabel",
        input.globalBefore.display.reviewNote.showModelLabel,
        input.change.enabled,
      );
    case "accent":
      input.globalAfter.display.reviewNote.accent = input.change.enabled;
      return fieldPatch(
        "/display/reviewNote/accent",
        input.globalBefore.display.reviewNote.accent,
        input.change.enabled,
      );
  }
}

function labelForReviewNoteDisplayChange(
  change: ReviewNoteDisplayCommandChange,
): string {
  switch (change.kind) {
    case "mode":
      return `Set review-note display mode to ${change.mode}`;
    case "show-model-label":
      return `${change.enabled ? "Show" : "Hide"} review-note model labels`;
    case "accent":
      return `${change.enabled ? "Enable" : "Disable"} review-note accent`;
  }
}

function buildReviewerPatch(input: {
  readonly change: ReviewerCommandChange;
  readonly globalBefore: GlobalConfig;
  readonly globalAfter: Mutable<GlobalConfig>;
  readonly projectBefore: ProjectOverlayConfig;
  readonly projectAfter: Mutable<ProjectOverlayConfig>;
}): {
  readonly targetKind: ConfigCommandTargetKind;
  readonly patch: readonly JsonPatchOperation[];
} {
  switch (input.change.kind) {
    case "prompt-posture":
      input.globalAfter.reviewer.promptPosture = input.change.promptPosture;
      return {
        targetKind: "global",
        patch: fieldPatch(
          "/reviewer/promptPosture",
          input.globalBefore.reviewer.promptPosture,
          input.change.promptPosture,
        ),
      };
    case "context-mode":
      input.globalAfter.reviewer.contextMode = input.change.contextMode;
      return {
        targetKind: "global",
        patch: fieldPatch(
          "/reviewer/contextMode",
          input.globalBefore.reviewer.contextMode,
          input.change.contextMode,
        ),
      };
    case "token-budget":
      input.globalAfter.reviewer.tokenBudget = {
        ...input.globalAfter.reviewer.tokenBudget,
        limit: input.change.limit,
        ...(input.change.window === undefined
          ? {}
          : { window: input.change.window }),
      };
      return {
        targetKind: "global",
        patch: [
          ...fieldPatch(
            "/reviewer/tokenBudget/limit",
            input.globalBefore.reviewer.tokenBudget.limit,
            input.globalAfter.reviewer.tokenBudget.limit,
          ),
          ...(input.change.window === undefined
            ? []
            : fieldPatch(
                "/reviewer/tokenBudget/window",
                input.globalBefore.reviewer.tokenBudget.window,
                input.change.window,
              )),
        ],
      };
    case "escalation": {
      input.globalAfter.reviewer.escalation = {
        ...input.globalAfter.reviewer.escalation,
        ...(input.change.enabled === undefined
          ? {}
          : { enabled: input.change.enabled }),
        ...(input.change.denialLimit === undefined
          ? {}
          : { denialLimit: input.change.denialLimit }),
        ...(input.change.window === undefined
          ? {}
          : { window: input.change.window }),
      };
      return {
        targetKind: "global",
        patch: [
          ...(input.change.enabled === undefined
            ? []
            : fieldPatch(
                "/reviewer/escalation/enabled",
                input.globalBefore.reviewer.escalation.enabled,
                input.change.enabled,
              )),
          ...(input.change.denialLimit === undefined
            ? []
            : fieldPatch(
                "/reviewer/escalation/denialLimit",
                input.globalBefore.reviewer.escalation.denialLimit,
                input.change.denialLimit,
              )),
          ...(input.change.window === undefined
            ? []
            : fieldPatch(
                "/reviewer/escalation/window",
                input.globalBefore.reviewer.escalation.window,
                input.change.window,
              )),
        ],
      };
    }
    case "prompt-append":
      if (input.change.target === "global") {
        input.globalAfter.reviewer.promptAppends = [
          ...input.globalBefore.reviewer.promptAppends,
          input.change.text,
        ];
        return {
          targetKind: "global",
          patch: fieldPatch(
            "/reviewer/promptAppends",
            input.globalBefore.reviewer.promptAppends,
            input.globalAfter.reviewer.promptAppends,
          ),
        };
      }

      input.projectAfter.promptAppends = [
        ...input.projectBefore.promptAppends,
        input.change.text,
      ];
      return {
        targetKind: "project",
        patch: fieldPatch(
          "/promptAppends",
          input.projectBefore.promptAppends,
          input.projectAfter.promptAppends,
        ),
      };
    case "prompt-override":
      input.globalAfter.reviewer.promptOverride = input.change.prompt;
      return {
        targetKind: "global",
        patch: fieldPatch(
          "/reviewer/promptOverride",
          input.globalBefore.reviewer.promptOverride,
          input.change.prompt,
        ),
      };
    case "reviewer-model":
      input.globalAfter.reviewer.model = input.change.model;
      return {
        targetKind: "global",
        patch: fieldPatch(
          "/reviewer/model",
          input.globalBefore.reviewer.model,
          input.change.model,
        ),
      };
  }
}

function reviewerPlanWarnings(input: {
  readonly change: ReviewerCommandChange;
  readonly resolvedConfig: ResolvedConfig;
}): readonly ConfigCommandWarning[] {
  const warnings: ConfigCommandWarning[] = [];

  if (
    input.change.kind === "reviewer-model" &&
    input.change.model !== null &&
    isHighCostReviewerModel(input.change.model)
  ) {
    warnings.push({
      code: "reviewer-model-high-cost",
      message:
        "The configured reviewer model matches a shipped high-cost tier pattern. This is allowed, but routine model review may be expensive.",
      requiresAcknowledgement: false,
    });
  }

  return warnings;
}

function labelForReviewerChange(change: ReviewerCommandChange): string {
  switch (change.kind) {
    case "prompt-posture":
      return `Set reviewer prompt profile to ${change.promptPosture}`;
    case "context-mode":
      return `Set reviewer context mode to ${change.contextMode}`;
    case "token-budget":
      return change.limit === null
        ? "Clear reviewer token budget"
        : `Set reviewer token budget to ${change.limit}`;
    case "escalation":
      return change.enabled === false
        ? "Disable reviewer escalation"
        : "Set reviewer escalation";
    case "prompt-append":
      return `Append reviewer prompt guidance to ${change.target} config`;
    case "prompt-override":
      return change.prompt === null
        ? "Clear reviewer prompt override"
        : "Set reviewer prompt override";
    case "reviewer-model":
      return change.model === null
        ? "Clear reviewer model"
        : `Set reviewer model to ${change.model}`;
  }
}

function fieldPatch(
  pointer: string,
  before: unknown,
  after: unknown,
): readonly JsonPatchOperation[] {
  if (jsonEqual(before, after)) {
    return [];
  }

  return [
    before === undefined
      ? { op: "add", path: pointer, value: after }
      : { op: "replace", path: pointer, before, value: after },
  ];
}

function deterministicPlanId(value: unknown): string {
  const hash = createHash("sha256")
    .update(stableStringify(value))
    .digest("hex")
    .slice(0, 24);
  return `config-command:${hash}`;
}

function jsonEqual(a: unknown, b: unknown): boolean {
  return stableStringify(a) === stableStringify(b);
}

function stableStringify(value: unknown): string {
  return JSON.stringify(sortForStableStringify(value));
}

function sortForStableStringify(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortForStableStringify);
  }

  if (isRecord(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortForStableStringify(value[key])]),
    );
  }

  return value;
}

function cloneJsonish<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((entry) => cloneJsonish(entry)) as T;
  }

  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, cloneJsonish(entry)]),
    ) as T;
  }

  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
