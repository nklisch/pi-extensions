import { z } from "zod";
import {
  RuntimeRequirementStatusRegistry,
  type RuntimeRequirementStatus,
} from "./compatibility.js";
import { ErrorCodeRegistry, ErrorCodeSchema, type ErrorCode } from "./error-contract.js";
import {
  HookConditionFieldRegistry,
  HookConditionOperatorDefinitionRegistry,
  HookConditionOperatorRegistry,
  HookRuntimeEventDefinitionRegistry,
  incompatibleHookEvents,
  ordinaryHookEvents,
  subagentHookEvents,
} from "./hook-runtime-contract.js";

/**
 * Runtime facts are deliberately separate from component verdicts.  This
 * registry is the only vocabulary a capability adapter may report.
 */
export const RuntimeCapabilityRegistry = {
  skillToolRestrictions: {
    id: "pi.skill.allowed-tools",
    description: "Pi preserves skill tool restrictions",
    rank: 10,
  },
  commandHooks: {
    id: "pi.hooks.command",
    description: "Pi command-hook adapter is available",
    rank: 20,
  },
  bash: {
    id: "platform.shell.bash",
    description: "Bash is available",
    rank: 30,
  },
  powershell: {
    id: "platform.shell.powershell",
    description: "PowerShell is available on Windows",
    rank: 40,
  },
  subagentInterception: {
    id: "pi.subagents.lifecycle-interception",
    description: "Subagent pre-start and pre-stop interception is available",
    rank: 50,
  },
  mcpRuntime: {
    id: "pi.mcp.runtime",
    description: "Plugin-scoped MCP runtime is available",
    rank: 60,
  },
  mcpTransportStdio: {
    id: "pi.mcp.transport.stdio",
    description: "MCP standard-I/O transport is available",
    rank: 65,
  },
  mcpTransportStreamableHttp: {
    id: "pi.mcp.transport.streamable-http",
    description: "MCP Streamable HTTP transport is available",
    rank: 66,
  },
  mcpOAuthAuthorizationCode: {
    id: "pi.mcp.oauth.authorization-code",
    description: "MCP authorization-code OAuth is available",
    rank: 70,
  },
  mcpOAuthClientCredentials: {
    id: "pi.mcp.oauth.client-credentials",
    description: "MCP client-credentials OAuth is available",
    rank: 80,
  },
  mcpToolApproval: {
    id: "pi.mcp.tool-approval",
    description: "MCP tool approval policy is available",
    rank: 90,
  },
  mcpSampling: {
    id: "pi.mcp.sampling",
    description: "MCP sampling is available",
    rank: 100,
  },
  mcpElicitationForm: {
    id: "pi.mcp.elicitation.form",
    description: "Interactive form elicitation is available",
    rank: 110,
  },
  mcpElicitationUrl: {
    id: "pi.mcp.elicitation.url",
    description: "Interactive URL elicitation is available",
    rank: 120,
  },
  mcpResources: {
    id: "pi.mcp.resources",
    description: "MCP resource access is available",
    rank: 125,
  },
} as const;

type RuntimeCapabilityEntry = (typeof RuntimeCapabilityRegistry)[keyof typeof RuntimeCapabilityRegistry];
type RuntimeCapabilityIdValue = RuntimeCapabilityEntry["id"];
const runtimeCapabilityIds = Object.values(RuntimeCapabilityRegistry).map((entry) => entry.id) as [
  RuntimeCapabilityIdValue,
  ...RuntimeCapabilityIdValue[],
];

export const RuntimeCapabilityIdSchema = z.enum(runtimeCapabilityIds);
export type RuntimeCapabilityId = z.infer<typeof RuntimeCapabilityIdSchema>;

const runtimeCapabilityStatuses = Object.values(RuntimeRequirementStatusRegistry).map(
  (entry) => entry.tag,
) as [RuntimeRequirementStatus, ...RuntimeRequirementStatus[]];

export const RuntimeCapabilityAvailabilitySchema = z
  .object({
    status: z.enum(runtimeCapabilityStatuses),
    explanation: z.string().min(1),
  })
  .strict()
  .readonly();
export type RuntimeCapabilityAvailability = z.infer<
  typeof RuntimeCapabilityAvailabilitySchema
>;

/** A complete immutable fact snapshot supplied by the application boundary. */
export const RuntimeCapabilitySnapshotSchema = z
  .object({
    capabilities: z.record(RuntimeCapabilityIdSchema, RuntimeCapabilityAvailabilitySchema),
    capturedBy: z.string().min(1),
  })
  .strict()
  .readonly()
  .superRefine((snapshot, context) => {
    const entries = Object.keys(snapshot.capabilities);
    const expected = new Set(runtimeCapabilityIds);
    for (const id of runtimeCapabilityIds) {
      if (!Object.prototype.hasOwnProperty.call(snapshot.capabilities, id)) {
        context.addIssue({
          code: "custom",
          path: ["capabilities", id],
          message: `capability snapshot is missing registry capability ${id}`,
        });
      }
    }
    for (const id of entries) {
      if (!expected.has(id as RuntimeCapabilityId)) {
        context.addIssue({
          code: "custom",
          path: ["capabilities", id],
          message: `capability snapshot contains unknown registry capability ${id}`,
        });
      }
    }
  });
export type RuntimeCapabilitySnapshot = z.infer<typeof RuntimeCapabilitySnapshotSchema>;

export type CompatibilityPolicySurface =
  | "skill"
  | "hook"
  | "mcp-server"
  | "foreign"
  | "configuration"
  | "marketplace"
  | "report";
export type CompatibilityPolicyDisposition =
  | "supported"
  | "metadata-only"
  | "incompatible";

export type CompatibilityPolicyRule = Readonly<{
  id: string;
  surface: CompatibilityPolicySurface;
  disposition: CompatibilityPolicyDisposition;
  requirementCapabilityIds: readonly RuntimeCapabilityId[];
  diagnosticCode?: ErrorCode | undefined;
  message: string;
  rank: number;
}>;

const supportedRule = <const T extends CompatibilityPolicyRule>(rule: T): T => rule;
const capability = <T extends RuntimeCapabilityId>(id: T): T => id;
const noRequirements = [] as const satisfies readonly RuntimeCapabilityId[];

const skillRules = {
  core: supportedRule({
    id: "skill.core",
    surface: "skill",
    disposition: "supported",
    requirementCapabilityIds: noRequirements,
    message: "Agent Skill name and description are supported",
    rank: 10,
  }),
  presentation: supportedRule({
    id: "skill.presentation",
    surface: "skill",
    disposition: "metadata-only",
    requirementCapabilityIds: noRequirements,
    message: "Skill presentation metadata is retained as metadata only",
    rank: 20,
  }),
  disableModelInvocation: supportedRule({
    id: "skill.disable-model-invocation",
    surface: "skill",
    disposition: "supported",
    requirementCapabilityIds: noRequirements,
    message: "Skill invocation visibility is representable by Pi",
    rank: 30,
  }),
  codexPresentation: supportedRule({
    id: "skill.codex-presentation",
    surface: "skill",
    disposition: "metadata-only",
    requirementCapabilityIds: noRequirements,
    message: "Codex skill presentation metadata is retained as metadata only",
    rank: 40,
  }),
  codexInvocationPolicy: supportedRule({
    id: "skill.codex-invocation-policy",
    surface: "skill",
    disposition: "supported",
    requirementCapabilityIds: noRequirements,
    message: "The Codex implicit-invocation policy is representable by Pi",
    rank: 50,
  }),
  allowedTools: supportedRule({
    id: "skill.allowed-tools",
    surface: "skill",
    disposition: "supported",
    requirementCapabilityIds: [capability(RuntimeCapabilityRegistry.skillToolRestrictions.id)],
    message: "Pi preserves the skill allowed-tools restriction",
    rank: 60,
  }),
  scopedHooks: supportedRule({
    id: "skill.scoped-hooks",
    surface: "skill",
    disposition: "metadata-only",
    requirementCapabilityIds: noRequirements,
    message: "Skill-scoped hooks have no faithful Pi activation boundary; the skill activates without them",
    rank: 70,
  }),
  unknownFrontmatter: supportedRule({
    id: "skill.unknown-frontmatter",
    surface: "skill",
    disposition: "metadata-only",
    requirementCapabilityIds: noRequirements,
    message: "Unknown skill frontmatter is retained as metadata only",
    rank: 80,
  }),
  presentationKeys: ["description", "license", "compatibility", "metadata"] as const,
  invocationPolicyKeys: [
    "allow_implicit_invocation",
    "allowImplicitInvocation",
    "implicit_invocation",
    "implicitInvocation",
    "default_mode",
    "defaultMode",
    "policy",
  ] as const,
  invocationPolicyValues: ["always", "never", "manual", "implicit", "explicit"] as const,
  metadataPrefixes: ["agent-skills", "codex.agents"] as const,
} as const;

const hookHandlerRules = {
  command: supportedRule({
    id: "hook.command",
    surface: "hook",
    disposition: "supported",
    requirementCapabilityIds: [capability(RuntimeCapabilityRegistry.commandHooks.id)],
    message: "Command hook execution is available through Pi",
    rank: 10,
  }),
  statusMessage: supportedRule({
    id: "hook.status-message",
    surface: "hook",
    disposition: "metadata-only",
    requirementCapabilityIds: noRequirements,
    message: "Hook status text affects presentation only",
    rank: 20,
  }),
  shellBash: supportedRule({
    id: "hook.shell.bash",
    surface: "hook",
    disposition: "supported",
    requirementCapabilityIds: [capability(RuntimeCapabilityRegistry.bash.id)],
    message: "The hook requires the Bash shell",
    rank: 30,
  }),
  shellPowershell: supportedRule({
    id: "hook.shell.powershell",
    surface: "hook",
    disposition: "supported",
    requirementCapabilityIds: [capability(RuntimeCapabilityRegistry.powershell.id)],
    message: "The hook requires the PowerShell shell",
    rank: 40,
  }),
  ifRule: supportedRule({
    id: "hook.if-rule",
    surface: "hook",
    disposition: "supported",
    requirementCapabilityIds: noRequirements,
    message: "The hook condition uses Pi's representable condition grammar",
    rank: 50,
  }),
  async: supportedRule({
    id: "hook.async",
    surface: "hook",
    disposition: "metadata-only",
    requirementCapabilityIds: noRequirements,
    message: "Asynchronous hook ordering cannot be preserved by Pi; the hook is retained but not activated",
    rank: 60,
  }),
  unsupportedHandler: supportedRule({
    id: "hook.handler.unsupported",
    surface: "hook",
    disposition: "metadata-only",
    requirementCapabilityIds: noRequirements,
    message: "The hook handler type is not a supported command handler; the hook is retained but not activated",
    rank: 70,
  }),
  unknownEvent: supportedRule({
    id: "hook.event.default-deny",
    surface: "hook",
    disposition: "metadata-only",
    requirementCapabilityIds: noRequirements,
    message: "Unknown hook events are retained but not activated",
    rank: 80,
  }),
  incompatibleEvent: supportedRule({
    id: "hook.event.incompatible",
    surface: "hook",
    disposition: "metadata-only",
    requirementCapabilityIds: noRequirements,
    message: "The hook event has no faithful Pi lifecycle boundary; the hook is retained but not activated",
    rank: 90,
  }),
  supportedEvent: supportedRule({
    id: "hook.event.supported",
    surface: "hook",
    disposition: "supported",
    requirementCapabilityIds: noRequirements,
    message: "The hook event maps to a Pi lifecycle boundary",
    rank: 100,
  }),
  subagentEvent: supportedRule({
    id: "hook.event.subagent",
    surface: "hook",
    disposition: "supported",
    requirementCapabilityIds: [capability(RuntimeCapabilityRegistry.subagentInterception.id)],
    message: "The subagent hook requires lifecycle interception",
    rank: 110,
  }),
} as const;

const hookMetadataKeys = {
  prefixes: ["handler", "group", "claude.hook", "codex.hook"] as const,
  statusMessage: ["statusMessage", "status_message", "statusText"] as const,
  shell: ["shell"] as const,
  async: ["async", "asyncRewake"] as const,
  ifRule: ["if", "conditions"] as const,
} as const;

const hookEvents = {
  supported: ordinaryHookEvents,
  subagent: subagentHookEvents,
  incompatible: incompatibleHookEvents,
  rules: hookHandlerRules,
  metadata: hookMetadataKeys,
  conditionFields: HookConditionFieldRegistry,
  conditionOperators: HookConditionOperatorRegistry,
  conditionOperatorDefinitions: HookConditionOperatorDefinitionRegistry,
  conditionPredicateKeys: ["field", "operator", "value"] as const,
  conditionWrapperKeys: ["if"] as const,
  definitions: HookRuntimeEventDefinitionRegistry,
} as const;

const mcpRules = {
  transportStdio: supportedRule({
    id: "mcp.transport.stdio",
    surface: "mcp-server",
    disposition: "supported",
    requirementCapabilityIds: [
      capability(RuntimeCapabilityRegistry.mcpRuntime.id),
      capability(RuntimeCapabilityRegistry.mcpTransportStdio.id),
    ],
    message: "MCP standard-I/O transport is supported",
    rank: 10,
  }),
  transportStreamableHttp: supportedRule({
    id: "mcp.transport.streamable-http",
    surface: "mcp-server",
    disposition: "supported",
    requirementCapabilityIds: [
      capability(RuntimeCapabilityRegistry.mcpRuntime.id),
      capability(RuntimeCapabilityRegistry.mcpTransportStreamableHttp.id),
    ],
    message: "MCP Streamable HTTP transport is supported",
    rank: 20,
  }),
  transportSecurity: supportedRule({
    id: "mcp.transport.security",
    surface: "mcp-server",
    disposition: "incompatible",
    requirementCapabilityIds: noRequirements,
    diagnosticCode: ErrorCodeRegistry.unsupportedDeclaration,
    message: "MCP credentials require HTTPS; plaintext HTTP is limited to exact unauthenticated loopback consent",
    rank: 25,
  }),
  transportSse: supportedRule({
    id: "mcp.transport.sse",
    surface: "mcp-server",
    disposition: "metadata-only",
    requirementCapabilityIds: noRequirements,
    message: "Legacy MCP SSE transport has no faithful runtime capability; the server is retained but not activated",
    rank: 30,
  }),
  transportWebsocket: supportedRule({
    id: "mcp.transport.websocket",
    surface: "mcp-server",
    disposition: "metadata-only",
    requirementCapabilityIds: noRequirements,
    message: "MCP WebSocket transport is not supported; the server is retained but not activated",
    rank: 40,
  }),
  oauthAuthorizationCode: supportedRule({
    id: "mcp.oauth.authorization-code",
    surface: "mcp-server",
    disposition: "supported",
    requirementCapabilityIds: [
      capability(RuntimeCapabilityRegistry.mcpRuntime.id),
      capability(RuntimeCapabilityRegistry.mcpOAuthAuthorizationCode.id),
    ],
    message: "MCP authorization-code OAuth is supported by the selected runtime",
    rank: 50,
  }),
  oauthClientCredentials: supportedRule({
    id: "mcp.oauth.client-credentials",
    surface: "mcp-server",
    disposition: "supported",
    requirementCapabilityIds: [
      capability(RuntimeCapabilityRegistry.mcpRuntime.id),
      capability(RuntimeCapabilityRegistry.mcpOAuthClientCredentials.id),
    ],
    message: "MCP client-credentials OAuth is supported by the selected runtime",
    rank: 60,
  }),
  featuresCore: supportedRule({
    id: "mcp.features.core",
    surface: "mcp-server",
    disposition: "supported",
    requirementCapabilityIds: [capability(RuntimeCapabilityRegistry.mcpRuntime.id)],
    message: "MCP core configuration features are supported",
    rank: 70,
  }),
  featureResources: supportedRule({
    id: "mcp.feature.resources",
    surface: "mcp-server",
    disposition: "supported",
    requirementCapabilityIds: [capability(RuntimeCapabilityRegistry.mcpResources.id)],
    message: "MCP resource access is supported by the selected runtime",
    rank: 75,
  }),
  featureToolApproval: supportedRule({
    id: "mcp.feature.tool-approval",
    surface: "mcp-server",
    disposition: "supported",
    requirementCapabilityIds: [capability(RuntimeCapabilityRegistry.mcpToolApproval.id)],
    message: "MCP tool approval policy is supported by the selected runtime",
    rank: 80,
  }),
  featureSampling: supportedRule({
    id: "mcp.feature.sampling",
    surface: "mcp-server",
    disposition: "supported",
    requirementCapabilityIds: [capability(RuntimeCapabilityRegistry.mcpSampling.id)],
    message: "MCP sampling is supported by the selected runtime",
    rank: 90,
  }),
  featureElicitationForm: supportedRule({
    id: "mcp.feature.elicitation-form",
    surface: "mcp-server",
    disposition: "supported",
    requirementCapabilityIds: [capability(RuntimeCapabilityRegistry.mcpElicitationForm.id)],
    message: "MCP form elicitation is supported by the selected runtime",
    rank: 100,
  }),
  featureElicitationUrl: supportedRule({
    id: "mcp.feature.elicitation-url",
    surface: "mcp-server",
    disposition: "supported",
    requirementCapabilityIds: [capability(RuntimeCapabilityRegistry.mcpElicitationUrl.id)],
    message: "MCP URL elicitation is supported by the selected runtime",
    rank: 110,
  }),
  headersHelper: supportedRule({
    id: "mcp.headers-helper",
    surface: "mcp-server",
    disposition: "metadata-only",
    requirementCapabilityIds: noRequirements,
    message: "Dynamic MCP header helpers have no faithful runtime capability; the server is retained but not activated",
    rank: 120,
  }),
  channels: supportedRule({
    id: "mcp.channels",
    surface: "mcp-server",
    disposition: "metadata-only",
    requirementCapabilityIds: noRequirements,
    message: "Claude MCP channels are not a supported Pi runtime surface; the declaration is retained as metadata only",
    rank: 130,
  }),
  defaultDeny: supportedRule({
    id: "mcp.default-deny",
    surface: "mcp-server",
    disposition: "metadata-only",
    requirementCapabilityIds: noRequirements,
    message: "Unknown MCP transport, authentication, feature, or key is retained but not activated",
    rank: 140,
  }),
} as const;

/** Keys understood by the opaque MCP policy boundary. */
const mcpOAuthFlowDefinitions = {
  authorizationCode: {
    aliases: ["authorization-code", "authorization_code", "authorizationCode"] as const,
    ruleId: mcpRules.oauthAuthorizationCode.id,
  },
  clientCredentials: {
    aliases: ["client-credentials", "client_credentials", "clientCredentials"] as const,
    ruleId: mcpRules.oauthClientCredentials.id,
  },
} as const;

const mcpFeaturePayloadDefinitions = {
  toolApproval: {
    fieldGroup: "toolApproval",
    shape: "boolean-flags" as const,
    ruleId: mcpRules.featureToolApproval.id,
  },
  sampling: {
    fieldGroup: "sampling",
    shape: "boolean-flags" as const,
    ruleId: mcpRules.featureSampling.id,
  },
  elicitation: {
    fieldGroup: "elicitation",
    shape: "elicitation-flags" as const,
    ruleId: mcpRules.featureElicitationForm.id,
  },
} as const;

/**
 * One table describes the accepted MCP authentication selector vocabulary.
 * The evaluator uses this table to classify modes before validating their
 * payload, so a declaration cannot become OAuth merely because the first
 * recognizable flow field happened to appear before a bearer selector.
 */
const mcpAuthSelectorDefinitions = {
  modeKeys: ["type", "mode"] as const,
  modes: {
    none: { aliases: ["none"] as const },
    bearer: { aliases: ["bearer", "bearer-env"] as const },
    oauth: { aliases: ["oauth"] as const },
  },
  oauthFlowKeys: ["grantType", "grant_type", "flow"] as const,
  oauthBooleanFlowKeys: [
    "authorizationCode",
    "authorization_code",
    "clientCredentials",
    "client_credentials",
  ] as const,
  bearerEnvironmentKeys: ["env"] as const,
  oauthParameterKeys: [
    "clientId",
    "client_id",
    "redirectUri",
    "redirect_uri",
  ] as const,
} as const;

const mcpAuthKeys = [
  ...mcpAuthSelectorDefinitions.modeKeys,
  ...mcpAuthSelectorDefinitions.bearerEnvironmentKeys,
  ...mcpAuthSelectorDefinitions.oauthParameterKeys,
  ...mcpAuthSelectorDefinitions.oauthFlowKeys,
  ...mcpAuthSelectorDefinitions.oauthBooleanFlowKeys,
] as const;

const allMcpTransports = ["stdio", "streamable-http", "sse", "websocket"] as const;
const remoteMcpTransports = ["streamable-http", "sse", "websocket"] as const;

/**
 * This is the sole MCP field vocabulary. Recognition, transport coherence,
 * aliases, output targets, and collision behavior all derive from these rows.
 */
const mcpFieldGroups = {
  transport: {
    target: "transport",
    aliases: ["transport", "type"],
    unit: "transport",
    collision: "canonical-equality",
    transports: allMcpTransports,
  },
  command: {
    target: "launch.command",
    aliases: ["command"],
    unit: "non-empty-string",
    collision: "exact-equality",
    transports: ["stdio"] as const,
  },
  arguments: {
    target: "launch.arguments",
    aliases: ["args"],
    unit: "string-array",
    collision: "exact-equality",
    transports: ["stdio"] as const,
  },
  environment: {
    target: "launch.environment",
    aliases: ["env"],
    unit: "string-record",
    collision: "exact-equality",
    transports: ["stdio"] as const,
  },
  workingDirectory: {
    target: "launch.workingDirectory",
    aliases: ["cwd", "workingDirectory"],
    unit: "string",
    collision: "exact-equality",
    transports: ["stdio"] as const,
  },
  url: {
    target: "launch.url",
    aliases: ["url"],
    unit: "transport-url",
    collision: "exact-equality",
    transports: remoteMcpTransports,
  },
  headers: {
    target: "launch.headers",
    aliases: ["headers", "features.headers"],
    unit: "headers",
    collision: "exact-equality",
    transports: remoteMcpTransports,
  },
  authentication: {
    target: "options.auth",
    aliases: ["auth", "oauth", "authentication", "bearerTokenEnv", "features.oauth"],
    externalBearerAlias: "bearerTokenEnv",
    unit: "authentication-mode",
    collision: "coherent-single-mode",
    transports: remoteMcpTransports,
  },
  startupTimeout: {
    target: "options.startupTimeoutMs",
    aliases: ["startupTimeout", "timeoutMs"],
    unit: "milliseconds",
    collision: "exact-equality",
    transports: allMcpTransports,
  },
  toolTimeout: {
    target: "options.toolTimeoutMs",
    aliases: ["toolTimeout", "timeout"],
    unit: "milliseconds",
    collision: "exact-equality",
    transports: allMcpTransports,
  },
  tools: {
    target: "options.tools",
    aliases: ["tools"],
    unit: "direct-tools-or-map",
    collision: "exact-equality",
    transports: allMcpTransports,
  },
  allowedTools: {
    target: "options.allowedTools",
    aliases: ["allowTools", "allowedTools", "tools.allow"],
    unit: "exact-string-set",
    collision: "set-equality",
    transports: allMcpTransports,
  },
  deniedTools: {
    target: "options.deniedTools",
    aliases: ["denyTools", "disabledTools", "tools.deny"],
    unit: "exact-string-set",
    collision: "set-equality",
    transports: allMcpTransports,
  },
  instructions: {
    target: "options.instructions",
    aliases: ["instructions"],
    unit: "string",
    collision: "exact-equality",
    transports: allMcpTransports,
  },
  resources: {
    target: "options.resources",
    aliases: ["resources"],
    unit: "resources",
    collision: "exact-equality",
    transports: allMcpTransports,
  },
  toolApproval: {
    target: "options.toolApproval",
    aliases: ["toolApproval", "tool_approval", "features.toolApproval", "features.tool_approval"],
    unit: "boolean-flags",
    collision: "reject-duplicates",
    transports: allMcpTransports,
  },
  sampling: {
    target: "options.sampling",
    aliases: ["sampling", "features.sampling"],
    unit: "boolean-flags",
    collision: "reject-duplicates",
    transports: allMcpTransports,
  },
  elicitation: {
    target: "options.elicitation",
    aliases: ["elicitation", "features.elicitation"],
    unit: "elicitation-flags",
    collision: "reject-duplicates",
    transports: allMcpTransports,
  },
  headersHelper: {
    target: "unsupported.headersHelper",
    aliases: ["headersHelper"],
    unit: "unsupported",
    collision: "reject-duplicates",
    transports: remoteMcpTransports,
  },
  channels: {
    target: "unsupported.channels",
    aliases: ["channels"],
    unit: "unsupported",
    collision: "reject-duplicates",
    transports: remoteMcpTransports,
  },
} as const;

const mcpKeyDefinitions = {
  transport: "transport",
  transportValues: allMcpTransports,
  typeValues: ["stdio", "streamable-http", "http", "sse", "websocket"] as const,
  transportAliases: { http: "streamable-http" } as const,
  fieldGroups: mcpFieldGroups,
  type: "type",
  command: "command",
  args: "args",
  env: "env",
  cwd: "cwd",
  workingDirectory: "workingDirectory",
  url: "url",
  headers: "headers",
  bearerTokenEnv: "bearerTokenEnv",
  auth: "auth",
  oauth: "oauth",
  authentication: "authentication",
  timeout: "timeout",
  startupTimeout: "startupTimeout",
  toolTimeout: "toolTimeout",
  timeoutMs: "timeoutMs",
  allowTools: "allowTools",
  allowedTools: "allowedTools",
  denyTools: "denyTools",
  disabledTools: "disabledTools",
  tools: "tools",
  instructions: "instructions",
  resources: "resources",
  toolApproval: "toolApproval",
  tool_approval: "tool_approval",
  sampling: "sampling",
  elicitation: "elicitation",
  features: "features",
  featureValues: ["tool-approval", "sampling", "elicitation-form", "elicitation-url"] as const,
  featurePayloadDefinitions: mcpFeaturePayloadDefinitions,
  oauthGrantTypes: Object.values(mcpOAuthFlowDefinitions).flatMap((definition) => definition.aliases),
  oauthFlowDefinitions: mcpOAuthFlowDefinitions,
  authSelectorDefinitions: mcpAuthSelectorDefinitions,
  authKeys: mcpAuthKeys,
  booleanFeatureKeys: ["enabled", "required"] as const,
  elicitationFeatureKeys: ["form", "url"] as const,
  headerEnvironmentKeys: ["env"] as const,
  headersHelper: "headersHelper",
  channels: "channels",
} as const;

const foreignRules = {
  defaultDeny: supportedRule({
    id: "foreign.default-deny",
    surface: "foreign",
    disposition: "metadata-only",
    requirementCapabilityIds: noRequirements,
    message: "Foreign runtime components are retained as metadata only and are never executed",
    rank: 10,
  }),
  piExtension: supportedRule({
    id: "foreign.pi-extension",
    surface: "foreign",
    disposition: "metadata-only",
    requirementCapabilityIds: noRequirements,
    message: "This plugin ships a Pi extension (tools/commands). This host doesn't run plugin extensions, so those won't register — install the plugin pi-natively to use them",
    rank: 10,
  }),
} as const;

const reportRules = {
  verdictRegistry: supportedRule({
    id: "verdict.registry",
    surface: "report",
    disposition: "supported",
    requirementCapabilityIds: noRequirements,
    message: "Compatibility reports use exactly the supported verdict vocabulary",
    rank: 10,
  }),
  requirementSeparateStatus: supportedRule({
    id: "requirement.separate-status",
    surface: "report",
    disposition: "supported",
    requirementCapabilityIds: noRequirements,
    message: "Runtime requirement availability is separate from component verdicts",
    rank: 20,
  }),
  metadataOnly: supportedRule({
    id: "verdict.metadata-only",
    surface: "report",
    disposition: "metadata-only",
    requirementCapabilityIds: noRequirements,
    message: "Presentation-only metadata does not block activation",
    rank: 30,
  }),
  incompatible: supportedRule({
    id: "verdict.incompatible",
    surface: "report",
    disposition: "incompatible",
    requirementCapabilityIds: noRequirements,
    diagnosticCode: ErrorCodeRegistry.unsupportedDeclaration,
    message: "An incompatible component blocks complete-plugin activation",
    rank: 40,
  }),
  knownPresentation: supportedRule({
    id: "metadata.known-presentation",
    surface: "report",
    disposition: "metadata-only",
    requirementCapabilityIds: noRequirements,
    message: "Known plugin presentation metadata is retained without runtime meaning",
    rank: 50,
  }),
} as const;

const configurationRules = {
  descriptor: supportedRule({
    id: "configuration.descriptor",
    surface: "configuration",
    disposition: "metadata-only",
    requirementCapabilityIds: noRequirements,
    message: "Configuration descriptors are advisory input for downstream lifecycle services",
    rank: 10,
  }),
  requiredInput: supportedRule({
    id: "configuration.required-input",
    surface: "configuration",
    disposition: "metadata-only",
    requirementCapabilityIds: noRequirements,
    message: "Configuration input is required downstream before activation",
    rank: 20,
  }),
  sensitive: supportedRule({
    id: "configuration.sensitive",
    surface: "configuration",
    disposition: "metadata-only",
    requirementCapabilityIds: noRequirements,
    message: "Sensitive configuration must be supplied through the secret boundary",
    rank: 30,
  }),
} as const;

const marketplaceRules = {
  availabilityAvailable: supportedRule({
    id: "marketplace.availability.available",
    surface: "marketplace",
    disposition: "metadata-only",
    requirementCapabilityIds: noRequirements,
    message: "Marketplace availability is advisory context; lifecycle policy decides installability",
    rank: 10,
  }),
  availabilityInstalledByDefault: supportedRule({
    id: "marketplace.availability.installed-by-default",
    surface: "marketplace",
    disposition: "metadata-only",
    requirementCapabilityIds: noRequirements,
    message: "Marketplace installed-by-default policy is advisory context",
    rank: 20,
  }),
  availabilityNotAvailable: supportedRule({
    id: "marketplace.availability.not-available",
    surface: "marketplace",
    disposition: "metadata-only",
    requirementCapabilityIds: noRequirements,
    message: "Marketplace not-available policy is advisory context; it does not alter compatibility",
    rank: 30,
  }),
  policy: supportedRule({
    id: "marketplace.policy",
    surface: "marketplace",
    disposition: "metadata-only",
    requirementCapabilityIds: noRequirements,
    message: "Marketplace authentication and installation policy is lifecycle context",
    rank: 40,
  }),
} as const;

/**
 * All compatibility knowledge is data in this registry.  Evaluator dispatch,
 * capability references, diagnostic messages, and contract tables consume the
 * sections below instead of keeping switch-local semantic lists.
 */
export const CompatibilityPolicyRegistry = {
  skills: skillRules,
  hookHandlers: hookHandlerRules,
  hookEvents,
  mcp: {
    ...mcpRules,
    keys: mcpKeyDefinitions,
  },
  foreign: foreignRules,
  configuration: configurationRules,
  marketplace: marketplaceRules,
  report: reportRules,
  metadata: {
    knownPluginPresentationKeys: [
      "owner",
      "description",
      "category",
      "tags",
      "interface",
      "visibility",
    ] as const,
  },
} as const;

export type CompatibilityPolicyRegistryType = typeof CompatibilityPolicyRegistry;

/** Stable flattened view for data-driven contract tests and tooling. */
function onlyRules(values: readonly unknown[]): readonly CompatibilityPolicyRule[] {
  return values.filter((value): value is CompatibilityPolicyRule =>
    typeof value === "object" && value !== null && !Array.isArray(value) &&
    "id" in value && "surface" in value && "disposition" in value,
  );
}

export const CompatibilityPolicyRuleRegistry = Object.freeze(
  Object.fromEntries([
    ...onlyRules(Object.values(skillRules)),
    ...onlyRules(Object.values(hookHandlerRules)),
    ...onlyRules(Object.values(mcpRules)),
    ...onlyRules(Object.values(foreignRules)),
    ...onlyRules(Object.values(configurationRules)),
    ...onlyRules(Object.values(marketplaceRules)),
    ...onlyRules(Object.values(reportRules)),
  ].map((rule) => [rule.id, rule])),
) as Readonly<Record<string, CompatibilityPolicyRule>>;

export const CompatibilityPolicyRuleSchema = z
  .object({
    id: z.string().min(1),
    surface: z.enum(["skill", "hook", "mcp-server", "foreign", "configuration", "marketplace", "report"]),
    disposition: z.enum(["supported", "metadata-only", "incompatible"]),
    requirementCapabilityIds: z.array(RuntimeCapabilityIdSchema).readonly(),
    diagnosticCode: ErrorCodeSchema.optional(),
    message: z.string().min(1),
    rank: z.number().int().nonnegative(),
  })
  .strict()
  .readonly();

export const CompatibilityPolicyRulesSchema = z
  .record(z.string().min(1), CompatibilityPolicyRuleSchema)
  .readonly();

export const RuntimeCapabilityRegistrySchema = z
  .record(
    z.string().min(1),
    z.object({
      id: RuntimeCapabilityIdSchema,
      description: z.string().min(1),
      rank: z.number().int().nonnegative(),
    }).strict().readonly(),
  )
  .readonly();

export type HookEvent =
  | (typeof CompatibilityPolicyRegistry.hookEvents.supported)[number]
  | (typeof CompatibilityPolicyRegistry.hookEvents.subagent)[number]
  | (typeof CompatibilityPolicyRegistry.hookEvents.incompatible)[number];

export const HookEventSchema = z.enum([
  ...CompatibilityPolicyRegistry.hookEvents.supported,
  ...CompatibilityPolicyRegistry.hookEvents.subagent,
  ...CompatibilityPolicyRegistry.hookEvents.incompatible,
] as [HookEvent, ...HookEvent[]]);

export const MCPTransportSchema = z.enum(
  CompatibilityPolicyRegistry.mcp.keys.transportValues,
);
export type MCPTransport = z.infer<typeof MCPTransportSchema>;

export const MCPFeatureSchema = z.enum(
  CompatibilityPolicyRegistry.mcp.keys.featureValues,
);
export type MCPFeature = z.infer<typeof MCPFeatureSchema>;

// Keep these aliases discoverable for callers that use the domain vocabulary.
export const RuntimeCapabilityStatusRegistry = RuntimeRequirementStatusRegistry;
export const RuntimeCapabilityStatusSchema = z.enum(runtimeCapabilityStatuses);
