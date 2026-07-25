import { createHash } from "node:crypto";

import {
  applyJsonPatchDocument,
  type ConfigCommandAcknowledgement,
  type ConfigCommandPlan,
  type ConfigCommandTargetKind,
  type ConfigCommandWarning,
} from "../config/config-command-writer.ts";
import {
  type ResolvedConfig,
  validateProjectScopeConfig,
} from "../config/loader.ts";
import {
  type GlobalConfig,
  GlobalConfigSchema,
  normalizeConfig,
  type ProjectOverlayConfig,
  ProjectOverlaySchema,
} from "../config/schema.ts";
import type { PackEnablementAcknowledgement } from "../packs/enablement.ts";
import { trustNoteRequiredAcknowledgements } from "./proposal-acknowledgements.ts";
import { isDesignInputOnlyProposal } from "./proposal-approval.ts";
import type {
  JsonPatchOperation,
  StructuredRatchetProposal,
} from "./proposal-schema.ts";
import { validateStructuredProposal } from "./proposal-schema.ts";

export type RatchetProposalWritePlan =
  | {
      readonly kind: "config-command";
      readonly proposalId: string;
      readonly plan: ConfigCommandPlan;
      readonly acknowledgement: ConfigCommandAcknowledgement;
    }
  | {
      readonly kind: "pack-enablement";
      readonly proposalId: string;
      readonly plan: Extract<
        StructuredRatchetProposal["change"],
        { readonly kind: "package-pack-enablement" }
      >["plan"];
      readonly acknowledgement: PackEnablementAcknowledgement;
    };

export type RatchetProposalWritePlanResult =
  | { readonly ok: true; readonly writePlan: RatchetProposalWritePlan }
  | {
      readonly ok: false;
      readonly proposalId: string;
      readonly reason: string;
      readonly errors: readonly string[];
    };

export interface MaterializeRatchetProposalWritePlanInput {
  readonly proposal: StructuredRatchetProposal;
  readonly resolvedConfig: ResolvedConfig;
  readonly cwd: string;
}

export function materializeRatchetProposalWritePlan(
  input: MaterializeRatchetProposalWritePlanInput,
): RatchetProposalWritePlanResult {
  const schema = validateStructuredProposal(input.proposal);
  if (!schema.ok) {
    return refusal(input.proposal.id, "proposal failed schema validation", [
      ...schema.errors,
    ]);
  }

  if (isDesignInputOnlyProposal(input.proposal)) {
    return refusal(input.proposal.id, "proposal is design-input-only", [
      "design-input proposals are not materialized as writer plans",
    ]);
  }

  const snapshots = input.resolvedConfig.sourceSnapshots;
  if (snapshots === undefined) {
    return refusal(
      input.proposal.id,
      "resolved config did not include source snapshots",
      [
        "reload or resolve config with sourceSnapshots before materializing a ratchet proposal writer plan",
      ],
    );
  }

  switch (input.proposal.kind) {
    case "data-pack-policy":
      return materializeConfigPlan({
        proposal: input.proposal,
        cwd: input.cwd,
        paths: snapshots.paths,
        global: snapshots.global,
        project: snapshots.project,
        patchResult: policyPackPatch(input.proposal),
      });
    case "reviewer-config":
      return materializeConfigPlan({
        proposal: input.proposal,
        cwd: input.cwd,
        paths: snapshots.paths,
        global: snapshots.global,
        project: snapshots.project,
        patchResult: reviewerConfigPatch(input.proposal, snapshots),
      });
    case "project-scope-config":
      return materializeConfigPlan({
        proposal: input.proposal,
        cwd: input.cwd,
        paths: snapshots.paths,
        global: snapshots.global,
        project: snapshots.project,
        patchResult: projectScopePatch(input.proposal),
      });
    case "package-pack-enablement":
      return materializePackEnablementPlan(input.proposal, snapshots.paths);
    case "pack-file-authoring":
      return refusal(input.proposal.id, "proposal kind is not writable", [
        "pack-file-authoring proposals route as design input and never to config writers",
      ]);
  }
}

type ConfigSnapshotPaths = NonNullable<
  ResolvedConfig["sourceSnapshots"]
>["paths"];

type ConfigPatchResult =
  | { readonly ok: true; readonly patch: readonly JsonPatchOperation[] }
  | {
      readonly ok: false;
      readonly reason: string;
      readonly errors: readonly string[];
    };

function materializeConfigPlan(input: {
  readonly proposal: StructuredRatchetProposal;
  readonly cwd: string;
  readonly paths: ConfigSnapshotPaths;
  readonly global: GlobalConfig;
  readonly project: ProjectOverlayConfig;
  readonly patchResult: ConfigPatchResult;
}): RatchetProposalWritePlanResult {
  const target = configTarget(input.proposal, input.paths);
  if (!target.ok) {
    return refusal(input.proposal.id, target.reason, target.errors);
  }

  if (!input.patchResult.ok) {
    return refusal(
      input.proposal.id,
      input.patchResult.reason,
      input.patchResult.errors,
    );
  }

  const before = cloneJsonish(
    target.kind === "global" ? input.global : input.project,
  );
  const patched = patchAndNormalize({
    targetKind: target.kind,
    before,
    patch: input.patchResult.patch,
  });
  if (!patched.ok) {
    return refusal(input.proposal.id, patched.reason, patched.errors);
  }

  const projectScopeValidation = validateProjectScopePlan({
    proposal: input.proposal,
    cwd: input.cwd,
    targetPath: target.path,
    after: patched.after,
  });
  if (!projectScopeValidation.ok) {
    return refusal(
      input.proposal.id,
      projectScopeValidation.reason,
      projectScopeValidation.errors,
    );
  }

  const warnings = configWarnings(input.proposal);
  const requiredAcknowledgementCodes = warnings
    .filter((warning) => warning.requiresAcknowledgement)
    .map((warning) => warning.code);
  const planWithoutId = {
    target: { kind: target.kind, path: target.path },
    title: input.proposal.title,
    summary: input.proposal.summary,
    patch: input.patchResult.patch,
    before,
    after: patched.after,
    requiredAcknowledgementCodes,
    warnings,
  } satisfies Omit<ConfigCommandPlan, "id">;
  const plan: ConfigCommandPlan = {
    id: ratchetPlanId({ proposalId: input.proposal.id, ...planWithoutId }),
    ...planWithoutId,
  };

  return {
    ok: true,
    writePlan: {
      kind: "config-command",
      proposalId: input.proposal.id,
      plan,
      acknowledgement: {
        confirmedPlanId: plan.id,
        acknowledgedWarningCodes: [...plan.requiredAcknowledgementCodes],
      },
    },
  };
}

function materializePackEnablementPlan(
  proposal: StructuredRatchetProposal,
  paths: ConfigSnapshotPaths,
): RatchetProposalWritePlanResult {
  if (
    proposal.target.kind !== "package-pack-config" ||
    proposal.change.kind !== "package-pack-enablement"
  ) {
    return refusal(proposal.id, "package enablement proposal shape mismatch", [
      "package-pack-enablement proposals must target package-pack-config and carry a package-pack-enablement change",
    ]);
  }

  const plan = proposal.change.plan;
  const expectedPath =
    plan.request.scope === "global"
      ? paths.globalConfigFile
      : paths.projectOverlayFile;
  const errors: string[] = [];
  if (proposal.target.path !== expectedPath) {
    errors.push(
      `proposal target path ${JSON.stringify(
        proposal.target.path,
      )} does not match current ${plan.request.scope} config path ${JSON.stringify(
        expectedPath,
      )}`,
    );
  }
  if (plan.targetPath !== proposal.target.path) {
    errors.push(
      `proposal target path ${JSON.stringify(
        proposal.target.path,
      )} does not match previewed pack enablement plan target ${JSON.stringify(
        plan.targetPath,
      )}`,
    );
  }
  if (proposal.target.packId !== plan.request.packId) {
    errors.push(
      `proposal target packId ${JSON.stringify(
        proposal.target.packId,
      )} does not match previewed plan packId ${JSON.stringify(
        plan.request.packId,
      )}`,
    );
  }

  if (errors.length > 0) {
    return refusal(proposal.id, "package enablement target mismatch", errors);
  }

  return {
    ok: true,
    writePlan: {
      kind: "pack-enablement",
      proposalId: proposal.id,
      plan,
      acknowledgement: packEnablementAcknowledgement(plan),
    },
  };
}

function configTarget(
  proposal: StructuredRatchetProposal,
  paths: ConfigSnapshotPaths,
):
  | {
      readonly ok: true;
      readonly kind: ConfigCommandTargetKind;
      readonly path: string;
    }
  | {
      readonly ok: false;
      readonly reason: string;
      readonly errors: readonly string[];
    } {
  switch (proposal.target.kind) {
    case "user-global-config":
      if (proposal.target.path !== paths.globalConfigFile) {
        return {
          ok: false,
          reason: "proposal target path mismatch",
          errors: [
            `proposal target path ${JSON.stringify(
              proposal.target.path,
            )} does not match current global config path ${JSON.stringify(
              paths.globalConfigFile,
            )}`,
          ],
        };
      }
      return { ok: true, kind: "global", path: paths.globalConfigFile };
    case "user-project-overlay":
      if (proposal.target.path !== paths.projectOverlayFile) {
        return {
          ok: false,
          reason: "proposal target path mismatch",
          errors: [
            `proposal target path ${JSON.stringify(
              proposal.target.path,
            )} does not match current project overlay path ${JSON.stringify(
              paths.projectOverlayFile,
            )}`,
          ],
        };
      }
      return { ok: true, kind: "project", path: paths.projectOverlayFile };
    case "package-pack-config":
    case "design-input":
      return {
        ok: false,
        reason: "proposal target is not a generic config writer target",
        errors: [
          `target kind "${proposal.target.kind}" cannot be materialized as a ConfigCommandPlan`,
        ],
      };
  }
}

function policyPackPatch(
  proposal: StructuredRatchetProposal,
): ConfigPatchResult {
  if (proposal.change.kind !== "policy-pack") {
    return {
      ok: false,
      reason: "proposal change kind mismatch",
      errors: [
        `data-pack-policy proposals must carry a policy-pack change, got "${proposal.change.kind}"`,
      ],
    };
  }

  if (proposal.change.fileWrite !== undefined) {
    if (proposal.target.kind === "design-input") {
      return {
        ok: false,
        reason: "proposal is design-input-only",
        errors: ["design-input policy proposals cannot carry writer plans"],
      };
    }
    if (proposal.change.fileWrite.path !== proposal.target.path) {
      return {
        ok: false,
        reason: "proposal fileWrite path mismatch",
        errors: [
          `fileWrite path ${JSON.stringify(
            proposal.change.fileWrite.path,
          )} does not match proposal target path ${JSON.stringify(
            proposal.target.path,
          )}`,
        ],
      };
    }
  }

  return { ok: true, patch: [...proposal.change.rawPackPatch] };
}

function projectScopePatch(
  proposal: StructuredRatchetProposal,
): ConfigPatchResult {
  if (proposal.change.kind !== "project-scope-config") {
    return {
      ok: false,
      reason: "proposal change kind mismatch",
      errors: [
        `project-scope-config proposals must carry a project-scope-config change, got "${proposal.change.kind}"`,
      ],
    };
  }
  if (proposal.target.kind !== "user-project-overlay") {
    return {
      ok: false,
      reason: "project scope target mismatch",
      errors: [
        "project-scope proposals may only write the user project overlay",
      ],
    };
  }
  return { ok: true, patch: [...proposal.change.patch] };
}

function reviewerConfigPatch(
  proposal: StructuredRatchetProposal,
  snapshots: NonNullable<ResolvedConfig["sourceSnapshots"]>,
): ConfigPatchResult {
  if (proposal.change.kind !== "reviewer-config") {
    return {
      ok: false,
      reason: "proposal change kind mismatch",
      errors: [
        `reviewer-config proposals must carry a reviewer-config change, got "${proposal.change.kind}"`,
      ],
    };
  }

  const targetKind =
    proposal.target.kind === "user-global-config"
      ? "global"
      : proposal.target.kind === "user-project-overlay"
        ? "project"
        : undefined;
  if (targetKind === undefined) {
    return {
      ok: false,
      reason: "reviewer config target mismatch",
      errors: [
        "reviewer-config proposals may only write global config or project overlays",
      ],
    };
  }

  const beforeDocument =
    targetKind === "global" ? snapshots.global : snapshots.project;
  const change = proposal.change;

  switch (change.op) {
    case "append-string":
      return reviewerAppendPatch(
        beforeDocument,
        change.pointer,
        change.before,
        change.after,
      );
    case "set":
      return reviewerSetPatch(
        beforeDocument,
        change.pointer,
        change.before,
        change.after,
      );
    case "remove":
      return reviewerRemovePatch(beforeDocument, change.pointer, change.before);
  }
}

function reviewerAppendPatch(
  beforeDocument: unknown,
  pointer: string,
  before: unknown,
  after: unknown,
): ConfigPatchResult {
  if (typeof after !== "string") {
    return {
      ok: false,
      reason: "reviewer append-string payload is malformed",
      errors: [
        "reviewer append-string changes must carry a string `after` value",
      ],
    };
  }
  if (!pointer.endsWith("/-")) {
    return {
      ok: false,
      reason: "reviewer append-string pointer is malformed",
      errors: [
        `append-string pointer ${JSON.stringify(pointer)} must target an array append using /-`,
      ],
    };
  }

  const parentPointer = pointer.slice(0, -2);
  const current = readJsonPointer(beforeDocument, parentPointer);
  if (!current.exists) {
    return {
      ok: false,
      reason: "reviewer append target is missing",
      errors: [`append-string parent pointer ${parentPointer} does not exist`],
    };
  }
  if (!Array.isArray(current.value)) {
    return {
      ok: false,
      reason: "reviewer append target is not an array",
      errors: [`append-string parent pointer ${parentPointer} is not an array`],
    };
  }
  if (!jsonEqual(current.value, before)) {
    return {
      ok: false,
      reason: "reviewer append proposal is stale",
      errors: [
        `current value at ${parentPointer} does not match proposal before snapshot`,
      ],
    };
  }

  return { ok: true, patch: [{ op: "add", path: pointer, value: after }] };
}

function reviewerSetPatch(
  beforeDocument: unknown,
  pointer: string,
  before: unknown,
  after: unknown,
): ConfigPatchResult {
  const current = readJsonPointer(beforeDocument, pointer);
  if (!current.exists) {
    if (before !== undefined) {
      return {
        ok: false,
        reason: "reviewer set proposal is stale",
        errors: [
          `proposal before snapshot expects a value at ${pointer}, but the current config has no value there`,
        ],
      };
    }
    return { ok: true, patch: [{ op: "add", path: pointer, value: after }] };
  }

  if (!jsonEqual(current.value, before)) {
    return {
      ok: false,
      reason: "reviewer set proposal is stale",
      errors: [
        `current value at ${pointer} does not match proposal before snapshot`,
      ],
    };
  }

  return {
    ok: true,
    patch: [{ op: "replace", path: pointer, before, value: after }],
  };
}

function reviewerRemovePatch(
  beforeDocument: unknown,
  pointer: string,
  before: unknown,
): ConfigPatchResult {
  const current = readJsonPointer(beforeDocument, pointer);
  if (!current.exists) {
    return {
      ok: false,
      reason: "reviewer remove target is missing",
      errors: [
        `remove pointer ${pointer} does not exist in the current config`,
      ],
    };
  }
  if (!jsonEqual(current.value, before)) {
    return {
      ok: false,
      reason: "reviewer remove proposal is stale",
      errors: [
        `current value at ${pointer} does not match proposal before snapshot`,
      ],
    };
  }
  return { ok: true, patch: [{ op: "remove", path: pointer, before }] };
}

function patchAndNormalize(input: {
  readonly targetKind: ConfigCommandTargetKind;
  readonly before: GlobalConfig | ProjectOverlayConfig;
  readonly patch: readonly JsonPatchOperation[];
}):
  | { readonly ok: true; readonly after: GlobalConfig | ProjectOverlayConfig }
  | {
      readonly ok: false;
      readonly reason: string;
      readonly errors: readonly string[];
    } {
  const preconditionErrors = patchPreconditionErrors(input.before, input.patch);
  if (preconditionErrors.length > 0) {
    return {
      ok: false,
      reason: "proposal patch preconditions do not match current config",
      errors: preconditionErrors,
    };
  }

  let patchedRaw: unknown;
  try {
    patchedRaw = applyJsonPatchDocument(input.before, input.patch);
  } catch (error) {
    return {
      ok: false,
      reason: "proposal patch could not be applied",
      errors: [errorMessage(error)],
    };
  }

  const result =
    input.targetKind === "global"
      ? normalizeConfig(GlobalConfigSchema, cloneJsonish(patchedRaw))
      : normalizeConfig(ProjectOverlaySchema, cloneJsonish(patchedRaw));
  if (!result.ok) {
    return {
      ok: false,
      reason: "proposal patch produced invalid config",
      errors: result.errors.map((error) => `${error.path}: ${error.message}`),
    };
  }

  return { ok: true, after: result.value };
}

function patchPreconditionErrors(
  before: GlobalConfig | ProjectOverlayConfig,
  patch: readonly JsonPatchOperation[],
): readonly string[] {
  const errors: string[] = [];
  for (const operation of patch) {
    if (operation.op === "add") {
      continue;
    }

    const current = readJsonPointer(before, operation.path);
    if (!current.exists) {
      errors.push(
        `${operation.op} patch path ${operation.path} does not exist in the current config`,
      );
      continue;
    }

    if (!hasOwn(operation, "before")) {
      errors.push(
        `${operation.op} patch path ${operation.path} is missing a before snapshot`,
      );
      continue;
    }

    if (!jsonEqual(current.value, operation.before)) {
      errors.push(
        `${operation.op} patch path ${operation.path} before snapshot does not match the current config`,
      );
    }
  }
  return errors;
}

function validateProjectScopePlan(input: {
  readonly proposal: StructuredRatchetProposal;
  readonly cwd: string;
  readonly targetPath: string;
  readonly after: GlobalConfig | ProjectOverlayConfig;
}):
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason: string;
      readonly errors: readonly string[];
    } {
  if (input.proposal.kind !== "project-scope-config") {
    return { ok: true };
  }
  if (!isProjectOverlayConfig(input.after)) {
    return {
      ok: false,
      reason: "project-scope proposal did not produce a project overlay",
      errors: [
        "project-scope-config proposals must materialize against the project overlay target",
      ],
    };
  }

  const validation = validateProjectScopeConfig({
    cwd: input.cwd,
    projectScope: input.after.projectScope,
    pathForErrors: input.targetPath,
  });
  if (validation.errors.length === 0) {
    return { ok: true };
  }
  return {
    ok: false,
    reason: "proposal project scope failed semantic validation",
    errors: validation.errors.map((error) => `${error.path}: ${error.message}`),
  };
}

function isProjectOverlayConfig(
  value: GlobalConfig | ProjectOverlayConfig,
): value is ProjectOverlayConfig {
  return (
    isRecord(value) &&
    hasOwn(value, "projectScope") &&
    isRecord(value.projectScope)
  );
}

function configWarnings(
  proposal: StructuredRatchetProposal,
): readonly ConfigCommandWarning[] {
  return [
    ...trustNoteRequiredAcknowledgements(proposal.trustNotes).map(
      (acknowledgement): ConfigCommandWarning => ({
        code: acknowledgement.code,
        message: `${acknowledgement.severity} trust note ${acknowledgement.kind}: ${acknowledgement.message}`,
        requiresAcknowledgement: true,
      }),
    ),
    ...proposal.warnings.map((message, index) => ({
      code: `ratchet-proposal-warning-${index}`,
      message,
      requiresAcknowledgement: false,
    })),
  ];
}

function packEnablementAcknowledgement(
  plan: Extract<
    StructuredRatchetProposal["change"],
    { readonly kind: "package-pack-enablement" }
  >["plan"],
): PackEnablementAcknowledgement {
  return {
    confirmedPlanId: plan.id,
    acknowledgedWarningCodes: [...plan.requiredAcknowledgementCodes],
  };
}

function ratchetPlanId(value: unknown): string {
  const hash = createHash("sha256")
    .update(stableStringify(value))
    .digest("hex")
    .slice(0, 24);
  return `ratchet-proposal:${hash}`;
}

function readJsonPointer(
  document: unknown,
  pointer: string,
):
  | { readonly exists: true; readonly value: unknown }
  | { readonly exists: false } {
  if (pointer === "") {
    return { exists: true, value: document };
  }
  if (!pointer.startsWith("/")) {
    return { exists: false };
  }

  let current = document;
  for (const token of parseJsonPointer(pointer)) {
    if (Array.isArray(current)) {
      if (!/^\d+$/u.test(token)) {
        return { exists: false };
      }
      const index = Number.parseInt(token, 10);
      if (index < 0 || index >= current.length) {
        return { exists: false };
      }
      current = current[index];
      continue;
    }
    if (!isRecord(current) || !(token in current)) {
      return { exists: false };
    }
    current = current[token];
  }
  return { exists: true, value: current };
}

function parseJsonPointer(pointer: string): readonly string[] {
  return pointer
    .split("/")
    .slice(1)
    .map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"));
}

function refusal(
  proposalId: string,
  reason: string,
  errors: readonly string[],
): RatchetProposalWritePlanResult {
  return { ok: false, proposalId, reason, errors };
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOwn<T extends object, K extends PropertyKey>(
  value: T,
  key: K,
): value is T & Record<K, unknown> {
  return Object.hasOwn(value, key);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
