import {
  directPlugin,
  fixtureProvenance,
  claimFixture,
  componentId,
  expectedOutcome,
  expectedRequirement,
  type PolicyFixture,
} from "./common.js";

export function mcp(declaration: Record<string, unknown>, token: string): unknown {
  const path = "plugin.mcp.json";
  return {
    kind: "mcp-server" as const,
    id: componentId("mcp-server", token),
    nativeKey: claimFixture(`server-${token}`, fixtureProvenance(path, `/mcpServers/server-${token}`, "claude", "mcp")),
    declaration: claimFixture(declaration, fixtureProvenance(path, `/mcpServers/server-${token}`, "claude", "mcp")),
    metadata: [],
  };
}

const stdio = (token = "1") => mcp({ transport: "stdio", command: "server" }, token);
const http = (token = "2") => mcp({ transport: "streamable-http", url: "https://example.invalid/mcp" }, token);
const baseline = () => directPlugin({ components: { mcpServers: [stdio()] } });

function mcpRequirements(token: string, transport: "stdio" | "streamable-http", ...additional: string[]) {
  const transportCapability = transport === "stdio"
    ? "pi.mcp.transport.stdio"
    : "pi.mcp.transport.streamable-http";
  return [
    expectedRequirement("mcp-server", token, "pi.mcp.runtime"),
    expectedRequirement("mcp-server", token, transportCapability),
    ...additional.map((capability) => expectedRequirement("mcp-server", token, capability)),
  ];
}

export const mcpPolicyFixtures: readonly PolicyFixture[] = [
  {
    id: "mcp-transport-stdio",
    ruleId: "mcp.transport.stdio",
    positive: () => directPlugin({ components: { mcpServers: [stdio("1")] } }),
    negative: () => directPlugin({ components: { mcpServers: [http("2")] } }),
    positiveVerdict: "supported",
    positiveExpected: expectedOutcome(["supported"], true, {
      requirements: mcpRequirements("1", "stdio"),
    }),
    negativeExpected: expectedOutcome(["supported"], true, {
      requirements: mcpRequirements("2", "streamable-http"),
    }),
  },
  {
    id: "mcp-transport-streamable-http",
    ruleId: "mcp.transport.streamable-http",
    positive: () => directPlugin({ components: { mcpServers: [http("3")] } }),
    negative: () => directPlugin({ components: { mcpServers: [stdio("4")] } }),
    positiveVerdict: "supported",
    positiveExpected: expectedOutcome(["supported"], true, {
      requirements: mcpRequirements("3", "streamable-http"),
    }),
    negativeExpected: expectedOutcome(["supported"], true, {
      requirements: mcpRequirements("4", "stdio"),
    }),
  },
  {
    id: "mcp-transport-security",
    ruleId: "mcp.transport.security",
    positive: () => directPlugin({ components: { mcpServers: [mcp({ transport: "streamable-http", url: "http://example.invalid/mcp" }, "security")] } }),
    negative: () => directPlugin({ components: { mcpServers: [mcp({ transport: "streamable-http", url: "http://127.0.0.1:8080/mcp" }, "loopback")] } }),
    positiveVerdict: "incompatible",
    diagnosticRuleId: "mcp.transport.security",
    positiveExpected: expectedOutcome(["incompatible"], false, {
      diagnosticCodes: ["UNSUPPORTED_DECLARATION"],
      diagnosticRuleIds: ["mcp.transport.security"],
      diagnosticSourcePointers: ["/mcpServers/server-security/url"],
    }),
    negativeExpected: expectedOutcome(["supported"], true, {
      requirements: mcpRequirements("loopback", "streamable-http"),
    }),
  },
  {
    id: "mcp-transport-sse",
    ruleId: "mcp.transport.sse",
    positive: () => directPlugin({ components: { mcpServers: [mcp({ transport: "sse", url: "https://example.invalid/mcp" }, "5")] } }),
    negative: baseline,
    positiveVerdict: "metadata-only",
    diagnosticRuleId: "mcp.transport.sse",
    positiveExpected: expectedOutcome(["metadata-only"], true, {
      diagnosticCodes: ["UNSUPPORTED_DECLARATION"],
      diagnosticRuleIds: ["mcp.transport.sse"],
      diagnosticSourcePointers: ["/mcpServers/server-5/transport"],
    }),
    negativeExpected: expectedOutcome(["supported"], true, {
      requirements: mcpRequirements("1", "stdio"),
    }),
  },
  {
    id: "mcp-transport-websocket",
    ruleId: "mcp.transport.websocket",
    positive: () => directPlugin({ components: { mcpServers: [mcp({ transport: "websocket", url: "wss://example.invalid/mcp" }, "6")] } }),
    negative: baseline,
    positiveVerdict: "metadata-only",
    diagnosticRuleId: "mcp.transport.websocket",
    positiveExpected: expectedOutcome(["metadata-only"], true, {
      diagnosticCodes: ["UNSUPPORTED_DECLARATION"],
      diagnosticRuleIds: ["mcp.transport.websocket"],
      diagnosticSourcePointers: ["/mcpServers/server-6/transport"],
    }),
    negativeExpected: expectedOutcome(["supported"], true, {
      requirements: mcpRequirements("1", "stdio"),
    }),
  },
  {
    id: "mcp-oauth-authorization-code",
    ruleId: "mcp.oauth.authorization-code",
    positive: () => directPlugin({ components: { mcpServers: [mcp({
      transport: "streamable-http",
      url: "https://example.invalid/mcp",
      oauth: { grantType: "authorization-code", clientId: "client" },
    }, "7")] } }),
    negative: () => directPlugin({ components: { mcpServers: [http("8")] } }),
    positiveVerdict: "supported",
    positiveExpected: expectedOutcome(["supported"], true, {
      requirements: mcpRequirements("7", "streamable-http", "pi.mcp.oauth.authorization-code"),
    }),
    negativeExpected: expectedOutcome(["supported"], true, {
      requirements: mcpRequirements("8", "streamable-http"),
    }),
  },
  {
    id: "mcp-oauth-client-credentials",
    ruleId: "mcp.oauth.client-credentials",
    positive: () => directPlugin({ components: { mcpServers: [mcp({
      transport: "streamable-http",
      url: "https://example.invalid/mcp",
      oauth: { grantType: "client-credentials", clientId: "client" },
    }, "9")] } }),
    negative: () => directPlugin({ components: { mcpServers: [http("a")] } }),
    positiveVerdict: "supported",
    positiveExpected: expectedOutcome(["supported"], true, {
      requirements: mcpRequirements("9", "streamable-http", "pi.mcp.oauth.client-credentials"),
    }),
    negativeExpected: expectedOutcome(["supported"], true, {
      requirements: mcpRequirements("a", "streamable-http"),
    }),
  },
  {
    id: "mcp-features-core",
    ruleId: "mcp.features.core",
    positive: () => directPlugin({ components: { mcpServers: [
      // Stdio keeps only process and transport-independent MCP fields.
      mcp({
        transport: "stdio",
        command: "server",
        args: ["--safe"],
        env: { TOKEN: "${CANARY_ENV_VALUE}" },
        cwd: "/CANARY_RUNTIME_PATH",
        timeout: 1000,
        allowTools: ["search"],
        denyTools: ["delete"],
        instructions: "Use read-only tools",
        resources: ["docs"],
      }, "b"),
      // HTTP headers and bearer authentication remain supported on the
      // Streamable HTTP transport, while values stay outside reports.
      mcp({
        transport: "streamable-http",
        url: "https://example.invalid/bearer-only",
        headers: { "X-Trace": "CANARY_HEADER_VALUE" },
        auth: { type: "bearer", env: "MCP_BEARER_TOKEN" },
      }, "b2"),
    ] } }),
    negative: () => directPlugin({ components: { mcpServers: [
      mcp({ transport: "stdio", command: "server", url: "https://example.invalid/mcp" }, "burl"),
      mcp({ transport: "stdio", command: "server", headers: { Authorization: "CANARY_HEADER_VALUE" } }, "bheaders"),
      mcp({ transport: "stdio", command: "server", auth: { type: "bearer", env: "CANARY_BEARER_ENV" } }, "bauth"),
      mcp({ transport: "stdio", command: "server", oauth: { grantType: "authorization-code", clientId: "client" } }, "boauth"),
    ] } }),
    positiveVerdict: "supported",
    positiveExpected: expectedOutcome(["supported", "supported"], true, {
      requirements: [
        ...mcpRequirements("b", "stdio", "pi.mcp.resources"),
        ...mcpRequirements("b2", "streamable-http"),
      ],
    }),
    negativeExpected: expectedOutcome(["metadata-only", "metadata-only", "metadata-only", "metadata-only"], true, {
      diagnosticCodes: ["UNSUPPORTED_DECLARATION", "UNSUPPORTED_DECLARATION", "UNSUPPORTED_DECLARATION", "UNSUPPORTED_DECLARATION"],
      diagnosticRuleIds: ["mcp.default-deny", "mcp.default-deny", "mcp.default-deny", "mcp.default-deny"],
      diagnosticSourcePointers: [
        "/mcpServers/server-burl/url",
        "/mcpServers/server-bheaders/headers",
        "/mcpServers/server-bauth/auth",
        "/mcpServers/server-boauth/oauth",
      ],
    }),
  },
  {
    id: "mcp-feature-resources",
    ruleId: "mcp.feature.resources",
    positive: () => directPlugin({ components: { mcpServers: [mcp({ transport: "stdio", command: "server", resources: ["docs"] }, "r")] } }),
    negative: baseline,
    positiveVerdict: "supported",
    positiveExpected: expectedOutcome(["supported"], true, {
      requirements: mcpRequirements("r", "stdio", "pi.mcp.resources"),
    }),
    negativeExpected: expectedOutcome(["supported"], true, {
      requirements: mcpRequirements("1", "stdio"),
    }),
  },
  {
    id: "mcp-feature-tool-approval",
    ruleId: "mcp.feature.tool-approval",
    positive: () => directPlugin({ components: { mcpServers: [mcp({ transport: "stdio", command: "server", toolApproval: true }, "c")] } }),
    negative: baseline,
    positiveVerdict: "supported",
    positiveExpected: expectedOutcome(["supported"], true, {
      requirements: mcpRequirements("c", "stdio", "pi.mcp.tool-approval"),
    }),
    negativeExpected: expectedOutcome(["supported"], true, {
      requirements: mcpRequirements("1", "stdio"),
    }),
  },
  {
    id: "mcp-feature-sampling",
    ruleId: "mcp.feature.sampling",
    positive: () => directPlugin({ components: { mcpServers: [mcp({ transport: "stdio", command: "server", sampling: true }, "d")] } }),
    negative: baseline,
    positiveVerdict: "supported",
    positiveExpected: expectedOutcome(["supported"], true, {
      requirements: mcpRequirements("d", "stdio", "pi.mcp.sampling"),
    }),
    negativeExpected: expectedOutcome(["supported"], true, {
      requirements: mcpRequirements("1", "stdio"),
    }),
  },
  {
    id: "mcp-feature-elicitation-form",
    ruleId: "mcp.feature.elicitation-form",
    positive: () => directPlugin({ components: { mcpServers: [mcp({ transport: "stdio", command: "server", elicitation: "form" }, "e")] } }),
    negative: baseline,
    positiveVerdict: "supported",
    positiveExpected: expectedOutcome(["supported"], true, {
      requirements: mcpRequirements("e", "stdio", "pi.mcp.elicitation.form"),
    }),
    negativeExpected: expectedOutcome(["supported"], true, {
      requirements: mcpRequirements("1", "stdio"),
    }),
  },
  {
    id: "mcp-feature-elicitation-url",
    ruleId: "mcp.feature.elicitation-url",
    positive: () => directPlugin({ components: { mcpServers: [mcp({ transport: "stdio", command: "server", elicitation: "url" }, "f")] } }),
    negative: baseline,
    positiveVerdict: "supported",
    positiveExpected: expectedOutcome(["supported"], true, {
      requirements: mcpRequirements("f", "stdio", "pi.mcp.elicitation.url"),
    }),
    negativeExpected: expectedOutcome(["supported"], true, {
      requirements: mcpRequirements("1", "stdio"),
    }),
  },
  {
    id: "mcp-headers-helper",
    ruleId: "mcp.headers-helper",
    positive: () => directPlugin({ components: { mcpServers: [mcp({ transport: "streamable-http", url: "https://example.invalid/mcp", headersHelper: "CANARY_HELPER" }, "10")] } }),
    negative: baseline,
    positiveVerdict: "metadata-only",
    diagnosticRuleId: "mcp.headers-helper",
    positiveExpected: expectedOutcome(["metadata-only"], true, {
      diagnosticCodes: ["UNSUPPORTED_DECLARATION"],
      diagnosticRuleIds: ["mcp.headers-helper"],
      diagnosticSourcePointers: ["/mcpServers/server-10/headersHelper"],
    }),
    negativeExpected: expectedOutcome(["supported"], true, {
      requirements: mcpRequirements("1", "stdio"),
    }),
  },
  {
    id: "mcp-channels",
    ruleId: "mcp.channels",
    positive: () => directPlugin({ components: { mcpServers: [mcp({ transport: "streamable-http", url: "https://example.invalid/mcp", channels: ["CANARY_CHANNEL"] }, "11")] } }),
    negative: baseline,
    positiveVerdict: "metadata-only",
    diagnosticRuleId: "mcp.channels",
    positiveExpected: expectedOutcome(["metadata-only"], true, {
      diagnosticCodes: ["UNSUPPORTED_DECLARATION"],
      diagnosticRuleIds: ["mcp.channels"],
      diagnosticSourcePointers: ["/mcpServers/server-11/channels"],
    }),
    negativeExpected: expectedOutcome(["supported"], true, {
      requirements: mcpRequirements("1", "stdio"),
    }),
  },
  {
    id: "mcp-default-deny",
    ruleId: "mcp.default-deny",
    positive: () => directPlugin({ components: { mcpServers: [
      mcp({ transport: "stdio", command: "server", unknownBehavior: "CANARY_UNKNOWN" }, "12"),
      mcp({
        transport: "streamable-http",
        url: "https://example.invalid/mcp",
        oauth: { grantType: "authorization-code", flow: "client-credentials" },
      }, "13"),
      mcp({
        transport: "stdio",
        command: "server",
        features: { sampling: { enabled: "true" } },
      }, "14"),
      mcp({
        transport: "stdio",
        type: "streamable-http",
        url: "https://example.invalid/mcp",
      }, "15"),
      mcp({
        transport: "stdio",
        command: "server",
        features: { sampling: { enabled: true, futureFlag: false } },
      }, "16"),
      mcp({
        transport: "streamable-http",
        url: "https://CANARY_URL_USER:CANARY_URL_PASSWORD@example.invalid/mcp",
        auth: { type: "bearer", env: "CANARY_BEARER_ENV", grantType: "authorization-code" },
      }, "17"),
      mcp({
        transport: "streamable-http",
        url: "https://example.invalid/mcp",
        auth: { type: "bearer", env: "CANARY_BEARER_ENV_2", flow: "client-credentials" },
      }, "18"),
      mcp({
        transport: "streamable-http",
        url: "https://CANARY_SSE_USER:CANARY_SSE_PASSWORD@example.invalid/mcp",
      }, "19"),
      mcp({
        transport: "sse",
        url: "https://CANARY_SSE_USER_2:CANARY_SSE_PASSWORD_2@example.invalid/mcp",
      }, "1a"),
    ] } }),
    negative: baseline,
    positiveVerdict: "metadata-only",
    diagnosticRuleId: "mcp.default-deny",
    positiveExpected: expectedOutcome([
      "metadata-only", "metadata-only", "metadata-only", "metadata-only", "metadata-only",
      "metadata-only", "metadata-only", "metadata-only", "metadata-only",
    ], true, {
      diagnosticCodes: [
        "UNSUPPORTED_DECLARATION", "UNSUPPORTED_DECLARATION", "UNSUPPORTED_DECLARATION",
        "UNSUPPORTED_DECLARATION", "UNSUPPORTED_DECLARATION", "UNSUPPORTED_DECLARATION",
        "UNSUPPORTED_DECLARATION", "UNSUPPORTED_DECLARATION", "UNSUPPORTED_DECLARATION",
        "UNSUPPORTED_DECLARATION", "UNSUPPORTED_DECLARATION", "UNSUPPORTED_DECLARATION",
        "UNSUPPORTED_DECLARATION",
      ],
      diagnosticRuleIds: [
        "mcp.default-deny", "mcp.default-deny", "mcp.default-deny", "mcp.default-deny",
        "mcp.default-deny", "mcp.default-deny", "mcp.default-deny", "mcp.default-deny",
        "mcp.default-deny", "mcp.default-deny", "mcp.default-deny", "mcp.default-deny",
        "mcp.transport.sse",
      ],
      diagnosticSourcePointers: [
        "/mcpServers/server-12/unknownBehavior",
        "/mcpServers/server-13/oauth",
        "/mcpServers/server-14/features/sampling/enabled",
        "/mcpServers/server-15/transport",
        "/mcpServers/server-15/type",
        "/mcpServers/server-15/url",
        "/mcpServers/server-16/features/sampling/futureFlag",
        "/mcpServers/server-17/auth",
        "/mcpServers/server-17/url",
        "/mcpServers/server-18/auth",
        "/mcpServers/server-19/url",
        "/mcpServers/server-1a/transport",
        "/mcpServers/server-1a/url",
      ],
    }),
    negativeExpected: expectedOutcome(["supported"], true, {
      requirements: mcpRequirements("1", "stdio"),
    }),
  },
];

/** Verdicts captured from the evaluator immediately before MCP plan extraction. */
export const mcpPreExtractionDifferentialVectors = [
  {
    id: "positive-fractional-timeouts",
    declaration: {
      transport: "stdio",
      command: "server",
      startupTimeout: 12.5,
      timeout: 0.25,
    },
    kind: "supported",
    options: { startupTimeoutMs: 12.5, toolTimeoutMs: 0.25 },
  },
  {
    id: "direct-tools-array",
    declaration: { transport: "stdio", command: "server", tools: ["read", "write"] },
    kind: "supported",
    options: {},
  },
  {
    id: "independent-oauth-and-headers-features",
    declaration: {
      transport: "streamable-http",
      url: "https://example.invalid/mcp",
      features: {
        oauth: { grantType: "authorization-code", clientId: "client" },
        headers: { Authorization: "${MCP_TOKEN}" },
      },
    },
    kind: "supported",
    options: { auth: { kind: "oauth", flow: "authorization-code" } },
    capabilities: ["pi.mcp.oauth.authorization-code"],
  },
  {
    id: "exact-equivalent-header-claims",
    declaration: {
      transport: "streamable-http",
      url: "https://example.invalid/mcp",
      headers: { X_Plugin: "one" },
      features: { headers: { X_Plugin: "one" } },
    },
    kind: "supported",
    options: {},
  },
] as const;

export const mcpProjectionConformanceVectors = {
  stdio: {
    transport: "stdio",
    command: "${PLUGIN_ROOT}/bin/server",
    args: ["--data", "${PLUGIN_DATA}"],
    env: { TRACE: "${TRACE_VALUE}" },
    cwd: "${CLAUDE_PROJECT_DIR}",
    timeoutMs: 1200,
    allowTools: ["read"],
  },
  streamableHttp: {
    transport: "streamable-http",
    url: "https://example.invalid/mcp?name=${user_config.NAME}",
    headers: { "X-Trace": "${TRACE_VALUE}" },
    bearerTokenEnv: "MCP_BEARER_TOKEN",
    resources: ["docs"],
  },
} as const;

export const mcpIngestionFixtures = {
  stdio: {
    local: {
      command: "node",
      args: ["server.js"],
      env: { TOKEN: "${CANARY_ENV_VALUE}" },
      cwd: "/CANARY_RUNTIME_PATH",
    },
  },
  streamableHttp: {
    remote: {
      type: "http",
      url: "https://example.invalid/mcp",
      headers: { "X-Trace": "CANARY_HEADER_VALUE" },
      auth: { type: "bearer", env: "CANARY_BEARER_ENV" },
    },
  },
  features: {
    featureful: {
      command: "node",
      args: ["server.js"],
      toolApproval: true,
      sampling: true,
      elicitation: { form: true, url: true },
      instructions: "read-only",
      resources: ["docs"],
      timeout: 1000,
    },
  },
  unknown: {
    unknown: { command: "node", unknownBehavior: "CANARY_UNKNOWN" },
  },
} as const;
