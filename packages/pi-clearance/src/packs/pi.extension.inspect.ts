import { defineShippedPack } from "./define.ts";

export type KnownExtensionToolOperation =
  | "status-read"
  | "state-read"
  | "workspace-search"
  | "interactive"
  | "mutation"
  | "agent-dispatch"
  | "network-read"
  | "embedded-shell";

export type KnownExtensionActivation =
  | "when-tool-registered"
  | "package-enable"
  | "review-only"
  | "command-only"
  | "pi-config-owned";

export interface KnownExtensionToolSpec {
  readonly toolName: string;
  readonly packageName?: string;
  readonly operation: KnownExtensionToolOperation;
  readonly inBaseline: boolean;
  readonly activation: KnownExtensionActivation;
  readonly publicPackage: boolean;
  readonly packId?: string;
  readonly rationale: string;
}

export interface KnownExtensionPackageAuditEntry {
  readonly packageName: string;
  readonly activation: Extract<
    KnownExtensionActivation,
    "command-only" | "package-enable" | "pi-config-owned"
  >;
  readonly publicPackage: boolean;
  readonly rationale: string;
}

const BASELINE_MEMBERSHIP = true as const;

export const PI_EXTENSION_INSPECT_TOOLS = [
  "multi_grep",
  "jobs",
  "get_goal",
  "list_goal_templates",
  "list_goal_queue",
  "get_subagent_result",
  "list_subagent_models",
] as const;

/**
 * Agent dispatch is owner-approved: the spawned child session runs under the
 * same clearance pipeline, so dispatch itself is a bounded typed operation.
 */
export const PI_EXTENSION_AGENT_DISPATCH_TOOLS = [
  "subagent",
  "steer_subagent",
] as const;

export const PI_EXTENSION_WORKFLOW_TOOLS = [
  "todo",
  "ask_user_question",
  "create_goal",
  "create_goal_from_template",
  "update_goal",
  "clear_goal",
  "enqueue_goal",
  "start_queued_goal",
  "dequeue_goal",
  "remove_queued_goal",
] as const;

export const PI_EXTENSION_NETWORK_RESEARCH_TOOLS = [
  "zai_web_search",
  "fetch_content",
  "search_repo_docs",
  "get_repo_structure",
  "read_repo_file",
  "umans_web_search",
  "umans_vision",
] as const;

export const PI_EXTENSION_REVIEW_BOUNDARY_TOOLS = [
  "background",
  "monitor",
] as const;

const toolMatcher = (toolName: string) => ({ tool: toolName });
const toolAnyMatcher = (toolNames: readonly string[]) => ({
  any: toolNames.map(toolMatcher),
});

const extensionInspectRawPack = {
  version: 1,
  id: "pi.extension.inspect",
  rules: [
    {
      id: "pi.extension.inspect:allow-typed-status-and-workspace-reads",
      effect: "allow",
      match: toolAnyMatcher(PI_EXTENSION_INSPECT_TOOLS),
      reason:
        "typed extension status/read/search operation stays inside the extension's bounded API",
      provenance: { source: "shipped" },
    },
    {
      id: "pi.extension.inspect:allow-agent-dispatch",
      effect: "allow",
      match: toolAnyMatcher(PI_EXTENSION_AGENT_DISPATCH_TOOLS),
      reason:
        "agent dispatch is approved; the spawned child session runs under the same clearance pipeline",
      provenance: { source: "shipped" },
    },
  ],
} as const;

const extensionWorkflowRawPack = {
  version: 1,
  id: "pi.extension.workflow",
  rules: [
    {
      id: "pi.extension.workflow:allow-bounded-session-workflow-tools",
      effect: "allow",
      match: toolAnyMatcher(PI_EXTENSION_WORKFLOW_TOOLS),
      reason:
        "bounded Pi workflow tool mutates extension-owned session or goal state, not arbitrary host files or shell",
      provenance: { source: "shipped" },
    },
  ],
} as const;

const extensionNetworkResearchRawPack = {
  version: 1,
  id: "pi.extension.network-research",
  rules: [
    {
      id: "pi.extension.network-research:allow-provider-read-tools",
      effect: "allow",
      match: toolAnyMatcher(PI_EXTENSION_NETWORK_RESEARCH_TOOLS),
      reason:
        "typed provider/research tool performs a bounded read across an explicit network or privacy boundary",
      provenance: { source: "shipped" },
    },
  ],
} as const;

const extensionReviewBoundariesRawPack = {
  version: 1,
  id: "pi.extension.review-boundaries",
  rules: [
    {
      id: "pi.extension.review-boundaries:review-embedded-shell-and-agent-dispatch",
      effect: "review",
      match: toolAnyMatcher(PI_EXTENSION_REVIEW_BOUNDARY_TOOLS),
      reason:
        "embedded-shell wrapper is uncertain because its inner command or wrapper fields could not be decided by structural policy",
      provenance: { source: "shipped" },
    },
  ],
} as const;

export const piExtensionInspectPack = defineShippedPack(
  extensionInspectRawPack,
);
export const piExtensionWorkflowPack = defineShippedPack(
  extensionWorkflowRawPack,
);
export const piExtensionNetworkResearchPack = defineShippedPack(
  extensionNetworkResearchRawPack,
);
export const piExtensionReviewBoundariesPack = defineShippedPack(
  extensionReviewBoundariesRawPack,
);

export const KNOWN_EXTENSION_TOOL_SPECS = [
  {
    toolName: "fffind",
    packageName: "@ff-labs/pi-fff",
    operation: "workspace-search",
    inBaseline: BASELINE_MEMBERSHIP,
    activation: "when-tool-registered",
    publicPackage: true,
    packId: "pi.inspect.read",
    rationale:
      "workspace-indexed read/search tool; path-scoped coverage is shipped in pi.inspect.read",
  },
  {
    toolName: "ffgrep",
    packageName: "@ff-labs/pi-fff",
    operation: "workspace-search",
    inBaseline: BASELINE_MEMBERSHIP,
    activation: "when-tool-registered",
    publicPackage: true,
    packId: "pi.inspect.read",
    rationale:
      "workspace-indexed read/search tool; path-scoped coverage is shipped in pi.inspect.read",
  },
  {
    toolName: "multi_grep",
    packageName: "@ff-labs/pi-fff",
    operation: "workspace-search",
    inBaseline: BASELINE_MEMBERSHIP,
    activation: "when-tool-registered",
    publicPackage: true,
    packId: piExtensionInspectPack.id,
    rationale:
      "workspace-indexed multi-search is read-only and bounded by the extension API",
  },
  {
    toolName: "jobs",
    packageName: "nklisch/skills:background-tasks",
    operation: "status-read",
    inBaseline: BASELINE_MEMBERSHIP,
    activation: "when-tool-registered",
    publicPackage: true,
    packId: piExtensionInspectPack.id,
    rationale:
      "job listing/status is a typed read of extension-owned process registry state",
  },
  {
    toolName: "todo",
    packageName: "@juicesharp/rpiv-todo",
    operation: "mutation",
    inBaseline: BASELINE_MEMBERSHIP,
    activation: "when-tool-registered",
    publicPackage: true,
    packId: piExtensionWorkflowPack.id,
    rationale:
      "todo updates mutate typed session/workflow state rather than host files or shell",
  },
  {
    toolName: "ask_user_question",
    packageName: "@juicesharp/rpiv-ask-user-question",
    operation: "interactive",
    inBaseline: BASELINE_MEMBERSHIP,
    activation: "when-tool-registered",
    publicPackage: true,
    packId: piExtensionWorkflowPack.id,
    rationale: "interactive question prompts are bounded UI/session operations",
  },
  ...["get_goal", "list_goal_templates", "list_goal_queue"].map(
    (toolName): KnownExtensionToolSpec => ({
      toolName,
      packageName: "pi-goals",
      operation: "state-read",
      inBaseline: BASELINE_MEMBERSHIP,
      activation: "when-tool-registered",
      publicPackage: true,
      packId: piExtensionInspectPack.id,
      rationale:
        "goal state/list reads are typed and bounded to the goal store",
    }),
  ),
  ...[
    "create_goal",
    "create_goal_from_template",
    "update_goal",
    "clear_goal",
    "enqueue_goal",
    "start_queued_goal",
    "dequeue_goal",
    "remove_queued_goal",
  ].map(
    (toolName): KnownExtensionToolSpec => ({
      toolName,
      packageName: "pi-goals",
      operation: "mutation",
      inBaseline: BASELINE_MEMBERSHIP,
      activation: "when-tool-registered",
      publicPackage: true,
      packId: piExtensionWorkflowPack.id,
      rationale:
        "goal lifecycle and queue operations mutate typed goal state, not arbitrary host resources",
    }),
  ),
  {
    toolName: "get_subagent_result",
    packageName: "@gotgenes/pi-subagents",
    operation: "status-read",
    inBaseline: BASELINE_MEMBERSHIP,
    activation: "when-tool-registered",
    publicPackage: true,
    packId: piExtensionInspectPack.id,
    rationale:
      "subagent result polling is a typed status/read operation after dispatch has already crossed its review boundary",
  },
  ...["subagent", "steer_subagent"].map(
    (toolName): KnownExtensionToolSpec => ({
      toolName,
      packageName: "@gotgenes/pi-subagents",
      operation: "agent-dispatch",
      inBaseline: BASELINE_MEMBERSHIP,
      activation: "when-tool-registered",
      publicPackage: true,
      packId: piExtensionInspectPack.id,
      rationale:
        "agent dispatch is owner-approved; child sessions stay gated by their own clearance pipeline",
    }),
  ),
  ...["background", "monitor"].map(
    (toolName): KnownExtensionToolSpec => ({
      toolName,
      packageName: "nklisch/skills:background-tasks",
      operation: "embedded-shell",
      inBaseline: BASELINE_MEMBERSHIP,
      activation: "review-only",
      publicPackage: true,
      packId: piExtensionReviewBoundariesPack.id,
      rationale:
        "the tool embeds a shell command; policy projects valid inner commands through bash and keeps this review boundary for missing or uncertain projections",
    }),
  ),
  ...[
    "zai_web_search",
    "fetch_content",
    "search_repo_docs",
    "get_repo_structure",
    "read_repo_file",
  ].map(
    (toolName): KnownExtensionToolSpec => ({
      toolName,
      packageName: "nklisch/skills:zai-research",
      operation: "network-read",
      inBaseline: BASELINE_MEMBERSHIP,
      activation: "when-tool-registered",
      publicPackage: true,
      packId: piExtensionNetworkResearchPack.id,
      rationale:
        "typed research reads cross an explicit provider/network/privacy boundary and therefore live in the permissive profile",
    }),
  ),
  ...["umans_web_search", "umans_vision"].map(
    (toolName): KnownExtensionToolSpec => ({
      toolName,
      packageName: "pi-provider-umans",
      operation: "network-read",
      inBaseline: BASELINE_MEMBERSHIP,
      activation: "when-tool-registered",
      publicPackage: true,
      packId: piExtensionNetworkResearchPack.id,
      rationale:
        "typed provider reads cross an explicit external-service/privacy boundary and therefore live in the permissive profile",
    }),
  ),
] as const satisfies readonly KnownExtensionToolSpec[];

export const COMMAND_ONLY_EXTENSION_AUDIT_ENTRIES = [
  {
    packageName: "pi-tool-display",
    activation: "command-only",
    publicPackage: true,
    rationale:
      "display-only package decorates tool rendering and contributes no model tool approval surface",
  },
  {
    packageName: "pi-catppuccin-tui",
    activation: "command-only",
    publicPackage: true,
    rationale:
      "theme package changes UI presentation and contributes no model tool approval surface",
  },
  {
    packageName: "pi-model-modes",
    activation: "command-only",
    publicPackage: true,
    rationale:
      "slash-command/model-mode package does not register a reviewed model tool surface for core policy",
  },
  {
    packageName: "@narumitw/pi-codex-usage",
    activation: "command-only",
    publicPackage: true,
    rationale:
      "usage/status UI package has no model tool approval surface to hard-code in core packs",
  },
] as const satisfies readonly KnownExtensionPackageAuditEntry[];

export const PI_CONFIG_OWNED_EXTENSION_AUDIT_ENTRIES = [
  {
    packageName: "../pi-config/pi/extensions/fff-compat-search.ts",
    activation: "pi-config-owned",
    publicPackage: false,
    rationale:
      "local fast_find/fast_grep compatibility tools are machine-specific and belong in a pi-config-owned pack or user overlay",
  },
  {
    packageName: "../pi-config/pi/extensions/model-list.ts",
    activation: "pi-config-owned",
    publicPackage: false,
    rationale:
      "local list_subagent_models status helper is pi-config-specific and should be packaged or overlaid outside core",
  },
  {
    packageName: "../pi-config/pi/extensions/context-window-footer",
    activation: "pi-config-owned",
    publicPackage: false,
    rationale:
      "local context display helper is not a public extension policy surface",
  },
  {
    packageName: "../pi-config/pi/extensions/zz-rtk-rewrite.ts",
    activation: "pi-config-owned",
    publicPackage: false,
    rationale:
      "local RTK rewrite is a post-approval transform/command surface and belongs in pi-config-owned policy if needed",
  },
] as const satisfies readonly KnownExtensionPackageAuditEntry[];

export const PUBLIC_EXTENSION_PACKAGE_AUDIT = [
  ...KNOWN_EXTENSION_TOOL_SPECS,
  ...COMMAND_ONLY_EXTENSION_AUDIT_ENTRIES,
] as const;

export const PI_CONFIG_EXTENSION_PACK_FOLLOW_UP =
  PI_CONFIG_OWNED_EXTENSION_AUDIT_ENTRIES;
