import { z } from "zod";
import { ComponentIdSchema } from "./components.js";
import {
  DiagnosticSchema,
} from "./errors.js";
import { PluginIdentitySchema } from "./identity.js";
import { ProvenanceSchema } from "./provenance.js";

/** The only component verdicts in the machine-readable compatibility model. */
export const ComponentVerdictRegistry = {
  supported: {
    tag: "supported",
    label: "Supported",
    blocksActivation: false,
  },
  metadataOnly: {
    tag: "metadata-only",
    label: "Metadata only",
    blocksActivation: false,
  },
  incompatible: {
    tag: "incompatible",
    label: "Incompatible",
    blocksActivation: true,
  },
} as const;

/** Runtime capability assessments have independent blocking metadata. */
export const RuntimeRequirementStatusRegistry = {
  available: { tag: "available", blocksActivation: false },
  unavailable: { tag: "unavailable", blocksActivation: true },
} as const;

type RuntimeRequirementStatusTag =
  (typeof RuntimeRequirementStatusRegistry)[keyof typeof RuntimeRequirementStatusRegistry]["tag"];

const runtimeRequirementStatusTags = Object.values(
  RuntimeRequirementStatusRegistry,
).map((entry) => entry.tag) as [
  RuntimeRequirementStatusTag,
  ...RuntimeRequirementStatusTag[],
];

export const RuntimeRequirementIdSchema = z
  .string()
  .min(1)
  .brand<"RuntimeRequirementId">();
export type RuntimeRequirementId = z.infer<typeof RuntimeRequirementIdSchema>;

export const RuntimeRequirementSchema = z
  .object({
    id: RuntimeRequirementIdSchema,
    capability: z.string().min(1),
    description: z.string().min(1),
    provenance: z.array(ProvenanceSchema).readonly(),
  })
  .strict()
  .readonly();
export type RuntimeRequirement = z.infer<typeof RuntimeRequirementSchema>;

export const RuntimeRequirementStatusSchema = z.enum(
  runtimeRequirementStatusTags,
);
export type RuntimeRequirementStatus = z.infer<
  typeof RuntimeRequirementStatusSchema
>;

export const RuntimeRequirementAssessmentSchema = z
  .object({
    requirement: RuntimeRequirementSchema,
    status: RuntimeRequirementStatusSchema,
    explanation: z.string().min(1),
  })
  .strict()
  .readonly();
export type RuntimeRequirementAssessment = z.infer<
  typeof RuntimeRequirementAssessmentSchema
>;

const supportedVerdictSchema = z
  .object({ kind: z.literal(ComponentVerdictRegistry.supported.tag) })
  .strict();
const metadataOnlyVerdictSchema = z
  .object({
    kind: z.literal(ComponentVerdictRegistry.metadataOnly.tag),
    reason: z.string().min(1),
  })
  .strict();
const incompatibleVerdictSchema = z
  .object({
    kind: z.literal(ComponentVerdictRegistry.incompatible.tag),
    reason: z.string().min(1),
  })
  .strict();

export const ComponentVerdictSchema = z.discriminatedUnion("kind", [
  supportedVerdictSchema,
  metadataOnlyVerdictSchema,
  incompatibleVerdictSchema,
]);
export type ComponentVerdict = z.infer<typeof ComponentVerdictSchema>;

export const ComponentAssessmentSchema = z
  .object({
    componentId: ComponentIdSchema,
    verdict: ComponentVerdictSchema,
    requirementIds: z.array(RuntimeRequirementIdSchema).readonly(),
    diagnostics: z.array(DiagnosticSchema).readonly(),
  })
  .strict()
  .readonly();
export type ComponentAssessment = z.infer<typeof ComponentAssessmentSchema>;

function addIssue(
  context: z.RefinementCtx,
  path: readonly (string | number)[],
  message: string,
): void {
  context.addIssue({ code: "custom", path: [...path], message });
}

type ValidatedCompatibilityInput = Readonly<{
  components: readonly ComponentAssessment[];
  requirements: readonly RuntimeRequirementAssessment[];
}>;

/**
 * Validate the graph shared by report parsing and pure activatability
 * derivation. Keeping this invariant in one helper prevents a caller from
 * accidentally evaluating a report against a different requirement occurrence.
 */
function validateReferences(input: ValidatedCompatibilityInput): void {
  const componentIds = new Set<string>();
  for (const [componentIndex, component] of input.components.entries()) {
    if (componentIds.has(component.componentId)) {
      throw new Error(`duplicate component id: ${component.componentId}`);
    }
    componentIds.add(component.componentId);

    const localRequirementIds = new Set<string>();
    for (const requirementId of component.requirementIds) {
      if (localRequirementIds.has(requirementId)) {
        throw new Error(
          `duplicate requirement reference at components[${componentIndex}]: ${requirementId}`,
        );
      }
      localRequirementIds.add(requirementId);
    }

    if (
      component.verdict.kind === ComponentVerdictRegistry.metadataOnly.tag &&
      component.requirementIds.length > 0
    ) {
      throw new Error(
        `metadata-only component cannot cite runtime requirements: ${component.componentId}`,
      );
    }
  }

  const requirements = new Map<string, RuntimeRequirementAssessment>();
  for (const requirement of input.requirements) {
    const id = requirement.requirement.id;
    if (requirements.has(id)) {
      throw new Error(`duplicate runtime requirement id: ${id}`);
    }
    requirements.set(id, requirement);
  }

  for (const component of input.components) {
    for (const requirementId of component.requirementIds) {
      if (!requirements.has(requirementId)) {
        throw new Error(
          `component ${component.componentId} references unknown runtime requirement: ${requirementId}`,
        );
      }
    }
  }
}

function deriveValidatedActivatable(input: ValidatedCompatibilityInput): boolean {
  const requirementsById = new Map(
    input.requirements.map((assessment) => [
      assessment.requirement.id,
      assessment,
    ]),
  );

  return input.components.every((component) => {
    const verdictMetadata = Object.values(ComponentVerdictRegistry).find(
      (entry) => entry.tag === component.verdict.kind,
    );
    if (verdictMetadata?.blocksActivation === true) {
      return false;
    }

    if (component.verdict.kind !== ComponentVerdictRegistry.supported.tag) {
      return true;
    }

    return component.requirementIds.every(
      (requirementId) =>
        requirementsById.get(requirementId)?.status ===
        RuntimeRequirementStatusRegistry.available.tag,
    );
  });
}

/**
 * Derive activation from the complete graph. Invalid references are rejected
 * rather than treated as absent capabilities, which would make a malformed
 * report look safer than it is.
 */
export function deriveActivatable(input: ValidatedCompatibilityInput): boolean {
  const components = input.components.map((component) =>
    ComponentAssessmentSchema.parse(component),
  );
  const requirements = input.requirements.map((requirement) =>
    RuntimeRequirementAssessmentSchema.parse(requirement),
  );
  const validated = { components, requirements } as const;
  validateReferences(validated);
  return deriveValidatedActivatable(validated);
}

export const CompatibilityReportSchema = z
  .object({
    plugin: PluginIdentitySchema,
    activatable: z.boolean(),
    components: z.array(ComponentAssessmentSchema).readonly(),
    requirements: z.array(RuntimeRequirementAssessmentSchema).readonly(),
    diagnostics: z.array(DiagnosticSchema).readonly(),
  })
  .strict()
  .readonly()
  .superRefine((report, context) => {
    const componentIds = new Set<string>();
    const requirementIds = new Set<string>();
    let graphIsValid = true;

    for (const [index, component] of report.components.entries()) {
      if (componentIds.has(component.componentId)) {
        graphIsValid = false;
        addIssue(
          context,
          ["components", index, "componentId"],
          `duplicate component id: ${component.componentId}`,
        );
      } else {
        componentIds.add(component.componentId);
      }

      const localRequirementIds = new Set<string>();
      for (const [requirementIndex, requirementId] of component.requirementIds.entries()) {
        if (localRequirementIds.has(requirementId)) {
          graphIsValid = false;
          addIssue(
            context,
            ["components", index, "requirementIds", requirementIndex],
            `duplicate requirement reference: ${requirementId}`,
          );
        } else {
          localRequirementIds.add(requirementId);
        }
      }

      if (
        component.verdict.kind === ComponentVerdictRegistry.metadataOnly.tag &&
        component.requirementIds.length > 0
      ) {
        graphIsValid = false;
        addIssue(
          context,
          ["components", index, "requirementIds"],
          "metadata-only components cannot cite runtime requirements",
        );
      }
    }

    for (const [index, assessment] of report.requirements.entries()) {
      const requirementId = assessment.requirement.id;
      if (requirementIds.has(requirementId)) {
        graphIsValid = false;
        addIssue(
          context,
          ["requirements", index, "requirement", "id"],
          `duplicate runtime requirement id: ${requirementId}`,
        );
      } else {
        requirementIds.add(requirementId);
      }
    }

    for (const [componentIndex, component] of report.components.entries()) {
      for (const [requirementIndex, requirementId] of component.requirementIds.entries()) {
        if (!requirementIds.has(requirementId)) {
          graphIsValid = false;
          addIssue(
            context,
            ["components", componentIndex, "requirementIds", requirementIndex],
            `unknown runtime requirement id: ${requirementId}`,
          );
        }
      }
    }

    if (graphIsValid) {
      const derived = deriveValidatedActivatable({
        components: report.components,
        requirements: report.requirements,
      });
      if (report.activatable !== derived) {
        addIssue(
          context,
          ["activatable"],
          `activatable must equal derived value ${String(derived)}`,
        );
      }
    }
  });
export type CompatibilityReport = z.infer<typeof CompatibilityReportSchema>;

export function createCompatibilityReport(input: unknown): CompatibilityReport {
  return CompatibilityReportSchema.parse(input);
}
