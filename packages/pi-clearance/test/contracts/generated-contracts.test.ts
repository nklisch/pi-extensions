import { describe, expect, it } from "vitest";
import type {
  BashCommandShape,
  Decision,
  MatcherExpr,
  PathFactsResolvedConfig,
  PolicyPack,
} from "../../src/contracts/index.ts";
import type { BashCommandShape as ShapeShim } from "../../src/parse/shape.ts";
import type {
  Decision as DecisionShim,
  MatcherExpr as MatcherShim,
} from "../../src/policy/core.ts";

const MATCHER_KINDS = [
  "always",
  "tool",
  "program",
  "arg0In",
  "argAt",
  "argCount",
  "envAssignmentCount",
  "argMatches",
  "flagPresent",
  "flagMatches",
  "flagAllowlist",
  "flagValueIn",
  "flagCount",
  "anyArgMatches",
  "envAssignmentNameIn",
  "noSubstitution",
  "noStdoutRedirect",
  "redirect",
  "pipeline",
  "operator",
  "stageEvery",
  "stageSome",
  "compoundForm",
  "bodyStagesAllReadOnly",
  "bodyStagesAllScopeIn",
  "iteratorScopesAllIn",
  "noBodySubstitution",
  "noBodyShellWrap",
  "noBodyRedirectTo",
  "diagnosticCode",
  "composition",
  "all",
  "any",
  "not",
  "mutationTool",
  "mutationShape",
  "mutationTrustBoundary",
  "pathScope",
] as const satisfies readonly MatcherExpr["kind"][];

type AssertNever<T extends never> = T;
type AssertTrue<T extends true> = T;
type ShapeShimMatchesGenerated = AssertTrue<
  ShapeShim extends BashCommandShape ? true : false
>;
type DecisionShimMatchesGenerated = AssertTrue<
  DecisionShim extends Decision ? true : false
>;
type MatcherShimMatchesGenerated = AssertTrue<
  MatcherShim extends MatcherExpr ? true : false
>;
type MissingMatcherKinds = Exclude<
  MatcherExpr["kind"],
  (typeof MATCHER_KINDS)[number]
>;
type MatcherInventoryIsComplete = AssertNever<MissingMatcherKinds>;

const matcherInventoryCheck: MatcherInventoryIsComplete = undefined as never;
const shimTypeChecks: [
  ShapeShimMatchesGenerated,
  DecisionShimMatchesGenerated,
  MatcherShimMatchesGenerated,
] = [true, true, true];

const shapeContractCheck = {
  kind: "bash",
  rawCommand: "printf '%s' ok",
  blocks: [],
  stages: [],
  diagnostics: [],
} satisfies BashCommandShape;

const pathContextContractCheck = {
  cwd: "/workspace",
  projectScope: {
    roots: ["/workspace"],
    writableDirectories: ["/workspace"],
    tempDirectories: ["/tmp"],
    deniedDirectories: [],
    safeHomeDirectories: [],
    unknownPathBehavior: "review",
  },
} satisfies PathFactsResolvedConfig;

const policyContractCheck = {
  version: 1,
  id: "test.contracts",
  rules: [
    {
      id: "always-review",
      effect: "review",
      match: { kind: "always" },
      reason: "contract test",
      provenance: { source: "default" },
    },
  ],
} satisfies PolicyPack;

const decisionContractCheck = {
  effect: "review",
  reason: "contract test",
  provenance: { source: "default" },
} satisfies Decision;

void matcherInventoryCheck;
void shimTypeChecks;
void shapeContractCheck;
void pathContextContractCheck;
void policyContractCheck;
void decisionContractCheck;

describe("generated native contracts", () => {
  it("keeps the complete matcher inventory in the generated DSL", () => {
    expect(MATCHER_KINDS).toHaveLength(38);
    expect(MATCHER_KINDS).toContain("pathScope");
  });
});
