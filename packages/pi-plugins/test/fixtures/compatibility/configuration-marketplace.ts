import { directPlugin, fixtureProvenance, claimFixture, expectedOutcome, type PolicyFixture } from "./common.js";

function option(
  key: string,
  value: Record<string, unknown>,
  required: boolean,
  sensitive: boolean,
): unknown {
  const provenance = fixtureProvenance(".claude-plugin/plugin.json", `/userConfig/${key}`, "claude", "manifest");
  return {
    key,
    label: claimFixture(key, provenance),
    value,
    required,
    sensitive,
    provenance: [provenance],
  };
}

function policy(availability: "available" | "installed-by-default" | "not-available", authentication?: string): unknown {
  const provenance = fixtureProvenance(".claude-plugin/marketplace.json", "/plugins/0/policy/installation", "claude", "manifest");
  return {
    availability: claimFixture(availability, provenance),
    ...(authentication === undefined ? {} : { authentication: claimFixture(authentication, fixtureProvenance(".claude-plugin/marketplace.json", "/plugins/0/policy/authentication", "claude", "manifest")) }),
    declaration: claimFixture({ installation: availability, authentication: authentication ?? "CANARY_AUTH_POLICY" }, provenance),
  };
}

const baseline = () => directPlugin();

export const configurationMarketplaceFixtures: readonly PolicyFixture[] = [
  {
    id: "configuration-descriptor",
    ruleId: "configuration.descriptor",
    positive: () => directPlugin({ configuration: { options: [
      option("PATH_VALUE", { kind: "file", default: "/CANARY_DEFAULT_PATH", mustExist: false }, false, false),
    ] } }),
    negative: baseline,
    positiveVerdict: "supported",
    diagnosticRuleId: "configuration.descriptor",
    positiveExpected: expectedOutcome([], true, {
      diagnosticCodes: ["UNSUPPORTED_DECLARATION"],
      diagnosticRuleIds: ["configuration.descriptor"],
      diagnosticSourcePointers: ["/userConfig/PATH_VALUE"],
    }),
    negativeExpected: expectedOutcome([], true),
  },
  {
    id: "configuration-required-input",
    ruleId: "configuration.required-input",
    positive: () => directPlugin({ configuration: { options: [
      option("REQUIRED_VALUE", { kind: "string" }, true, false),
    ] } }),
    negative: baseline,
    positiveVerdict: "supported",
    diagnosticRuleId: "configuration.required-input",
    positiveExpected: expectedOutcome([], true, {
      diagnosticCodes: ["UNSUPPORTED_DECLARATION", "UNSUPPORTED_DECLARATION"],
      diagnosticRuleIds: ["configuration.descriptor", "configuration.required-input"],
      diagnosticSourcePointers: ["/userConfig/REQUIRED_VALUE", "/userConfig/REQUIRED_VALUE"],
    }),
    negativeExpected: expectedOutcome([], true),
  },
  {
    id: "configuration-sensitive",
    ruleId: "configuration.sensitive",
    positive: () => directPlugin({ configuration: { options: [
      option("SECRET_VALUE", { kind: "string" }, true, true),
    ] } }),
    negative: baseline,
    positiveVerdict: "supported",
    diagnosticRuleId: "configuration.sensitive",
    positiveExpected: expectedOutcome([], true, {
      diagnosticCodes: ["UNSUPPORTED_DECLARATION", "UNSUPPORTED_DECLARATION", "UNSUPPORTED_DECLARATION"],
      diagnosticRuleIds: ["configuration.descriptor", "configuration.required-input", "configuration.sensitive"],
      diagnosticSourcePointers: ["/userConfig/SECRET_VALUE", "/userConfig/SECRET_VALUE", "/userConfig/SECRET_VALUE"],
    }),
    negativeExpected: expectedOutcome([], true),
  },
  {
    id: "marketplace-availability-available",
    ruleId: "marketplace.availability.available",
    positive: () => directPlugin(),
    negative: baseline,
    positiveVerdict: "supported",
    positivePolicy: policy("available"),
    diagnosticRuleId: "marketplace.availability.available",
    positiveExpected: expectedOutcome([], true, {
      diagnosticCodes: ["UNSUPPORTED_DECLARATION"],
      diagnosticRuleIds: ["marketplace.availability.available"],
      diagnosticSourcePointers: ["/plugins/0/policy/installation"],
    }),
    negativeExpected: expectedOutcome([], true),
  },
  {
    id: "marketplace-availability-installed-by-default",
    ruleId: "marketplace.availability.installed-by-default",
    positive: () => directPlugin(),
    negative: baseline,
    positiveVerdict: "supported",
    positivePolicy: policy("installed-by-default"),
    diagnosticRuleId: "marketplace.availability.installed-by-default",
    positiveExpected: expectedOutcome([], true, {
      diagnosticCodes: ["UNSUPPORTED_DECLARATION"],
      diagnosticRuleIds: ["marketplace.availability.installed-by-default"],
      diagnosticSourcePointers: ["/plugins/0/policy/installation"],
    }),
    negativeExpected: expectedOutcome([], true),
  },
  {
    id: "marketplace-availability-not-available",
    ruleId: "marketplace.availability.not-available",
    positive: () => directPlugin(),
    negative: baseline,
    positiveVerdict: "supported",
    positivePolicy: policy("not-available", "CANARY_AUTH_POLICY"),
    diagnosticRuleId: "marketplace.availability.not-available",
    positiveExpected: expectedOutcome([], true, {
      diagnosticCodes: ["UNSUPPORTED_DECLARATION", "UNSUPPORTED_DECLARATION"],
      diagnosticRuleIds: ["marketplace.availability.not-available", "marketplace.policy"],
      diagnosticSourcePointers: ["/plugins/0/policy/installation", "/plugins/0/policy/authentication"],
    }),
    negativeExpected: expectedOutcome([], true),
  },
  {
    id: "marketplace-policy",
    ruleId: "marketplace.policy",
    positive: () => directPlugin(),
    negative: baseline,
    positiveVerdict: "supported",
    positivePolicy: policy("available", "oauth"),
    diagnosticRuleId: "marketplace.policy",
    positiveExpected: expectedOutcome([], true, {
      diagnosticCodes: ["UNSUPPORTED_DECLARATION", "UNSUPPORTED_DECLARATION"],
      diagnosticRuleIds: ["marketplace.availability.available", "marketplace.policy"],
      diagnosticSourcePointers: ["/plugins/0/policy/installation", "/plugins/0/policy/authentication"],
    }),
    negativeExpected: expectedOutcome([], true),
  },
];

export const configurationIngestionFixture = {
  userConfig: {
    API_TOKEN: {
      type: "string",
      required: true,
      sensitive: true,
      description: "API token",
    },
    DATA_DIR: {
      type: "directory",
      default: "/CANARY_DEFAULT_PATH",
      mustExist: false,
    },
    RETRIES: {
      type: "number",
      min: 1,
      max: 5,
      default: 2,
    },
    FLAGS: {
      type: "string",
      multiple: true,
      minItems: 1,
      maxItems: 3,
    },
  },
} as const;

export const marketplacePolicyIngestionFixtures = [
  { installation: "AVAILABLE" as const, authentication: "oauth" },
  { installation: "INSTALLED_BY_DEFAULT" as const },
  { installation: "NOT_AVAILABLE" as const, authentication: "CANARY_AUTH_POLICY" },
] as const;

export function directMarketplacePolicy(
  availability: "available" | "installed-by-default" | "not-available",
  authentication?: string,
) {
  return policy(availability, authentication);
}
