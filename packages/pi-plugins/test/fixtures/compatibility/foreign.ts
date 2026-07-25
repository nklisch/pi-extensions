import {
  directPlugin,
  fixtureProvenance,
  claimFixture,
  componentId,
  expectedOutcome,
  type PolicyFixture,
} from "./common.js";

const nativeKinds = [
  "agents",
  "apps",
  "connectors",
  "lspServers",
  "monitors",
  "themes",
  "outputStyles",
  "channels",
  "dependencies",
] as const;

function foreign(nativeKind: string, token: string): unknown {
  return {
    kind: "foreign" as const,
    id: componentId("foreign", token),
    nativeHost: token === "b" ? "codex" as const : "claude" as const,
    nativeKind: claimFixture(nativeKind, fixtureProvenance(".claude-plugin/plugin.json", `/${nativeKind}`, "claude", "manifest")),
    declarationSubkey: `key:${nativeKind}`,
    declaration: claimFixture({ secret: "CANARY_FOREIGN_VALUE", nativeKind }, fixtureProvenance(".claude-plugin/plugin.json", `/${nativeKind}`, "claude", "manifest")),
  };
}

const baseline = () => directPlugin();

export const foreignPolicyFixtures: readonly PolicyFixture[] = [
  {
    id: "foreign-pi-extension-metadata-only",
    ruleId: "foreign.pi-extension",
    positive: () => directPlugin({ components: {
      foreign: [foreign("pi-extension", "c")],
    } }),
    negative: baseline,
    positiveVerdict: "metadata-only",
    diagnosticRuleId: "foreign.pi-extension",
    positiveExpected: expectedOutcome(["metadata-only"], true, {
      diagnosticCodes: ["UNSUPPORTED_DECLARATION"],
      diagnosticRuleIds: ["foreign.pi-extension"],
      diagnosticSourcePointers: ["/pi-extension"],
    }),
    negativeExpected: expectedOutcome([], true),
  },
  {
    id: "foreign-default-deny-all-native-kinds",
    ruleId: "foreign.default-deny",
    positive: () => directPlugin({ components: {
      foreign: [
        ...nativeKinds.map((nativeKind, index) => foreign(nativeKind, `a${(index + 1).toString(16)}`)),
        foreign("future-runtime-kind", "f"),
      ],
    } }),
    negative: baseline,
    positiveVerdict: "metadata-only",
    diagnosticRuleId: "foreign.default-deny",
    positiveExpected: expectedOutcome(new Array(nativeKinds.length + 1).fill("metadata-only"), true, {
      diagnosticCodes: new Array(nativeKinds.length + 1).fill("UNSUPPORTED_DECLARATION"),
      diagnosticRuleIds: new Array(nativeKinds.length + 1).fill("foreign.default-deny"),
      diagnosticSourcePointers: [...nativeKinds, "future-runtime-kind"].map((kind) => `/${kind}`),
    }),
    negativeExpected: expectedOutcome([], true),
  },
];

export const foreignIngestionFixture = {
  agents: [{ name: "agent", command: "CANARY_NATIVE_COMMAND" }],
  apps: { "desktop": { command: "CANARY_APP_COMMAND" } },
  connectors: { "remote": { url: "https://example.invalid/CANARY_CONNECTOR" } },
  lspServers: { "typescript": { command: "CANARY_LSP_COMMAND" } },
  monitors: { "watch": { path: "/CANARY_MONITOR_PATH" } },
  themes: [{ name: "CANARY_THEME" }],
  outputStyles: [{ name: "CANARY_OUTPUT_STYLE" }],
  channels: { "notifications": { enabled: true } },
  dependencies: { "other-plugin": { version: "^1.0.0" } },
} as const;
