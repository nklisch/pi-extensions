import { describe, expect, expectTypeOf, it } from "vitest";
import { z } from "zod";
import {
  CompatibilityReportSchema,
  ComponentAssessmentSchema,
  ComponentVerdictRegistry,
  ComponentVerdictSchema,
  RuntimeRequirementAssessmentSchema,
  RuntimeRequirementIdSchema,
  RuntimeRequirementSchema,
  RuntimeRequirementStatusRegistry,
  RuntimeRequirementStatusSchema,
  createCompatibilityReport,
  deriveActivatable,
  type CompatibilityReport,
  type ComponentAssessment,
  type ComponentVerdict,
  type RuntimeRequirementAssessment,
} from "../../src/domain/compatibility.js";
import { ComponentIdSchema } from "../../src/domain/components.js";
import { type Diagnostic } from "../../src/domain/errors.js";

const manifestLocation = {
  host: "claude" as const,
  documentKind: "manifest" as const,
  path: ".claude-plugin/plugin.json",
  pointer: "/hooks/0",
};

const componentIdFor = (value: string) => {
  const bytes = new TextEncoder().encode(value);
  let hex = "";
  for (let index = 0; index < 32; index += 1) {
    hex += (bytes[index % Math.max(bytes.length, 1)] ?? 0).toString(16).padStart(2, "0");
  }
  return ComponentIdSchema.parse(`component-v1:skill:${hex}`);
};

const requirement = (
  id: string,
  status: "available" | "unavailable",
): RuntimeRequirementAssessment =>
  RuntimeRequirementAssessmentSchema.parse({
    requirement: {
      id,
      capability: `capability.${id}`,
      description: `Requirement ${id}`,
      provenance: [{ location: manifestLocation }],
    },
    status,
    explanation: `${id} is ${status}`,
  });

const supported = (
  componentId: string,
  requirementIds: readonly string[] = [],
): ComponentAssessment =>
  ComponentAssessmentSchema.parse({
    componentId: componentIdFor(componentId),
    verdict: { kind: "supported" },
    requirementIds,
    diagnostics: [],
  });

const reportInput = (overrides: Record<string, unknown> = {}) => ({
  plugin: {
    key: "demo@community",
    marketplaceName: "community",
    marketplaceEntryName: "demo",
  },
  activatable: true,
  components: [supported("hook:start", ["subagent-hooks"])],
  requirements: [requirement("subagent-hooks", "available")],
  diagnostics: [] as Diagnostic[],
  ...overrides,
});

describe("compatibility verdict and requirement contracts", () => {
  it("accepts exactly the three component verdicts and rejects conditional", () => {
    for (const verdict of [
      { kind: "supported" },
      { kind: "metadata-only", reason: "presentation metadata" },
      { kind: "incompatible", reason: "not representable" },
    ]) {
      expect(ComponentVerdictSchema.safeParse(verdict).success).toBe(true);
    }
    expect(
      ComponentVerdictSchema.safeParse({
        kind: "conditional",
        reason: "needs a capability",
      }).success,
    ).toBe(false);
    expect(ComponentVerdictRegistry.incompatible.blocksActivation).toBe(true);
    expect(ComponentVerdictRegistry.metadataOnly.blocksActivation).toBe(false);
  });

  it("derives activation from cited runtime requirements only", () => {
    expect(
      deriveActivatable({
        components: [supported("hook:start", ["missing-runtime"])],
        requirements: [requirement("missing-runtime", "unavailable")],
      }),
    ).toBe(false);
    expect(
      deriveActivatable({
        components: [supported("skill:docs")],
        requirements: [requirement("optional-runtime", "unavailable")],
      }),
    ).toBe(true);
    expect(
      deriveActivatable({
        components: [
          {
            componentId: componentIdFor("metadata:label"),
            verdict: { kind: "metadata-only", reason: "display only" },
            requirementIds: [],
            diagnostics: [],
          },
          {
            componentId: componentIdFor("unsupported:thing"),
            verdict: { kind: "incompatible", reason: "not supported" },
            requirementIds: [],
            diagnostics: [],
          },
        ],
        requirements: [],
      }),
    ).toBe(false);
    expect(RuntimeRequirementStatusRegistry.unavailable.blocksActivation).toBe(true);
    expect(RuntimeRequirementStatusSchema.safeParse("conditional").success).toBe(false);
  });

  it("rejects dangling and duplicate graph references instead of guessing", () => {
    expect(() =>
      deriveActivatable({
        components: [supported("hook:start", ["does-not-exist"])],
        requirements: [],
      }),
    ).toThrow("unknown runtime requirement");

    expect(() =>
      deriveActivatable({
        components: [supported("hook:start"), supported("hook:start")],
        requirements: [],
      }),
    ).toThrow("duplicate component id");

    expect(() =>
      deriveActivatable({
        components: [
          {
            ...supported("hook:start", ["runtime", "runtime"]),
          },
        ],
        requirements: [requirement("runtime", "available")],
      }),
    ).toThrow("duplicate requirement reference");

    expect(() =>
      deriveActivatable({
        components: [
          {
            componentId: componentIdFor("metadata:label"),
            verdict: { kind: "metadata-only", reason: "display only" },
            requirementIds: [RuntimeRequirementIdSchema.parse("runtime")],
            diagnostics: [],
          },
        ],
        requirements: [requirement("runtime", "available")],
      }),
    ).toThrow("metadata-only component");
  });
});

describe("compatibility report", () => {
  it("parses a complete report and derives its activatable value", () => {
    const report = createCompatibilityReport(reportInput());
    expect(report.activatable).toBe(true);
    expect(report.components[0]?.requirementIds).toEqual(["subagent-hooks"]);
    expectTypeOf<z.infer<typeof CompatibilityReportSchema>>().toEqualTypeOf<CompatibilityReport>();
    expectTypeOf<z.infer<typeof ComponentAssessmentSchema>>().toEqualTypeOf<ComponentAssessment>();
    expectTypeOf<z.infer<typeof RuntimeRequirementSchema>>().toMatchTypeOf<{
      id: string;
      capability: string;
    }>();
    expectTypeOf<z.infer<typeof RuntimeRequirementAssessmentSchema>>().toEqualTypeOf<RuntimeRequirementAssessment>();
    expectTypeOf<z.infer<typeof ComponentVerdictSchema>>().toEqualTypeOf<ComponentVerdict>();
  });

  it("rejects an incorrect caller-supplied activatable value", () => {
    expect(() =>
      createCompatibilityReport(
        reportInput({
          activatable: false,
        }),
      ),
    ).toThrow();

    expect(
      CompatibilityReportSchema.safeParse(
        reportInput({
          components: [supported("hook:start", ["runtime"])],
          requirements: [requirement("runtime", "unavailable")],
          activatable: true,
        }),
      ).success,
    ).toBe(false);
  });

  it.each([
    [
      "dangling reference",
      reportInput({
        components: [supported("hook:start", ["missing"])],
        requirements: [],
      }),
    ],
    [
      "duplicate component id",
      reportInput({
        components: [supported("hook:start", ["subagent-hooks"]), supported("hook:start")],
      }),
    ],
    [
      "duplicate requirement id",
      reportInput({
        requirements: [requirement("subagent-hooks", "available"), requirement("subagent-hooks", "available")],
      }),
    ],
    [
      "metadata-only requirement citation",
      reportInput({
        components: [{
          componentId: componentIdFor("metadata:label"),
          verdict: { kind: "metadata-only", reason: "display only" },
          requirementIds: ["subagent-hooks"],
          diagnostics: [],
        }],
      }),
    ],
  ])("rejects %s", (_name, value) => {
    expect(CompatibilityReportSchema.safeParse(value).success).toBe(false);
  });
});
