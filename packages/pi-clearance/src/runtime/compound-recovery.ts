import { classifyStageEffect } from "../parse/native-effects.ts";
import type {
  BashPathFact,
  BashPipeline,
  BashStage,
  ToolShape,
} from "../parse/shape.ts";
import type { Decision } from "../policy/core.ts";

const SAFE_COMPOUND_SCOPES = new Set(["project", "writable-project", "temp"]);
const SHELL_PROGRAMS = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish"]);

interface CompoundContext {
  readonly construct: string;
  readonly reason: string;
  readonly suggestion?: string;
  readonly timeoutCaveat: boolean;
}

interface BodyEvidence {
  readonly program?: string;
  readonly effectClass: string;
  readonly effectReason: string;
  readonly hasSubstitution: boolean;
  readonly hasOutputFileRedirect: boolean;
  readonly pipeToShell: boolean;
}

/**
 * Render user-facing recovery evidence for compound shell review/deny paths.
 *
 * This is presentation only: it consumes analyzer/policy facts and never changes
 * the policy decision. Suggestions are deliberately sparse because an unsafe or
 * semantics-changing rewrite would be worse than no suggestion.
 */
export function compoundRecoveryReason(
  shape: ToolShape,
  decision: Decision,
): string | undefined {
  if (shape.kind !== "bash") return undefined;

  const context = compoundContext(shape, decision);
  if (context === undefined) return undefined;

  const parts = [`compound ${context.construct}: ${context.reason}`];
  if (context.timeoutCaveat) {
    parts.push("timeout/resource limits are not permission proof");
  }
  if (context.suggestion !== undefined) {
    parts.push(`Safe equivalent: ${context.suggestion}`);
  }
  return parts.join("; ");
}

function compoundContext(
  shape: Extract<ToolShape, { readonly kind: "bash" }>,
  decision: Decision,
): CompoundContext | undefined {
  const compoundStage = firstCompoundStage(shape.stages);
  const compoundDiagnostics = shape.diagnostics.filter((diagnostic) =>
    diagnostic.code.startsWith("bash:compound-"),
  );
  const isCompoundProvenance = decision.provenance.packId?.startsWith(
    "bash.review.compound",
  );

  if (
    compoundStage === undefined &&
    compoundDiagnostics.length === 0 &&
    !isCompoundProvenance
  ) {
    return undefined;
  }

  const construct = constructLabel(compoundStage);
  const evidence = collectBodyEvidence(shape.stages);
  const unsafeIterator = firstUnsafeIteratorFact(shape.pathFacts?.facts ?? []);
  const reason =
    reasonFromDiagnostics(compoundDiagnostics, compoundStage) ??
    reasonFromDecisionRule(decision, evidence, unsafeIterator) ??
    reasonFromBodyEvidence(evidence) ??
    reasonFromIteratorFact(unsafeIterator) ??
    reasonFromCompoundStage(compoundStage) ??
    "compound shell form needs reviewer judgment";

  const suggestion = safeSuggestion(shape, evidence, compoundDiagnostics);
  return {
    construct,
    reason,
    timeoutCaveat: hasTimeoutWrapper(shape.rawCommand),
    ...(suggestion === undefined ? {} : { suggestion }),
  };
}

function firstCompoundStage(
  stages: readonly BashStage[],
): BashStage | undefined {
  return stages.find((stage) =>
    ["for-loop", "brace-group", "conditional", "control-flow"].includes(
      stage.kind,
    ),
  );
}

function constructLabel(stage: BashStage | undefined): string {
  if (stage === undefined) return "shell form";
  switch (stage.kind) {
    case "for-loop":
      return "for loop";
    case "brace-group":
      return "brace group";
    case "conditional":
      return "conditional";
    case "control-flow":
      return `${stage.construct} construct`;
    default:
      return "shell form";
  }
}

function reasonFromDiagnostics(
  diagnostics: readonly { readonly code: string }[],
  stage: BashStage | undefined,
): string | undefined {
  if (
    diagnostics.some(
      (diagnostic) => diagnostic.code === "bash:compound-iterator-unsupported",
    )
  ) {
    return "iterator uses dynamic, opaque, or unsupported syntax";
  }
  if (
    diagnostics.some(
      (diagnostic) => diagnostic.code === "bash:compound-body-unsupported",
    )
  ) {
    return "body contains unsupported nested structure or unmodeled stages";
  }
  if (
    diagnostics.some(
      (diagnostic) => diagnostic.code === "bash:compound-feature-unsupported",
    )
  ) {
    return stage?.kind === "control-flow"
      ? `${stage.construct} is outside the modeled compound-shell subset`
      : "compound feature is outside the modeled subset";
  }
  return undefined;
}

function reasonFromDecisionRule(
  decision: Decision,
  evidence: readonly BodyEvidence[],
  unsafeIterator: BashPathFact | undefined,
): string | undefined {
  const ruleId = decision.provenance.ruleId;
  if (ruleId === undefined) return undefined;

  if (ruleId.endsWith(":review-for-iterator-out-of-scope")) {
    return (
      reasonFromIteratorFact(unsafeIterator) ??
      "iterator scope is not proven project/temp-scoped"
    );
  }
  if (ruleId.endsWith(":review-for-non-read-only-body")) {
    return (
      reasonFromBodyEvidence(evidence) ??
      "body is not proven read-only for every command"
    );
  }
  if (ruleId.endsWith(":review-brace-group")) {
    return "brace group is projected but not deterministically allowed";
  }
  if (ruleId.endsWith(":review-conditional")) {
    return "conditional is projected but not deterministically allowed";
  }
  return undefined;
}

function reasonFromBodyEvidence(
  evidence: readonly BodyEvidence[],
): string | undefined {
  const pipeToShell = evidence.find((entry) => entry.pipeToShell);
  if (pipeToShell !== undefined) return "pipeline sends output to a shell";

  const substitution = evidence.find((entry) => entry.hasSubstitution);
  if (substitution !== undefined) {
    return bodyReason(
      substitution,
      "contains command/process/arithmetic substitution",
    );
  }

  const redirect = evidence.find((entry) => entry.hasOutputFileRedirect);
  if (redirect !== undefined)
    return bodyReason(redirect, "uses output-file redirect");

  const unsafe = evidence.find((entry) => entry.effectClass !== "read-only");
  if (unsafe !== undefined) {
    return bodyReason(
      unsafe,
      `is ${unsafe.effectClass} (${unsafe.effectReason})`,
    );
  }

  return undefined;
}

function bodyReason(evidence: BodyEvidence, reason: string): string {
  return evidence.program === undefined
    ? `body ${reason}`
    : `body command ${evidence.program} ${reason}`;
}

function reasonFromIteratorFact(
  fact: BashPathFact | undefined,
): string | undefined {
  if (fact === undefined) return undefined;
  const reason = fact.provenance?.unknownReason ?? fact.unknownReason;
  const suffix = reason === undefined ? "" : ` (${reason})`;
  return `iterator scope is ${fact.scope}, not project/writable-project/temp${suffix}`;
}

function reasonFromCompoundStage(
  stage: BashStage | undefined,
): string | undefined {
  if (stage?.kind === "for-loop") {
    return "modeled read-only loop still needs reviewer judgment in this profile";
  }
  if (stage?.kind === "brace-group") {
    return "brace group is projected but not deterministically allowed";
  }
  if (stage?.kind === "conditional") {
    return "conditional is projected but not deterministically allowed";
  }
  if (stage?.kind === "control-flow") {
    return `${stage.construct} is outside the modeled compound-shell subset`;
  }
  return undefined;
}

function safeSuggestion(
  shape: Extract<ToolShape, { readonly kind: "bash" }>,
  evidence: readonly BodyEvidence[],
  diagnostics: readonly { readonly code: string }[],
): string | undefined {
  if (!isSafeReadOnlyCompoundInspection(shape, evidence, diagnostics)) {
    return undefined;
  }

  if (shape.rawCommand.includes(".work/")) {
    return "use Pi typed read/search tools for the exact project files, or `.work/bin/work-view --cat <id>` for specific .work items";
  }

  return "use Pi typed `read`, `grep`, `find`, `fffind`, or `ffgrep` on the exact project paths";
}

function isSafeReadOnlyCompoundInspection(
  shape: Extract<ToolShape, { readonly kind: "bash" }>,
  evidence: readonly BodyEvidence[],
  diagnostics: readonly { readonly code: string }[],
): boolean {
  if (diagnostics.length > 0) return false;
  if (!shape.stages.some((stage) => stage.kind === "for-loop")) return false;
  if (evidence.length === 0) return false;
  if (
    evidence.some(
      (entry) =>
        entry.effectClass !== "read-only" ||
        entry.hasSubstitution ||
        entry.hasOutputFileRedirect ||
        entry.pipeToShell,
    )
  ) {
    return false;
  }

  const loopFacts = (shape.pathFacts?.facts ?? []).filter(
    (fact) => fact.provenance?.kind === "loop-variable",
  );
  return (
    loopFacts.length > 0 &&
    loopFacts.every((fact) => SAFE_COMPOUND_SCOPES.has(fact.scope))
  );
}

function collectBodyEvidence(
  stages: readonly BashStage[],
): readonly BodyEvidence[] {
  return stages.flatMap((stage) => bodyEvidenceForStage(stage));
}

function bodyEvidenceForStage(stage: BashStage): readonly BodyEvidence[] {
  switch (stage.kind) {
    case "for-loop":
      return pipelineEvidence(stage.body.pipeline);
    case "brace-group":
      return pipelineEvidence(stage.body.pipeline);
    case "conditional":
      return stage.arms.flatMap((arm) => [
        ...pipelineEvidence(arm.test),
        ...pipelineEvidence(arm.body.pipeline),
        ...(stage.elseBody === undefined
          ? []
          : pipelineEvidence(stage.elseBody.pipeline)),
      ]);
    default:
      return [];
  }
}

function pipelineEvidence(pipeline: BashPipeline): readonly BodyEvidence[] {
  const pipeToShell = pipeline.pipeTargets.some((target) =>
    SHELL_PROGRAMS.has(target),
  );
  return pipeline.stages.map((stage) => stageEvidence(stage, pipeToShell));
}

function stageEvidence(stage: BashStage, pipeToShell: boolean): BodyEvidence {
  if (stage.kind !== "command") {
    return {
      effectClass: "unknown",
      effectReason: "non-command-stage",
      hasSubstitution: false,
      hasOutputFileRedirect: false,
      pipeToShell,
    };
  }

  const effect = classifyStageEffect(stage);
  return {
    program: stage.program.program,
    effectClass: effect.class,
    effectReason: effect.reason,
    hasSubstitution: stage.substitutions.length > 0,
    hasOutputFileRedirect: hasOutputFileRedirect(stage),
    pipeToShell,
  };
}

function hasOutputFileRedirect(
  stage: Extract<BashStage, { readonly kind: "command" }>,
): boolean {
  return stage.redirects.some(
    (redirect) =>
      redirect.targetKind === "file" &&
      (redirect.stream === "stdout" ||
        redirect.stream === "stderr" ||
        redirect.stream === "both" ||
        redirect.stream === "fd"),
  );
}

function firstUnsafeIteratorFact(
  facts: readonly BashPathFact[],
): BashPathFact | undefined {
  return facts.find(
    (fact) =>
      fact.provenance?.kind === "loop-variable" &&
      !SAFE_COMPOUND_SCOPES.has(fact.scope),
  );
}

function hasTimeoutWrapper(command: string): boolean {
  return /(^|[\s;&|()])timeout([\s;&|()]|$)/u.test(command);
}
