import { z } from "zod";
import {
  ComponentKindRegistry,
  ComponentSchema,
  flattenComponents,
  type Component,
  type ForeignComponent,
  type HookComponent,
  type McpServerComponent,
  type RetainedMetadata,
  type SkillComponent,
} from "./components.js";
import {
  ComponentAssessmentSchema,
  ComponentVerdictRegistry,
  createCompatibilityReport,
  deriveActivatable,
  RuntimeRequirementAssessmentSchema,
  RuntimeRequirementIdSchema,
  RuntimeRequirementSchema,
  RuntimeRequirementStatusRegistry,
  type CompatibilityReport,
  type ComponentAssessment,
  type RuntimeRequirementAssessment,
  type RuntimeRequirementId,
} from "./compatibility.js";
import {
  CompatibilityPolicyRegistry,
  CompatibilityPolicyRuleRegistry,
  RuntimeCapabilityRegistry,
  RuntimeCapabilitySnapshotSchema,
  type CompatibilityPolicyRule,
  type RuntimeCapabilityId,
  type RuntimeCapabilitySnapshot,
} from "./compatibility-policy.js";
import { PluginConfigurationSchema, type ConfigurationOption } from "./configuration.js";
import {
  DiagnosticSchema,
  ErrorCodeRegistry,
  type Diagnostic,
} from "./errors.js";
import {
  MarketplaceInstallationPolicySchema,
  type MarketplaceInstallationPolicy,
} from "./marketplace.js";
import { NormalizedPluginSchema, type NormalizedPlugin } from "./plugin.js";
import { ProvenanceSchema, type Provenance } from "./provenance.js";
import { type JsonValue } from "./schema.js";
import { compileHookSelector } from "./hook-runtime-contract.js";
import { PluginKeySchema } from "./identity.js";
import { analyzeMcpCompatibility } from "./mcp-compatibility-plan.js";

const EVALUATION_OPERATION = "evaluateCompatibility";
const REQUIREMENT_ID_PREFIX = "requirement-v1";

type JsonRecord = { readonly [key: string]: JsonValue };

type RequirementUse = Readonly<{
  capability: RuntimeCapabilityId;
  provenance: readonly Provenance[];
  ruleId: string;
}>;

type PolicyDecision = Readonly<{
  verdict: "supported" | "metadata-only" | "incompatible";
  requirements: readonly RequirementUse[];
  diagnostics: readonly Diagnostic[];
}>;

/**
 * A triggered policy rule blocks activation only when its disposition says
 * so. Metadata-only rules degrade the component instead: it stays in the
 * compatibility evidence and is skipped at runtime projection, which keeps
 * the rest of the plugin installable.
 */
function ruleOutcome(ruleId: string): "metadata-only" | "incompatible" {
  return ruleById(ruleId).disposition === "incompatible" ? "incompatible" : "metadata-only";
}

function ruleSeverity(ruleId: string): "warning" | "error" {
  return ruleById(ruleId).disposition === "incompatible" ? "error" : "warning";
}

export const CompatibilityEvaluationInputSchema = z
  .object({
    plugin: NormalizedPluginSchema,
    capabilities: RuntimeCapabilitySnapshotSchema,
    marketplacePolicy: MarketplaceInstallationPolicySchema.optional(),
  })
  .strict()
  .readonly();
export type CompatibilityEvaluationInput = z.infer<typeof CompatibilityEvaluationInputSchema>;

function isRecord(value: JsonValue): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function stableJson(value: JsonValue): string {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((entry) => stableJson(entry)).join(",")}]`;
  const record = value as JsonRecord;
  return `{${Object.keys(record).sort(compareText).map((key) => `${JSON.stringify(key)}:${stableJson(record[key]!)}`).join(",")}}`;
}

function sourceLocationKey(provenance: Provenance): string {
  const location = provenance.location;
  return stableJson([
    location.host,
    location.documentKind,
    location.path,
    location.pointer ?? "",
    location.line ?? 0,
    location.column ?? 0,
  ]);
}

function sortedProvenance(values: readonly Provenance[]): readonly Provenance[] {
  const result: Provenance[] = [];
  for (const candidate of [...values].map((value) => ProvenanceSchema.parse(value)).sort((left, right) =>
    compareText(sourceLocationKey(left), sourceLocationKey(right)))) {
    if (!result.some((existing) => sourceLocationKey(existing) === sourceLocationKey(candidate))) {
      result.push(candidate);
    }
  }
  if (result.length === 0) throw new Error("compatibility provenance cannot be empty");
  return result;
}

function sourceLocations(values: readonly Provenance[]): JsonValue {
  return sortedProvenance(values).map((provenance) => {
    const location = provenance.location;
    return {
      host: location.host,
      documentKind: location.documentKind,
      path: location.path,
      ...(location.pointer === undefined ? {} : { pointer: location.pointer }),
      ...(location.line === undefined ? {} : { line: location.line }),
      ...(location.column === undefined ? {} : { column: location.column }),
    };
  }) as unknown as JsonValue;
}

function firstLocation(values: readonly Provenance[]): Provenance["location"] {
  return sortedProvenance(values)[0]!.location;
}

function ruleById(ruleId: string): CompatibilityPolicyRule {
  const rule = CompatibilityPolicyRuleRegistry[ruleId];
  if (rule === undefined) throw new Error(`compatibility policy registry is missing rule ${ruleId}`);
  return rule;
}

function componentKindRank(kind: Component["kind"]): number {
  const entry = Object.values(ComponentKindRegistry).find((candidate) => candidate.tag === kind);
  if (entry === undefined) throw new Error(`component kind registry is missing ${kind}`);
  return Object.values(ComponentKindRegistry).indexOf(entry);
}

function capabilityRank(capability: string): number {
  const entry = Object.values(RuntimeCapabilityRegistry).find((candidate) => candidate.id === capability);
  if (entry === undefined) throw new Error(`capability registry is missing ${capability}`);
  return entry.rank;
}

function diagnostic(
  pluginKey: string,
  ruleId: string,
  severity: "warning" | "error",
  provenances: readonly Provenance[],
  details: Readonly<Record<string, JsonValue>> = {},
  messageOverride?: string,
  codeOverride?: import("./errors.js").ErrorCode,
): Diagnostic {
  const rule = ruleById(ruleId);
  const safeDetails: Record<string, JsonValue> = {
    ...details,
    ruleId,
    sourceLocations: sourceLocations(provenances),
  };
  return DiagnosticSchema.parse({
    code: codeOverride ?? rule.diagnosticCode ?? ErrorCodeRegistry.unsupportedDeclaration,
    severity,
    operation: EVALUATION_OPERATION,
    message: messageOverride ?? rule.message,
    location: firstLocation(provenances),
    plugin: pluginKey,
    details: safeDetails,
  });
}

function requirementUse(
  ruleId: string,
  provenance: readonly Provenance[],
): readonly RequirementUse[] {
  const rule = ruleById(ruleId);
  return rule.requirementCapabilityIds.map((capability) => ({
    capability,
    provenance: sortedProvenance(provenance),
    ruleId,
  }));
}

function mergeRequirementUses(uses: readonly RequirementUse[]): readonly RequirementUse[] {
  const byCapability = new Map<RuntimeCapabilityId, { provenance: Provenance[]; ruleId: string }>();
  for (const use of uses) {
    const existing = byCapability.get(use.capability);
    if (existing === undefined) {
      byCapability.set(use.capability, {
        provenance: [...use.provenance],
        ruleId: use.ruleId,
      });
      continue;
    }
    existing.provenance = [...existing.provenance, ...use.provenance];
    if (compareText(use.ruleId, existing.ruleId) < 0) existing.ruleId = use.ruleId;
  }
  return [...byCapability.entries()]
    .sort(([left], [right]) => {
      const rank = capabilityRank(left) - capabilityRank(right);
      return rank !== 0 ? rank : compareText(left, right);
    })
    .map(([capability, value]) => ({
      capability,
      provenance: sortedProvenance(value.provenance),
      ruleId: value.ruleId,
    }));
}

function decision(
  verdict: PolicyDecision["verdict"],
  requirements: readonly RequirementUse[],
  diagnostics: readonly Diagnostic[],
): PolicyDecision {
  return {
    verdict,
    requirements: verdict === "supported" ? mergeRequirementUses(requirements) : [],
    diagnostics: [...diagnostics].sort(compareDiagnostics),
  };
}

/**
 * Accumulates the worst outcome across triggered rules. Incompatible rules
 * dominate; metadata-only rules degrade without blocking.
 */
function worstOutcome(
  current: PolicyDecision["verdict"],
  ruleId: string,
): PolicyDecision["verdict"] {
  const outcome = ruleOutcome(ruleId);
  if (outcome === "incompatible") return "incompatible";
  if (current === "incompatible") return current;
  return "metadata-only";
}

function locationJson(location: NonNullable<Diagnostic["location"]>): JsonValue {
  return {
    host: location.host,
    documentKind: location.documentKind,
    path: location.path,
    ...(location.pointer === undefined ? {} : { pointer: location.pointer }),
    ...(location.line === undefined ? {} : { line: location.line }),
    ...(location.column === undefined ? {} : { column: location.column }),
  };
}

function compareDiagnostics(left: Diagnostic, right: Diagnostic): number {
  const severityRank = left.severity === right.severity
    ? 0
    : left.severity === "error" ? -1 : 1;
  if (severityRank !== 0) return severityRank;
  const code = compareText(left.code, right.code);
  if (code !== 0) return code;
  const operation = compareText(left.operation, right.operation);
  if (operation !== 0) return operation;
  const leftLocation = left.location === undefined ? "" : stableJson(locationJson(left.location));
  const rightLocation = right.location === undefined ? "" : stableJson(locationJson(right.location));
  const location = compareText(leftLocation, rightLocation);
  if (location !== 0) return location;
  return compareText(
    left.details === undefined ? "" : stableJson(left.details),
    right.details === undefined ? "" : stableJson(right.details),
  );
}

function metadataField(metadata: RetainedMetadata): string {
  const segments = metadata.key.split(".");
  return segments[segments.length - 1] ?? metadata.key;
}

function metadataProvenance(metadata: RetainedMetadata): readonly Provenance[] {
  return sortedProvenance(metadata.claimed.provenance);
}

function hasMetadataNamespace(key: string, prefixes: readonly string[]): boolean {
  return prefixes.some((prefix) => key === prefix || key.startsWith(`${prefix}.`));
}

function knownCodexInvocationValue(value: JsonValue): boolean {
  if (typeof value === "boolean") return true;
  if (typeof value === "string") return CompatibilityPolicyRegistry.skills.invocationPolicyValues.includes(value as never);
  if (!isRecord(value)) return false;
  const keys = Object.keys(value);
  if (keys.length !== 1) return false;
  const key = keys[0];
  if (key !== "allow_implicit_invocation" && key !== "allowImplicitInvocation" &&
      key !== "implicit_invocation" && key !== "implicitInvocation") return false;
  const setting = value[key];
  return typeof setting === "boolean" ||
    (typeof setting === "string" && CompatibilityPolicyRegistry.skills.invocationPolicyValues.includes(setting as never));
}

function evaluateSkill(
  pluginKey: string,
  component: SkillComponent,
): PolicyDecision {
  const requirements: RequirementUse[] = [];
  const diagnostics: Diagnostic[] = [];
  let verdict: PolicyDecision["verdict"] = "supported";

  for (const metadata of [...component.metadata].sort((left, right) => compareText(left.key, right.key))) {
    const field = metadataField(metadata);
    const provenance = metadataProvenance(metadata);
    const value = metadata.claimed.value;

    if (!hasMetadataNamespace(metadata.key, CompatibilityPolicyRegistry.skills.metadataPrefixes)) {
      verdict = worstOutcome(verdict, CompatibilityPolicyRegistry.skills.unknownFrontmatter.id);
      diagnostics.push(diagnostic(pluginKey, CompatibilityPolicyRegistry.skills.unknownFrontmatter.id, ruleSeverity(CompatibilityPolicyRegistry.skills.unknownFrontmatter.id), provenance, {
        componentId: component.id,
        field,
      }));
      continue;
    }
    if (CompatibilityPolicyRegistry.skills.presentationKeys.includes(field as never)) {
      diagnostics.push(diagnostic(pluginKey, CompatibilityPolicyRegistry.skills.presentation.id, "warning", provenance, {
        componentId: component.id,
        field,
      }));
      continue;
    }
    if (field === "allowed-tools") {
      if (typeof value !== "string") {
        verdict = worstOutcome(verdict, CompatibilityPolicyRegistry.skills.unknownFrontmatter.id);
        diagnostics.push(diagnostic(pluginKey, CompatibilityPolicyRegistry.skills.unknownFrontmatter.id, ruleSeverity(CompatibilityPolicyRegistry.skills.unknownFrontmatter.id), provenance, {
          componentId: component.id,
          field,
        }));
      } else {
        requirements.push(...requirementUse(CompatibilityPolicyRegistry.skills.allowedTools.id, provenance));
      }
      continue;
    }
    if (field === "disable-model-invocation") {
      if (typeof value !== "boolean") {
        verdict = worstOutcome(verdict, CompatibilityPolicyRegistry.skills.unknownFrontmatter.id);
        diagnostics.push(diagnostic(pluginKey, CompatibilityPolicyRegistry.skills.unknownFrontmatter.id, ruleSeverity(CompatibilityPolicyRegistry.skills.unknownFrontmatter.id), provenance, {
          componentId: component.id,
          field,
        }));
      }
      continue;
    }
    if (metadata.key.startsWith("codex.agents.")) {
      if (CompatibilityPolicyRegistry.skills.invocationPolicyKeys.includes(field as never)) {
        if (!knownCodexInvocationValue(value)) {
          verdict = worstOutcome(verdict, CompatibilityPolicyRegistry.skills.unknownFrontmatter.id);
          diagnostics.push(diagnostic(pluginKey, CompatibilityPolicyRegistry.skills.unknownFrontmatter.id, ruleSeverity(CompatibilityPolicyRegistry.skills.unknownFrontmatter.id), provenance, {
            componentId: component.id,
            field,
          }));
        }
      } else {
        diagnostics.push(diagnostic(pluginKey, CompatibilityPolicyRegistry.skills.codexPresentation.id, "warning", provenance, {
          componentId: component.id,
          field,
        }));
      }
      continue;
    }
    if (field === "scoped-hooks") {
      verdict = worstOutcome(verdict, CompatibilityPolicyRegistry.skills.scopedHooks.id);
      diagnostics.push(diagnostic(pluginKey, CompatibilityPolicyRegistry.skills.scopedHooks.id, ruleSeverity(CompatibilityPolicyRegistry.skills.scopedHooks.id), provenance, {
        componentId: component.id,
        field,
      }));
      continue;
    }

    verdict = worstOutcome(verdict, CompatibilityPolicyRegistry.skills.unknownFrontmatter.id);
    diagnostics.push(diagnostic(pluginKey, CompatibilityPolicyRegistry.skills.unknownFrontmatter.id, ruleSeverity(CompatibilityPolicyRegistry.skills.unknownFrontmatter.id), provenance, {
      componentId: component.id,
      field,
    }));
  }

  return decision(verdict, requirements, diagnostics);
}

function evaluateHook(
  pluginKey: string,
  component: HookComponent,
): PolicyDecision {
  const requirements: RequirementUse[] = [];
  const diagnostics: Diagnostic[] = [];
  let verdict: PolicyDecision["verdict"] = "supported";

  const event = component.event.value;
  let eventRuleId: string;
  if (CompatibilityPolicyRegistry.hookEvents.supported.includes(event as never)) {
    eventRuleId = CompatibilityPolicyRegistry.hookHandlers.supportedEvent.id;
  } else if (CompatibilityPolicyRegistry.hookEvents.subagent.includes(event as never)) {
    eventRuleId = CompatibilityPolicyRegistry.hookHandlers.subagentEvent.id;
  } else if (CompatibilityPolicyRegistry.hookEvents.incompatible.includes(event as never)) {
    eventRuleId = CompatibilityPolicyRegistry.hookHandlers.incompatibleEvent.id;
  } else {
    eventRuleId = CompatibilityPolicyRegistry.hookHandlers.unknownEvent.id;
  }

  if (eventRuleId === CompatibilityPolicyRegistry.hookHandlers.incompatibleEvent.id ||
      eventRuleId === CompatibilityPolicyRegistry.hookHandlers.unknownEvent.id) {
    verdict = worstOutcome(verdict, eventRuleId);
    diagnostics.push(diagnostic(pluginKey, eventRuleId, ruleSeverity(eventRuleId), component.event.provenance, {
      componentId: component.id,
      field: "event",
      ...(eventRuleId === CompatibilityPolicyRegistry.hookHandlers.unknownEvent.id ? {} : { value: event }),
    }));
  } else {
    requirements.push(...requirementUse(eventRuleId, component.event.provenance));
  }

  if (verdict === "supported" && (eventRuleId === CompatibilityPolicyRegistry.hookHandlers.supportedEvent.id ||
      eventRuleId === CompatibilityPolicyRegistry.hookHandlers.subagentEvent.id)) {
    const selector = compileHookSelector(component);
    if (selector.kind === "incompatible") {
      verdict = worstOutcome(verdict, CompatibilityPolicyRegistry.hookHandlers.unknownEvent.id);
      const source = selector.field === "matcher"
        ? component.matcher?.provenance ?? component.event.provenance
        : component.metadata.find((metadata) => metadata.key.endsWith(".if") || metadata.key.endsWith(".conditions"))?.claimed.provenance ?? component.event.provenance;
      diagnostics.push(diagnostic(pluginKey, CompatibilityPolicyRegistry.hookHandlers.unknownEvent.id, ruleSeverity(CompatibilityPolicyRegistry.hookHandlers.unknownEvent.id), source, {
        componentId: component.id,
        field: selector.field,
      }));
    }
  }

  const commandRule = CompatibilityPolicyRegistry.hookHandlers.command;
  requirements.push(...requirementUse(commandRule.id, component.handler.provenance));

  let shellRuleId: string | undefined = component.handler.value.kind === "shell"
    ? (component.handler.value.shell === "powershell"
      ? CompatibilityPolicyRegistry.hookHandlers.shellPowershell.id
      : CompatibilityPolicyRegistry.hookHandlers.shellBash.id)
    : undefined;
  let shellProvenance = component.handler.provenance;

  for (const metadata of [...component.metadata].sort((left, right) => compareText(left.key, right.key))) {
    const field = metadataField(metadata);
    const provenance = metadataProvenance(metadata);
    const value = metadata.claimed.value;

    if (!hasMetadataNamespace(metadata.key, CompatibilityPolicyRegistry.hookEvents.metadata.prefixes)) {
      verdict = worstOutcome(verdict, CompatibilityPolicyRegistry.hookHandlers.unknownEvent.id);
      diagnostics.push(diagnostic(pluginKey, CompatibilityPolicyRegistry.hookHandlers.unknownEvent.id, ruleSeverity(CompatibilityPolicyRegistry.hookHandlers.unknownEvent.id), provenance, {
        componentId: component.id,
        field,
      }));
      continue;
    }
    if (CompatibilityPolicyRegistry.hookEvents.metadata.statusMessage.includes(field as never)) {
      if (typeof value !== "string") {
        verdict = worstOutcome(verdict, CompatibilityPolicyRegistry.hookHandlers.unknownEvent.id);
        diagnostics.push(diagnostic(pluginKey, CompatibilityPolicyRegistry.hookHandlers.unknownEvent.id, ruleSeverity(CompatibilityPolicyRegistry.hookHandlers.unknownEvent.id), provenance, {
          componentId: component.id,
          field,
        }));
      } else {
        diagnostics.push(diagnostic(pluginKey, CompatibilityPolicyRegistry.hookHandlers.statusMessage.id, "warning", provenance, {
          componentId: component.id,
          field,
        }));
      }
      continue;
    }
    if (CompatibilityPolicyRegistry.hookEvents.metadata.shell.includes(field as never)) {
      if (value !== "bash" && value !== "powershell") {
        verdict = worstOutcome(verdict, CompatibilityPolicyRegistry.hookHandlers.unknownEvent.id);
        const safeValue = value === "bash" || value === "powershell" ? value : undefined;
        diagnostics.push(diagnostic(pluginKey, CompatibilityPolicyRegistry.hookHandlers.unknownEvent.id, ruleSeverity(CompatibilityPolicyRegistry.hookHandlers.unknownEvent.id), provenance, {
          componentId: component.id,
          field,
          ...(safeValue === undefined ? {} : { value: safeValue }),
        }));
      } else {
        shellRuleId = value === "powershell"
          ? CompatibilityPolicyRegistry.hookHandlers.shellPowershell.id
          : CompatibilityPolicyRegistry.hookHandlers.shellBash.id;
        shellProvenance = provenance;
      }
      continue;
    }
    if (CompatibilityPolicyRegistry.hookEvents.metadata.async.includes(field as never)) {
      if (typeof value !== "boolean" || value === true) {
        verdict = worstOutcome(verdict, CompatibilityPolicyRegistry.hookHandlers.async.id);
        diagnostics.push(diagnostic(pluginKey, CompatibilityPolicyRegistry.hookHandlers.async.id, ruleSeverity(CompatibilityPolicyRegistry.hookHandlers.async.id), provenance, {
          componentId: component.id,
          field,
        }));
      }
      continue;
    }
    if (CompatibilityPolicyRegistry.hookEvents.metadata.ifRule.includes(field as never)) {
      // The shared selector compiler above is the compatibility/runtime contract.
      continue;
    }

    verdict = worstOutcome(verdict, CompatibilityPolicyRegistry.hookHandlers.unknownEvent.id);
    diagnostics.push(diagnostic(pluginKey, CompatibilityPolicyRegistry.hookHandlers.unknownEvent.id, ruleSeverity(CompatibilityPolicyRegistry.hookHandlers.unknownEvent.id), provenance, {
      componentId: component.id,
      field,
    }));
  }

  if (shellRuleId !== undefined) requirements.push(...requirementUse(shellRuleId, shellProvenance));
  return decision(verdict, requirements, diagnostics);
}

function evaluateMcp(
  pluginKey: string,
  component: McpServerComponent,
): PolicyDecision {
  const analysis = analyzeMcpCompatibility({
    plugin: PluginKeySchema.parse(pluginKey),
    component,
  });
  if (analysis.kind === "incompatible" || analysis.kind === "metadata-only") {
    return decision(analysis.kind, [], analysis.diagnostics);
  }
  return decision("supported", analysis.requirementUses.map((use) => ({
    capability: use.capability,
    provenance: use.provenance.map((location) => ProvenanceSchema.parse({ location })),
    ruleId: use.ruleId,
  })), []);
}

function evaluateForeign(
  pluginKey: string,
  component: ForeignComponent,
): PolicyDecision {
  const provenances = sortedProvenance([
    ...component.nativeKind.provenance,
    ...component.declaration.provenance,
  ]);
  const ruleId = component.nativeKind.value === "hook-handler"
    ? CompatibilityPolicyRegistry.hookHandlers.unsupportedHandler.id
    : component.nativeKind.value === "pi-extension"
      ? CompatibilityPolicyRegistry.foreign.piExtension.id
      : CompatibilityPolicyRegistry.foreign.defaultDeny.id;
  // Foreign components are never executed by this host, so their policy
  // outcome is the rule's disposition: retained and skipped, or blocked.
  return decision(ruleOutcome(ruleId), [], [diagnostic(pluginKey, ruleId, ruleSeverity(ruleId), provenances, {
    componentId: component.id,
    nativeHost: component.nativeHost,
    nativeKind: component.nativeKind.value,
  })]);
}

function evaluateComponent(pluginKey: string, component: Component): PolicyDecision {
  switch (component.kind) {
    case ComponentKindRegistry.skill.tag:
      return evaluateSkill(pluginKey, component);
    case ComponentKindRegistry.hook.tag:
      return evaluateHook(pluginKey, component);
    case ComponentKindRegistry.mcpServer.tag:
      return evaluateMcp(pluginKey, component);
    case ComponentKindRegistry.foreign.tag:
      return evaluateForeign(pluginKey, component);
    default:
      return assertNever(component);
  }
}

function requirementId(componentId: string, capability: RuntimeCapabilityId): RuntimeRequirementId {
  return RuntimeRequirementIdSchema.parse(`${REQUIREMENT_ID_PREFIX}:${capability}:${componentId}`);
}

function createRequirementAssessment(
  component: Component,
  use: RequirementUse,
  capabilities: RuntimeCapabilitySnapshot,
): RuntimeRequirementAssessment {
  const capability = capabilities.capabilities[use.capability];
  if (capability === undefined) throw new Error(`missing validated capability ${use.capability}`);
  const capabilityEntry = Object.values(RuntimeCapabilityRegistry).find((candidate) => candidate.id === use.capability);
  if (capabilityEntry === undefined) throw new Error(`capability registry is missing ${use.capability}`);
  const id = requirementId(component.id, use.capability);
  return RuntimeRequirementAssessmentSchema.parse({
    requirement: RuntimeRequirementSchema.parse({
      id,
      capability: use.capability,
      description: capabilityEntry.description,
      // Claims carry raw declarations for ingestion and reconciliation. A
      // compatibility report is an inspection boundary, so it retains exact
      // source locations but never serializes those declarations.
      provenance: sortedProvenance(use.provenance).map((provenance) =>
        ProvenanceSchema.parse({ location: provenance.location }),
      ),
    }),
    status: capability.status,
    // Adapter explanations are runtime-owned text and may contain paths,
    // environment values, timestamps, or native errors. Reports use the
    // registry description plus the status vocabulary instead.
    explanation: `${capabilityEntry.description} (${capability.status})`,
  });
}

function unavailableRequirementDiagnostic(
  pluginKey: string,
  component: Component,
  requirement: RuntimeRequirementAssessment,
  ruleId: string,
): Diagnostic {
  const capability = requirement.requirement.capability;
  return diagnostic(pluginKey, CompatibilityPolicyRegistry.mcp.defaultDeny.id, "error", requirement.requirement.provenance, {
    componentId: component.id,
    requirementId: requirement.requirement.id,
    capability,
    policyRuleId: ruleId,
  }, `${capability} is unavailable for this supported component`, ErrorCodeRegistry.requirementUnavailable);
}

function configurationDetails(option: ConfigurationOption): JsonValue {
  const value = option.value;
  const details: Record<string, JsonValue> = {
    key: option.key,
    kind: value.kind,
    required: option.required,
    sensitive: option.sensitive,
    hasDefault: Object.prototype.hasOwnProperty.call(value, "default"),
  };
  if (value.kind === "directory" || value.kind === "file") {
    details.pathConstraint = { mustExist: value.mustExist };
  } else if (value.kind === "number") {
    details.bounds = {
      ...(value.min === undefined ? {} : { min: value.min }),
      ...(value.max === undefined ? {} : { max: value.max }),
    };
  } else if (value.kind === "strings") {
    details.bounds = {
      ...(value.minItems === undefined ? {} : { minItems: value.minItems }),
      ...(value.maxItems === undefined ? {} : { maxItems: value.maxItems }),
    };
  } else if (value.kind === "string" && value.pattern !== undefined) {
    details.hasPatternConstraint = true;
  }
  return details;
}

function evaluateConfiguration(pluginKey: string, plugin: NormalizedPlugin): readonly Diagnostic[] {
  const configuration = PluginConfigurationSchema.parse(plugin.configuration);
  const diagnostics: Diagnostic[] = [];
  for (const option of [...configuration.options].sort((left, right) => compareText(left.key, right.key))) {
    const provenance = sortedProvenance(option.provenance);
    const details = configurationDetails(option) as Record<string, JsonValue>;
    diagnostics.push(diagnostic(pluginKey, CompatibilityPolicyRegistry.configuration.descriptor.id, "warning", provenance, details));
    const hasDefault = Boolean(details.hasDefault);
    if (option.required && !hasDefault) {
      diagnostics.push(diagnostic(pluginKey, CompatibilityPolicyRegistry.configuration.requiredInput.id, "warning", provenance, {
        key: option.key,
        required: true,
        hasDefault: false,
      }));
    }
    if (option.sensitive) {
      diagnostics.push(diagnostic(pluginKey, CompatibilityPolicyRegistry.configuration.sensitive.id, "warning", provenance, {
        key: option.key,
        sensitive: true,
      }));
    }
  }
  return diagnostics;
}

function evaluateMarketplacePolicy(
  pluginKey: string,
  policy: MarketplaceInstallationPolicy | undefined,
): readonly Diagnostic[] {
  if (policy === undefined) return [];
  const diagnostics: Diagnostic[] = [];
  const availabilityRule = {
    available: CompatibilityPolicyRegistry.marketplace.availabilityAvailable.id,
    "installed-by-default": CompatibilityPolicyRegistry.marketplace.availabilityInstalledByDefault.id,
    "not-available": CompatibilityPolicyRegistry.marketplace.availabilityNotAvailable.id,
  }[policy.availability.value];
  diagnostics.push(diagnostic(pluginKey, availabilityRule, "warning", policy.availability.provenance, {
    availability: policy.availability.value,
    advisoryOnly: true,
  }));
  if (policy.authentication !== undefined) {
    diagnostics.push(diagnostic(pluginKey, CompatibilityPolicyRegistry.marketplace.policy.id, "warning", policy.authentication.provenance, {
      hasAuthenticationPolicy: true,
      advisoryOnly: true,
    }));
  }
  return diagnostics;
}

function normalizedReportIdentity(plugin: NormalizedPlugin): NormalizedPlugin["identity"] {
  const identity = plugin.identity;
  return {
    key: identity.key,
    marketplaceName: identity.marketplaceName,
    marketplaceEntryName: identity.marketplaceEntryName,
    ...(identity.manifestName === undefined ? {} : { manifestName: identity.manifestName }),
  };
}

function pluginMetadataDiagnostics(pluginKey: string, plugin: NormalizedPlugin): readonly Diagnostic[] {
  const known = new Set<string>(CompatibilityPolicyRegistry.metadata.knownPluginPresentationKeys);
  return [...plugin.metadata]
    .sort((left, right) => compareText(left.key, right.key))
    .map((metadata) => diagnostic(
      pluginKey,
      known.has(metadata.key)
        ? CompatibilityPolicyRegistry.report.knownPresentation.id
        : CompatibilityPolicyRegistry.skills.presentation.id,
      "warning",
      metadata.claimed.provenance,
      {
        field: metadata.key,
        knownPresentation: known.has(metadata.key),
        advisoryOnly: true,
      },
    ));
}

function assertCompleteAssessment(
  components: readonly Component[],
  assessments: readonly ComponentAssessment[],
): void {
  if (components.length !== assessments.length) {
    throw new Error(`compatibility evaluator emitted ${assessments.length} assessments for ${components.length} components`);
  }
  const expected = new Set(components.map((component) => component.id));
  const actual = new Set<string>();
  for (const assessment of assessments) {
    if (!expected.has(assessment.componentId)) throw new Error(`assessment has unknown component id ${assessment.componentId}`);
    if (actual.has(assessment.componentId)) throw new Error(`duplicate compatibility assessment ${assessment.componentId}`);
    actual.add(assessment.componentId);
  }
  if (actual.size !== expected.size) throw new Error("compatibility evaluator omitted a component assessment");
}

/**
 * Evaluate a complete normalized bundle using only policy data and a complete
 * capability snapshot. No runtime adapter, process, filesystem, or network
 * operation is reachable from this function.
 */
export function evaluateCompatibility(input: CompatibilityEvaluationInput): CompatibilityReport {
  const valid = CompatibilityEvaluationInputSchema.parse(input);
  const plugin = valid.plugin;
  const pluginKey = plugin.identity.key;
  const components = [...flattenComponents(plugin.components)].sort((left, right) => {
    const rank = componentKindRank(left.kind) - componentKindRank(right.kind);
    return rank !== 0 ? rank : compareText(left.id, right.id);
  });

  const decisions = components.map((component) => ({
    component,
    decision: evaluateComponent(pluginKey, ComponentSchema.parse(component)),
  }));
  const assessments = decisions.map(({ component, decision: componentDecision }) =>
    ComponentAssessmentSchema.parse({
      componentId: component.id,
      verdict: componentDecision.verdict === "supported"
        ? { kind: ComponentVerdictRegistry.supported.tag }
        : componentDecision.verdict === "metadata-only"
          ? {
            kind: ComponentVerdictRegistry.metadataOnly.tag,
            reason: componentDecision.diagnostics[0]?.message ?? "Declaration is retained as metadata only",
          }
          : { kind: ComponentVerdictRegistry.incompatible.tag, reason: componentDecision.diagnostics[0]?.message ?? "Unsupported declaration" },
      requirementIds: [],
      diagnostics: componentDecision.diagnostics,
    }),
  );

  const requirements: RuntimeRequirementAssessment[] = [];
  const requirementUsesByComponent = new Map<string, readonly RequirementUse[]>();
  const requirementsByComponent = new Map<string, string[]>();
  for (const { component, decision: componentDecision } of decisions) {
    if (componentDecision.verdict !== "supported") continue;
    const uses = mergeRequirementUses(componentDecision.requirements);
    requirementUsesByComponent.set(component.id, uses);
    const componentRequirementIds = requirementsByComponent.get(component.id) ?? [];
    for (const use of uses) {
      const assessment = createRequirementAssessment(component, use, valid.capabilities);
      requirements.push(assessment);
      componentRequirementIds.push(assessment.requirement.id);
    }
    requirementsByComponent.set(component.id, componentRequirementIds);
  }
  const finalAssessments = assessments.map((assessment) => ComponentAssessmentSchema.parse({
    ...assessment,
    requirementIds: requirementsByComponent.get(assessment.componentId) ?? [],
  }));
  assertCompleteAssessment(components, finalAssessments);

  const sortedRequirements = [...requirements].sort((left, right) => {
    const leftComponent = components.find((component) => left.requirement.id.endsWith(`:${component.id}`));
    const rightComponent = components.find((component) => right.requirement.id.endsWith(`:${component.id}`));
    const leftComponentId = leftComponent?.id ?? "";
    const rightComponentId = rightComponent?.id ?? "";
    const kindRank = (leftComponent === undefined ? Number.MAX_SAFE_INTEGER : componentKindRank(leftComponent.kind)) -
      (rightComponent === undefined ? Number.MAX_SAFE_INTEGER : componentKindRank(rightComponent.kind));
    if (kindRank !== 0) return kindRank;
    if (leftComponentId !== rightComponentId) return compareText(leftComponentId, rightComponentId);
    const capabilityOrder = capabilityRank(left.requirement.capability) - capabilityRank(right.requirement.capability);
    return capabilityOrder !== 0 ? capabilityOrder : compareText(left.requirement.id, right.requirement.id);
  });
  const reportDiagnostics: Diagnostic[] = [];
  for (const { component } of decisions) {
    for (const requirement of sortedRequirements) {
      if (requirement.status !== RuntimeRequirementStatusRegistry.unavailable.tag) continue;
      if (!requirement.requirement.id.endsWith(`:${component.id}`)) continue;
      const use = requirementUsesByComponent.get(component.id)?.find((candidate) => candidate.capability === requirement.requirement.capability);
      reportDiagnostics.push(unavailableRequirementDiagnostic(pluginKey, component, requirement, use?.ruleId ?? CompatibilityPolicyRegistry.mcp.defaultDeny.id));
    }
  }
  reportDiagnostics.push(...evaluateConfiguration(pluginKey, plugin));
  reportDiagnostics.push(...evaluateMarketplacePolicy(pluginKey, valid.marketplacePolicy));
  reportDiagnostics.push(...pluginMetadataDiagnostics(pluginKey, plugin));
  reportDiagnostics.sort(compareDiagnostics);

  const activatable = deriveActivatable({
    components: finalAssessments,
    requirements: sortedRequirements,
  });
  // This factory is intentionally the final gate. The evaluator never writes
  // or independently validates a second activatability algorithm.
  return createCompatibilityReport({
    plugin: normalizedReportIdentity(plugin),
    activatable,
    components: finalAssessments,
    requirements: sortedRequirements,
    diagnostics: reportDiagnostics,
  });
}

function assertNever(value: never): never {
  throw new Error(`Unhandled compatibility component: ${String(value)}`);
}
