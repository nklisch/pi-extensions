import {
  directPlugin,
  fixtureProvenance,
  claimFixture,
  expectedOutcome,
  expectedRequirement,
  type PolicyFixture,
} from "./common.js";
import { foreignPolicyFixtures } from "./foreign.js";
import { mcpPolicyFixtures } from "./mcp.js";

const knownMetadata = {
  key: "owner",
  claimed: claimFixture("compatibility-fixture", fixtureProvenance(".claude-plugin/marketplace.json", "/plugins/0/owner", "claude", "manifest")),
};

const sampling = mcpPolicyFixtures.find((fixture) => fixture.id === "mcp-feature-sampling");
const foreign = foreignPolicyFixtures[0];
if (sampling === undefined || foreign === undefined) throw new Error("shared compatibility fixtures are incomplete");

export const reportingPolicyFixtures: readonly PolicyFixture[] = [
  {
    id: "verdict-registry",
    ruleId: "verdict.registry",
    positive: () => directPlugin(),
    negative: () => directPlugin(),
    positiveVerdict: "supported",
    positiveExpected: expectedOutcome([], true),
    negativeExpected: expectedOutcome([], true),
  },
  {
    id: "requirement-separate-status",
    ruleId: "requirement.separate-status",
    positive: sampling.positive,
    negative: sampling.negative,
    positiveVerdict: "supported",
    positiveExpected: expectedOutcome(["supported"], true, {
      requirements: [
        expectedRequirement("mcp-server", "d", "pi.mcp.runtime"),
        expectedRequirement("mcp-server", "d", "pi.mcp.transport.stdio"),
        expectedRequirement("mcp-server", "d", "pi.mcp.sampling"),
      ],
    }),
    negativeExpected: expectedOutcome(["supported"], true, {
      requirements: [
        expectedRequirement("mcp-server", "1", "pi.mcp.runtime"),
        expectedRequirement("mcp-server", "1", "pi.mcp.transport.stdio"),
      ],
    }),
  },
  {
    id: "verdict-metadata-only",
    ruleId: "verdict.metadata-only",
    positive: () => directPlugin({ metadata: [knownMetadata] }),
    negative: () => directPlugin(),
    positiveVerdict: "supported",
    diagnosticRuleId: "metadata.known-presentation",
    positiveExpected: expectedOutcome([], true, {
      diagnosticCodes: ["UNSUPPORTED_DECLARATION"],
      diagnosticRuleIds: ["metadata.known-presentation"],
      diagnosticSourcePointers: ["/plugins/0/owner"],
    }),
    negativeExpected: expectedOutcome([], true),
  },
  {
    id: "verdict-incompatible",
    ruleId: "verdict.incompatible",
    positive: foreign.positive,
    negative: foreign.negative,
    positiveVerdict: "incompatible",
    diagnosticRuleId: "foreign.default-deny",
    positiveExpected: foreign.positiveExpected,
    negativeExpected: foreign.negativeExpected,
  },
  {
    id: "metadata-known-presentation",
    ruleId: "metadata.known-presentation",
    positive: () => directPlugin({ metadata: [knownMetadata] }),
    negative: () => directPlugin(),
    positiveVerdict: "supported",
    diagnosticRuleId: "metadata.known-presentation",
    positiveExpected: expectedOutcome([], true, {
      diagnosticCodes: ["UNSUPPORTED_DECLARATION"],
      diagnosticRuleIds: ["metadata.known-presentation"],
      diagnosticSourcePointers: ["/plugins/0/owner"],
    }),
    negativeExpected: expectedOutcome([], true),
  },
];
