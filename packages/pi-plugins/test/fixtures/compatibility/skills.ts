import {
  directPlugin,
  fixtureProvenance,
  claimFixture,
  componentId,
  expectedOutcome,
  expectedRequirement,
  type PolicyFixture,
} from "./common.js";

function skill(metadata: readonly unknown[] = [], token = "1") {
  const provenance = fixtureProvenance("skills/demo/SKILL.md", "/name", "claude", "skill");
  return {
    kind: "skill" as const,
    id: componentId("skill", token),
    name: claimFixture("demo", provenance),
    root: claimFixture("skills/demo", fixtureProvenance("skills/demo/SKILL.md", "", "claude", "skill")),
    metadata,
  };
}

function metadata(key: string, value: unknown, pointer: string): unknown {
  return {
    key,
    claimed: claimFixture(value, fixtureProvenance("skills/demo/SKILL.md", pointer, "claude", "skill")),
  };
}

const baseline = () => directPlugin({ components: { skills: [skill([], "1")] } });

export const skillPolicyFixtures: readonly PolicyFixture[] = [
  {
    id: "skill-core",
    ruleId: "skill.core",
    positive: baseline,
    negative: () => directPlugin(),
    positiveVerdict: "supported",
    positiveExpected: expectedOutcome(["supported"], true),
    negativeExpected: expectedOutcome([], true),
  },
  {
    id: "skill-presentation",
    ruleId: "skill.presentation",
    positive: () => directPlugin({ components: { skills: [skill([
      metadata("agent-skills.license", "MIT", "/license"),
      metadata("agent-skills.compatibility", "shell", "/compatibility"),
      metadata("agent-skills.metadata", { owner: "fixture" }, "/metadata"),
    ], "2")] } }),
    negative: baseline,
    positiveVerdict: "supported",
    diagnosticRuleId: "skill.presentation",
    positiveExpected: expectedOutcome(["supported"], true, {
      diagnosticCodes: ["UNSUPPORTED_DECLARATION", "UNSUPPORTED_DECLARATION", "UNSUPPORTED_DECLARATION"],
      diagnosticRuleIds: ["skill.presentation", "skill.presentation", "skill.presentation"],
      diagnosticSourcePointers: ["/license", "/compatibility", "/metadata"],
    }),
    negativeExpected: expectedOutcome(["supported"], true),
  },
  {
    id: "skill-disable-model-invocation",
    ruleId: "skill.disable-model-invocation",
    positive: () => directPlugin({ components: { skills: [skill([
      metadata("agent-skills.disable-model-invocation", true, "/disable-model-invocation"),
    ], "3")] } }),
    negative: baseline,
    positiveVerdict: "supported",
    positiveExpected: expectedOutcome(["supported"], true),
    negativeExpected: expectedOutcome(["supported"], true),
  },
  {
    id: "skill-codex-presentation",
    ruleId: "skill.codex-presentation",
    positive: () => directPlugin({ components: { skills: [skill([
      metadata("codex.agents.interface", { display_name: "Demo" }, "/agents/openai.yaml/interface"),
    ], "4")] } }),
    negative: baseline,
    positiveVerdict: "supported",
    diagnosticRuleId: "skill.codex-presentation",
    positiveExpected: expectedOutcome(["supported"], true, {
      diagnosticCodes: ["UNSUPPORTED_DECLARATION"],
      diagnosticRuleIds: ["skill.codex-presentation"],
      diagnosticSourcePointers: ["/agents/openai.yaml/interface"],
    }),
    negativeExpected: expectedOutcome(["supported"], true),
  },
  {
    id: "skill-codex-invocation-policy",
    ruleId: "skill.codex-invocation-policy",
    positive: () => directPlugin({ components: { skills: [skill([
      metadata("codex.agents.policy", { allow_implicit_invocation: true }, "/agents/openai.yaml/policy"),
    ], "5")] } }),
    negative: () => directPlugin({ components: { skills: [skill([
      metadata("codex.agents.policy", { allow_implicit_invocation: "unknown" }, "/agents/openai.yaml/policy"),
    ], "6")] } }),
    positiveVerdict: "supported",
    positiveExpected: expectedOutcome(["supported"], true),
    negativeExpected: expectedOutcome(["metadata-only"], true, {
      diagnosticCodes: ["UNSUPPORTED_DECLARATION"],
      diagnosticRuleIds: ["skill.unknown-frontmatter"],
      diagnosticSourcePointers: ["/agents/openai.yaml/policy"],
    }),
  },
  {
    id: "skill-allowed-tools",
    ruleId: "skill.allowed-tools",
    positive: () => directPlugin({ components: { skills: [skill([
      metadata("agent-skills.allowed-tools", "Bash Read", "/allowed-tools"),
    ], "7")] } }),
    negative: baseline,
    positiveVerdict: "supported",
    positiveExpected: expectedOutcome(["supported"], true, {
      requirements: [expectedRequirement("skill", "7", "pi.skill.allowed-tools")],
    }),
    negativeExpected: expectedOutcome(["supported"], true),
  },
  {
    id: "skill-scoped-hooks",
    ruleId: "skill.scoped-hooks",
    positive: () => directPlugin({ components: { skills: [skill([
      metadata("agent-skills.scoped-hooks", { event: "SessionStart" }, "/hooks"),
    ], "8")] } }),
    negative: baseline,
    positiveVerdict: "metadata-only",
    diagnosticRuleId: "skill.scoped-hooks",
    positiveExpected: expectedOutcome(["metadata-only"], true, {
      diagnosticCodes: ["UNSUPPORTED_DECLARATION"],
      diagnosticRuleIds: ["skill.scoped-hooks"],
      diagnosticSourcePointers: ["/hooks"],
    }),
    negativeExpected: expectedOutcome(["supported"], true),
  },
  {
    id: "skill-unknown-frontmatter",
    ruleId: "skill.unknown-frontmatter",
    positive: () => directPlugin({ components: { skills: [skill([
      metadata("agent-skills.future-runtime", "CANARY_SKILL_VALUE", "/future-runtime"),
    ], "9")] } }),
    negative: baseline,
    positiveVerdict: "metadata-only",
    diagnosticRuleId: "skill.unknown-frontmatter",
    positiveExpected: expectedOutcome(["metadata-only"], true, {
      diagnosticCodes: ["UNSUPPORTED_DECLARATION"],
      diagnosticRuleIds: ["skill.unknown-frontmatter"],
      diagnosticSourcePointers: ["/future-runtime"],
    }),
    negativeExpected: expectedOutcome(["supported"], true),
  },
];

export const skillIngestionFixtures = {
  presentation: {
    skillMarkdown: "---\nname: demo\ndescription: fixture skill\nlicense: MIT\ncompatibility: shell\nmetadata:\n  owner: fixture\nallowed-tools: Bash Read\ndisable-model-invocation: true\n---\n# Demo\n",
    skillPresentation: "interface:\n  display_name: Demo\npolicy:\n  allow_implicit_invocation: true\n",
  },
  minimal: {
    skillMarkdown: "---\nname: demo\ndescription: fixture skill\n---\n# Demo\n",
  },
} as const;
