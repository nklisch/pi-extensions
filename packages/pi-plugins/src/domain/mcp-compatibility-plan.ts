import { z } from "zod";
import { canonicalJson, compareUtf8 } from "./canonical-json.js";
import {
  canonicalSourceLocations,
  compareSourceLocationsUtf8,
} from "./canonical-order.js";
import {
  ComponentIdSchema,
  McpServerComponentSchema,
  type McpServerComponent,
} from "./components.js";
import {
  CompatibilityPolicyRegistry,
  CompatibilityPolicyRuleRegistry,
  RuntimeCapabilityIdSchema,
  RuntimeCapabilityRegistry,
  type RuntimeCapabilityId,
} from "./compatibility-policy.js";
import {
  DiagnosticSchema,
  ErrorCodeRegistry,
  type Diagnostic,
} from "./errors.js";
import { PluginKeySchema, type PluginKey } from "./identity.js";
import { analyzeMcpEndpoint, type McpEndpointAnalysis } from "./mcp-endpoint-security.js";
import {
  isPortableMcpHeaderCredential,
  isPortableMcpValueReference,
} from "./mcp-late-values.js";
import { SourceLocationSchema, type SourceLocation } from "./provenance-location.js";
import { ProvenanceSchema, type Provenance } from "./provenance.js";
import { JsonValueSchema, type JsonValue } from "./schema.js";
import { isSensitiveFieldName, isSensitiveQueryName } from "./sensitive-fields.js";

export const McpCanonicalTransportSchema = z.enum(["stdio", "streamable-http"]);
export type McpCanonicalTransport = z.infer<typeof McpCanonicalTransportSchema>;

export const McpCanonicalAuthSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("none") }).strict().readonly(),
  z.object({ kind: z.literal("bearer-environment") }).strict().readonly(),
  z.object({
    kind: z.literal("oauth"),
    flow: z.enum(["authorization-code", "client-credentials"]),
  }).strict().readonly(),
]);
export type McpCanonicalAuth = z.infer<typeof McpCanonicalAuthSchema>;

export const McpCanonicalOptionsSchemaV1 = z.object({
  schemaVersion: z.literal(1),
  startupTimeoutMs: z.number().positive().optional(),
  toolTimeoutMs: z.number().positive().optional(),
  allowedTools: z.array(z.string()).readonly().optional(),
  deniedTools: z.array(z.string()).readonly().optional(),
  instructions: z.string().optional(),
  resources: z.union([z.boolean(), z.array(z.string()).readonly()]).optional(),
  toolApproval: z.boolean().optional(),
  sampling: z.boolean().optional(),
  elicitation: z.object({
    form: z.boolean(),
    url: z.boolean(),
  }).strict().readonly().optional(),
  auth: McpCanonicalAuthSchema,
}).strict().readonly();
export type McpCanonicalOptions = z.infer<typeof McpCanonicalOptionsSchemaV1>;

export const McpCompatibilityPlanSchemaV1 = z.object({
  schemaVersion: z.literal(1),
  componentId: ComponentIdSchema,
  transport: McpCanonicalTransportSchema,
  options: McpCanonicalOptionsSchemaV1,
  requirementCapabilityIds: z.array(RuntimeCapabilityIdSchema).readonly(),
  provenance: z.array(SourceLocationSchema).nonempty().readonly(),
}).strict().readonly();
export type McpCompatibilityPlan = z.infer<typeof McpCompatibilityPlanSchemaV1>;

export type McpCompatibilityRequirementUse = Readonly<{
  capability: RuntimeCapabilityId;
  ruleId: string;
  provenance: readonly [SourceLocation, ...SourceLocation[]];
}>;

export type McpCompatibilityAnalysis =
  | Readonly<{
      kind: "supported";
      plan: McpCompatibilityPlan;
      requirementUses: readonly McpCompatibilityRequirementUse[];
    }>
  | Readonly<{ kind: "metadata-only"; diagnostics: readonly Diagnostic[] }>
  | Readonly<{ kind: "incompatible"; diagnostics: readonly Diagnostic[] }>;

/**
 * A diagnostic blocks activation only when its policy rule is dispositioned
 * incompatible. Metadata-only rules degrade the server: it stays in the
 * compatibility evidence and is skipped at runtime projection.
 */
function diagnosticBlocksActivation(diagnostic: Diagnostic): boolean {
  const details = diagnostic.details;
  const ruleId = details !== null && typeof details === "object" && !Array.isArray(details)
    ? (details as Readonly<Record<string, JsonValue>>)["ruleId"]
    : undefined;
  // An untagged diagnostic predates disposition-aware rules; fail closed.
  if (typeof ruleId !== "string") return true;
  const rule = CompatibilityPolicyRuleRegistry[ruleId];
  if (rule === undefined) throw new Error(`compatibility policy registry is missing rule ${ruleId}`);
  return rule.disposition === "incompatible";
}

function downgradeToWarnings(diagnostics: readonly Diagnostic[]): readonly Diagnostic[] {
  return diagnostics.map((entry) =>
    entry.severity === "warning" ? entry : DiagnosticSchema.parse({ ...entry, severity: "warning" }));
}

type JsonRecord = Readonly<Record<string, JsonValue>>;
type OAuthFlow = "authorization-code" | "client-credentials";
type AuthMode = "none" | "bearer" | "oauth";
type AnyMcpTransport = "stdio" | "streamable-http" | "sse" | "websocket";
type FieldGroup = Readonly<{
  target: string;
  aliases: readonly string[];
  unit: string;
  collision: "canonical-equality" | "exact-equality" | "set-equality" | "coherent-single-mode" | "reject-duplicates";
  transports: readonly AnyMcpTransport[];
  externalBearerAlias?: string;
}>;
type FieldClaim = Readonly<{ field: string; value: JsonValue }>;
type RuleClaim = Readonly<{ ruleId: string; provenance: readonly Provenance[] }>;

const OPERATION = "evaluateCompatibility";

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function fieldGroup(name: keyof typeof CompatibilityPolicyRegistry.mcp.keys.fieldGroups): FieldGroup {
  return CompatibilityPolicyRegistry.mcp.keys.fieldGroups[name] as FieldGroup;
}

function pointerSegment(value: string): string {
  return value.replaceAll("~", "~0").replaceAll("/", "~1");
}

function fieldProvenance(component: McpServerComponent, field: string): readonly Provenance[] {
  if (field === "declaration") return component.declaration.provenance;
  return component.declaration.provenance.map((provenance) => {
    const base = provenance.location.pointer ?? "";
    return ProvenanceSchema.parse({
      location: {
        ...provenance.location,
        pointer: `${base}/${field.split(".").map(pointerSegment).join("/")}`,
      },
    });
  });
}

export const compareMcpSourceLocations = compareSourceLocationsUtf8;

export function canonicalMcpSourceLocations(
  component: McpServerComponent,
): readonly [SourceLocation, ...SourceLocation[]] {
  const locations = canonicalSourceLocations([
    ...component.nativeKey.provenance.map((provenance) => provenance.location),
    ...component.declaration.provenance.map((provenance) => provenance.location),
  ]);
  if (locations.length === 0) throw new Error("MCP compatibility provenance cannot be empty");
  return locations as [SourceLocation, ...SourceLocation[]];
}

function canonicalLocationsFromProvenance(
  provenance: readonly Provenance[],
): readonly [SourceLocation, ...SourceLocation[]] {
  const locations = canonicalSourceLocations(provenance.map((entry) => entry.location));
  if (locations.length === 0) throw new Error("MCP requirement provenance cannot be empty");
  return locations as [SourceLocation, ...SourceLocation[]];
}

function diagnosticLocations(provenance: readonly Provenance[]): JsonValue {
  return canonicalLocationsFromProvenance(provenance) as unknown as JsonValue;
}

function canonicalTransport(value: string): AnyMcpTransport | undefined {
  const keys = CompatibilityPolicyRegistry.mcp.keys;
  if ((keys.transportValues as readonly string[]).includes(value)) return value as AnyMcpTransport;
  const alias = (keys.transportAliases as Readonly<Record<string, AnyMcpTransport>>)[value];
  return alias !== undefined && (keys.transportValues as readonly string[]).includes(alias)
    ? alias
    : undefined;
}

function safeScalar(field: string, value: JsonValue | undefined): JsonValue | undefined {
  if (typeof value !== "string") return undefined;
  if (fieldGroup("transport").aliases.includes(field)) {
    return canonicalTransport(value) === undefined ? undefined : value;
  }
  if (fieldGroup("authentication").aliases.includes(field) &&
      ["none", "bearer", "bearer-env", "oauth"].includes(value)) return value;
  return undefined;
}

function issue(
  plugin: PluginKey,
  component: McpServerComponent,
  field: string,
  value?: JsonValue,
  ruleId: string = CompatibilityPolicyRegistry.mcp.defaultDeny.id,
): Diagnostic {
  const rule = CompatibilityPolicyRuleRegistry[ruleId];
  if (rule === undefined) throw new Error(`compatibility policy registry is missing rule ${ruleId}`);
  const provenance = fieldProvenance(component, field);
  const safeValue = safeScalar(field, value);
  return DiagnosticSchema.parse({
    code: rule.diagnosticCode ?? ErrorCodeRegistry.unsupportedDeclaration,
    severity: "error",
    operation: OPERATION,
    message: rule.message,
    location: canonicalLocationsFromProvenance(provenance)[0],
    plugin,
    details: {
      componentId: component.id,
      field,
      ...(safeValue === undefined ? {} : { value: safeValue }),
      ruleId,
      sourceLocations: diagnosticLocations(provenance),
    },
  });
}

function compareDiagnostics(left: Diagnostic, right: Diagnostic): number {
  const severity = left.severity === right.severity ? 0 : left.severity === "error" ? -1 : 1;
  if (severity !== 0) return severity;
  const code = compareUtf8(left.code, right.code);
  if (code !== 0) return code;
  if (left.location === undefined || right.location === undefined) {
    if (left.location !== right.location) return left.location === undefined ? -1 : 1;
  } else {
    const location = compareSourceLocationsUtf8(left.location, right.location);
    if (location !== 0) return location;
  }
  return compareUtf8(canonicalJson(left.details ?? null), canonicalJson(right.details ?? null));
}

function capabilityRank(id: RuntimeCapabilityId): number {
  return Object.values(RuntimeCapabilityRegistry).find((entry) => entry.id === id)?.rank ?? Number.MAX_SAFE_INTEGER;
}

function requirementUses(claims: readonly RuleClaim[]): readonly McpCompatibilityRequirementUse[] {
  const byCapability = new Map<RuntimeCapabilityId, {
    ruleId: string;
    provenance: SourceLocation[];
  }>();
  for (const claim of claims) {
    const rule = CompatibilityPolicyRuleRegistry[claim.ruleId];
    if (rule === undefined) throw new Error(`compatibility policy registry is missing rule ${claim.ruleId}`);
    for (const capability of rule.requirementCapabilityIds) {
      const existing = byCapability.get(capability);
      const locations = canonicalLocationsFromProvenance(claim.provenance);
      if (existing === undefined) {
        byCapability.set(capability, { ruleId: claim.ruleId, provenance: [...locations] });
      } else {
        existing.provenance.push(...locations);
        if (compareUtf8(claim.ruleId, existing.ruleId) < 0) existing.ruleId = claim.ruleId;
      }
    }
  }
  return [...byCapability].sort(([left], [right]) => {
    const rank = capabilityRank(left) - capabilityRank(right);
    return rank !== 0 ? rank : compareUtf8(left, right);
  }).map(([capability, value]) => {
    const provenance = canonicalSourceLocations(value.provenance);
    return {
      capability,
      ruleId: value.ruleId,
      provenance: provenance as [SourceLocation, ...SourceLocation[]],
    };
  });
}

function valueAtPath(declaration: JsonRecord, path: string): JsonValue | undefined {
  const segments = path.split(".");
  let current: JsonValue = declaration;
  for (const segment of segments) {
    if (!isRecord(current) || !Object.prototype.hasOwnProperty.call(current, segment)) return undefined;
    current = current[segment]!;
  }
  return current;
}

function claimsFor(declaration: JsonRecord, group: FieldGroup): readonly FieldClaim[] {
  return group.aliases.flatMap((field) => {
    const value = valueAtPath(declaration, field);
    return value === undefined ? [] : [{ field, value }];
  });
}

function exactStringSet(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort(compareUtf8);
}

function equalJson(left: JsonValue, right: JsonValue): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function resolveGroup<T extends JsonValue>(
  declaration: JsonRecord,
  group: FieldGroup,
  parse: (value: JsonValue) => T | undefined,
): Readonly<{ value?: T; conflicts: readonly string[]; invalid: readonly string[]; claims: readonly FieldClaim[] }> {
  const claims = claimsFor(declaration, group);
  const parsed = claims.map((claim) => ({ ...claim, parsed: parse(claim.value) }));
  const invalid = parsed.filter((entry) => entry.parsed === undefined).map((entry) => entry.field);
  const valid = parsed.filter((entry): entry is FieldClaim & { parsed: T } => entry.parsed !== undefined);
  const first = valid[0]?.parsed;
  const conflicts = group.collision === "reject-duplicates"
    ? valid.slice(1).map((entry) => entry.field)
    : first === undefined
      ? []
      : valid.filter((entry) => !equalJson(entry.parsed, first)).map((entry) => entry.field);
  return {
    ...(first === undefined ? {} : { value: first }),
    conflicts,
    invalid,
    claims,
  };
}

/** Resolve registry-owned aliases once so policy and projection cannot drift. */
export function resolveMcpFieldGroup<T extends JsonValue>(
  declaration: Readonly<Record<string, JsonValue>>,
  name: keyof typeof CompatibilityPolicyRegistry.mcp.keys.fieldGroups,
  parse: (value: JsonValue) => T | undefined,
): Readonly<{
  value?: T;
  conflicts: readonly string[];
  invalid: readonly string[];
  claims: readonly Readonly<{ field: string; value: JsonValue }>[];
}> {
  return resolveGroup(declaration, fieldGroup(name), parse);
}

function stringArray(value: JsonValue): value is readonly string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

const PORTABLE_ENVIRONMENT_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const HTTP_HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

function invalidEnvironmentFields(value: JsonValue): readonly string[] {
  if (!isRecord(value)) return [""];
  return Object.entries(value)
    .filter(([name, entry]) => !PORTABLE_ENVIRONMENT_NAME.test(name) || typeof entry !== "string" ||
      (isSensitiveFieldName(name) && !isPortableMcpValueReference(entry)))
    .map(([name]) => name)
    .sort(compareUtf8);
}

function parseString(value: JsonValue): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function parseNonEmptyString(value: JsonValue): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function parsePositiveNumber(value: JsonValue): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function parseToolList(value: JsonValue): readonly string[] | undefined {
  return stringArray(value) ? exactStringSet(value) : undefined;
}

function setOption(options: Record<string, JsonValue>, group: FieldGroup, value: JsonValue): void {
  if (!group.target.startsWith("options.")) {
    throw new Error(`MCP field target ${group.target} is not a canonical option`);
  }
  const key = group.target.slice("options.".length);
  if (key.length === 0 || key.includes(".")) throw new Error(`unsupported MCP option target ${group.target}`);
  options[key] = value;
}

function rootField(path: string): string {
  return path.split(".")[0]!;
}

function knownTopLevelKeys(): ReadonlySet<string> {
  return new Set(Object.values(CompatibilityPolicyRegistry.mcp.keys.fieldGroups)
    .flatMap((group) => (group as FieldGroup).aliases.map(rootField)));
}

function nestedAliases(root: string): ReadonlySet<string> {
  return new Set(Object.values(CompatibilityPolicyRegistry.mcp.keys.fieldGroups)
    .flatMap((group) => (group as FieldGroup).aliases)
    .filter((field) => field.startsWith(`${root}.`))
    .map((field) => field.slice(root.length + 1)));
}

function fieldAllowedForTransport(field: string, transport: AnyMcpTransport): boolean {
  return Object.values(CompatibilityPolicyRegistry.mcp.keys.fieldGroups).some((candidate) => {
    const group = candidate as FieldGroup;
    return group.transports.includes(transport) && group.aliases.some((alias) => rootField(alias) === field);
  });
}

function validateNestedContainer(
  plugin: PluginKey,
  component: McpServerComponent,
  declaration: JsonRecord,
  root: "tools" | "features",
  diagnostics: Diagnostic[],
): void {
  const value = declaration[root];
  if (value === undefined) return;
  if (root === "tools" && stringArray(value)) return;
  if (!isRecord(value)) {
    diagnostics.push(issue(plugin, component, root));
    return;
  }
  const known = nestedAliases(root);
  for (const key of Object.keys(value)) {
    if (!known.has(key)) diagnostics.push(issue(plugin, component, `${root}.${key}`));
  }
}

function invalidHeaderFields(value: JsonValue): readonly string[] {
  if (!isRecord(value)) return [""];
  const invalid: string[] = [];
  const seen = new Set<string>();
  const allowed = CompatibilityPolicyRegistry.mcp.keys.headerEnvironmentKeys as readonly string[];
  for (const [name, entry] of Object.entries(value)) {
    const canonicalName = name.toLowerCase();
    if (!HTTP_HEADER_NAME.test(name) || seen.has(canonicalName)) {
      invalid.push(name);
      continue;
    }
    seen.add(canonicalName);
    if (typeof entry === "string") {
      if (entry.length === 0 || isSensitiveFieldName(name) &&
          !isPortableMcpHeaderCredential(name, entry)) {
        invalid.push(name);
      }
    } else if (!isRecord(entry) || Object.keys(entry).length !== allowed.length ||
      Object.keys(entry).some((key) => !allowed.includes(key)) ||
      typeof entry.env !== "string" || !PORTABLE_ENVIRONMENT_NAME.test(entry.env)) {
      invalid.push(name);
    }
  }
  return invalid.sort(compareUtf8);
}

function recognizedFlow(value: string): Readonly<{ flow: OAuthFlow; ruleId: string }> | undefined {
  for (const definition of Object.values(CompatibilityPolicyRegistry.mcp.keys.oauthFlowDefinitions)) {
    if ((definition.aliases as readonly string[]).includes(value)) {
      return {
        flow: definition.ruleId === CompatibilityPolicyRegistry.mcp.oauthAuthorizationCode.id
          ? "authorization-code"
          : "client-credentials",
        ruleId: definition.ruleId,
      };
    }
  }
  return undefined;
}

function recognizedAuthMode(value: string): AuthMode | undefined {
  for (const [mode, definition] of Object.entries(CompatibilityPolicyRegistry.mcp.keys.authSelectorDefinitions.modes)) {
    if ((definition.aliases as readonly string[]).includes(value)) return mode as AuthMode;
  }
  return undefined;
}

type ParsedAuth = Readonly<{ auth: McpCanonicalAuth; ruleId?: string }>;

function parseAuth(value: JsonValue, externalBearer?: string): ParsedAuth | undefined {
  const definitions = CompatibilityPolicyRegistry.mcp.keys.authSelectorDefinitions;
  if (typeof value === "string") {
    const mode = recognizedAuthMode(value);
    if (mode === "none") return externalBearer === undefined ? { auth: { kind: "none" } } : undefined;
    if (mode === "bearer") return externalBearer === undefined ? undefined : { auth: { kind: "bearer-environment" } };
    const selected = recognizedFlow(value);
    return selected === undefined || externalBearer !== undefined
      ? undefined
      : { auth: { kind: "oauth", flow: selected.flow }, ruleId: selected.ruleId };
  }
  if (!isRecord(value)) return undefined;
  const allowed = [
    ...definitions.modeKeys,
    ...definitions.bearerEnvironmentKeys,
    ...definitions.oauthParameterKeys,
    ...definitions.oauthFlowKeys,
    ...definitions.oauthBooleanFlowKeys,
  ] as readonly string[];
  if (Object.keys(value).some((key) => !allowed.includes(key))) return undefined;

  const modes: AuthMode[] = [];
  const flows: Array<{ flow: OAuthFlow; ruleId: string }> = [];
  let modeSelectors = 0;
  let flowSelectors = 0;
  let nestedBearer: string | undefined;
  let oauthParameter = false;
  for (const [key, entry] of Object.entries(value)) {
    if ((definitions.modeKeys as readonly string[]).includes(key)) {
      modeSelectors += 1;
      if (typeof entry !== "string") return undefined;
      const mode = recognizedAuthMode(entry);
      if (mode !== undefined) modes.push(mode);
      else if (key === "type") {
        const selected = recognizedFlow(entry);
        if (selected === undefined) return undefined;
        flowSelectors += 1;
        flows.push(selected);
      } else return undefined;
    } else if ((definitions.oauthFlowKeys as readonly string[]).includes(key)) {
      flowSelectors += 1;
      if (typeof entry !== "string") return undefined;
      const selected = recognizedFlow(entry);
      if (selected === undefined) return undefined;
      flows.push(selected);
    } else if ((definitions.oauthBooleanFlowKeys as readonly string[]).includes(key)) {
      flowSelectors += 1;
      if (typeof entry !== "boolean") return undefined;
      if (entry) {
        const selected = recognizedFlow(key.startsWith("authorization")
          ? "authorization-code"
          : "client-credentials");
        if (selected === undefined) return undefined;
        flows.push(selected);
      }
    } else if ((definitions.bearerEnvironmentKeys as readonly string[]).includes(key)) {
      if (typeof entry !== "string" || entry.length === 0) return undefined;
      nestedBearer = entry;
    } else {
      oauthParameter = true;
      if (typeof entry !== "string" || entry.length === 0) return undefined;
    }
  }
  if (modeSelectors > 1 || modes.length > 1 || flowSelectors > 1 || flows.length > 1) return undefined;
  const mode = modes[0];
  const hasBearer = nestedBearer !== undefined || externalBearer !== undefined || mode === "bearer";
  const hasOAuth = flowSelectors > 0 || mode === "oauth";
  if (hasBearer && hasOAuth || nestedBearer !== undefined && externalBearer !== undefined) return undefined;
  if (mode === "none") {
    return flowSelectors === 0 && !oauthParameter && !hasBearer ? { auth: { kind: "none" } } : undefined;
  }
  if (hasBearer) {
    return !oauthParameter && flowSelectors === 0
      ? { auth: { kind: "bearer-environment" } }
      : undefined;
  }
  if (flows.length !== 1) return undefined;
  return {
    auth: { kind: "oauth", flow: flows[0]!.flow },
    ruleId: flows[0]!.ruleId,
  };
}

function booleanFeature(value: JsonValue): Readonly<{ value?: boolean; issueSuffixes: readonly string[] }> {
  if (typeof value === "boolean") return { value, issueSuffixes: [] };
  if (!isRecord(value)) return { issueSuffixes: [""] };
  const allowed = CompatibilityPolicyRegistry.mcp.keys.booleanFeatureKeys as readonly string[];
  const issueSuffixes = Object.keys(value).filter((key) => !allowed.includes(key)).sort(compareUtf8);
  if (typeof value.enabled !== "boolean") issueSuffixes.push("enabled");
  if (value.required !== undefined && typeof value.required !== "boolean") issueSuffixes.push("required");
  if (value.required === true && value.enabled === false) issueSuffixes.push("required");
  return issueSuffixes.length > 0
    ? { issueSuffixes }
    : { value: value.enabled as boolean, issueSuffixes: [] };
}

function elicitationFeature(value: JsonValue): Readonly<{ form: boolean; url: boolean }> | undefined {
  if (value === "form") return { form: true, url: false };
  if (value === "url") return { form: false, url: true };
  if (!isRecord(value)) return undefined;
  const allowed = CompatibilityPolicyRegistry.mcp.keys.elicitationFeatureKeys as readonly string[];
  if (Object.keys(value).length === 0 || Object.keys(value).some((key) => !allowed.includes(key)) ||
      Object.values(value).some((entry) => typeof entry !== "boolean")) return undefined;
  return { form: value.form === true, url: value.url === true };
}

function analyze(plugin: PluginKey, component: McpServerComponent): McpCompatibilityAnalysis {
  const declarationValue = JsonValueSchema.parse(component.declaration.value);
  if (!isRecord(declarationValue)) {
    return { kind: "incompatible", diagnostics: [issue(plugin, component, "declaration")] };
  }
  const declaration = declarationValue;
  const diagnostics: Diagnostic[] = [];
  const ruleClaims: RuleClaim[] = [];
  const options: Record<string, JsonValue> = { schemaVersion: 1, auth: { kind: "none" } };

  const known = knownTopLevelKeys();
  for (const key of Object.keys(declaration)) {
    if (!known.has(key)) diagnostics.push(issue(plugin, component, key));
  }
  validateNestedContainer(plugin, component, declaration, "tools", diagnostics);
  validateNestedContainer(plugin, component, declaration, "features", diagnostics);

  const transportGroup = fieldGroup("transport");
  const transportResolution = resolveGroup(declaration, transportGroup, (value) =>
    typeof value === "string" ? canonicalTransport(value) : undefined);
  for (const field of transportResolution.invalid) {
    const claim = transportResolution.claims.find((candidate) => candidate.field === field);
    diagnostics.push(issue(plugin, component, field, claim?.value));
  }
  for (const field of transportResolution.conflicts) {
    const claim = transportResolution.claims.find((candidate) => candidate.field === field);
    diagnostics.push(issue(plugin, component, field, claim?.value));
  }
  let transport = transportResolution.value as AnyMcpTransport | undefined;
  if (transportResolution.invalid.length > 0 || transportResolution.conflicts.length > 0) transport = undefined;
  if (transport === undefined && transportResolution.claims.length === 0) {
    transport = claimsFor(declaration, fieldGroup("command")).length > 0
      ? "stdio"
      : claimsFor(declaration, fieldGroup("url")).length > 0 ? "streamable-http" : undefined;
  }
  if (transport === undefined) diagnostics.push(issue(plugin, component, transportGroup.aliases[0] ?? "transport"));

  for (const field of Object.keys(declaration)) {
    if (!known.has(field) || transportGroup.aliases.includes(field)) continue;
    if (transport === undefined || !fieldAllowedForTransport(field, transport)) {
      diagnostics.push(issue(plugin, component, field));
    }
  }

  const commandClaim = claimsFor(declaration, fieldGroup("command"))[0];
  const urlClaim = claimsFor(declaration, fieldGroup("url"))[0];
  let endpoint: McpEndpointAnalysis | undefined;
  if (transport === "stdio") {
    if (commandClaim === undefined || parseNonEmptyString(commandClaim.value) === undefined) {
      diagnostics.push(issue(plugin, component, commandClaim?.field ?? fieldGroup("command").aliases[0]!));
    }
    ruleClaims.push({
      ruleId: CompatibilityPolicyRegistry.mcp.transportStdio.id,
      provenance: component.declaration.provenance,
    });
  } else if (transport !== undefined) {
    let validUrl = urlClaim !== undefined && typeof urlClaim.value === "string" && urlClaim.value.length > 0;
    let transportSecurityInvalid = false;
    if (validUrl) {
      try {
        const parsed = new URL(urlClaim!.value as string);
        const protocols = transport === "websocket" ? ["ws:", "wss:"] : ["http:", "https:"];
        validUrl = protocols.includes(parsed.protocol) && parsed.username.length === 0 && parsed.password.length === 0 &&
          [...parsed.searchParams].every(([name, value]) =>
            !isSensitiveQueryName(name) || isPortableMcpValueReference(value));
        if (validUrl && transport === "streamable-http") {
          endpoint = analyzeMcpEndpoint(urlClaim!.value as string);
          transportSecurityInvalid = endpoint === undefined;
        }
      } catch {
        validUrl = false;
      }
    }
    if (!validUrl) diagnostics.push(issue(plugin, component, urlClaim?.field ?? fieldGroup("url").aliases[0]!));
    else if (transportSecurityInvalid) diagnostics.push(issue(
      plugin,
      component,
      urlClaim?.field ?? fieldGroup("url").aliases[0]!,
      undefined,
      CompatibilityPolicyRegistry.mcp.transportSecurity.id,
    ));
    if (transport === "streamable-http") {
      ruleClaims.push({
        ruleId: CompatibilityPolicyRegistry.mcp.transportStreamableHttp.id,
        provenance: component.declaration.provenance,
      });
    } else {
      diagnostics.push(issue(
        plugin,
        component,
        transportGroup.aliases[0] ?? "transport",
        transport,
        transport === "sse"
          ? CompatibilityPolicyRegistry.mcp.transportSse.id
          : CompatibilityPolicyRegistry.mcp.transportWebsocket.id,
      ));
    }
  }

  for (const name of ["arguments", "environment"] as const) {
    const group = fieldGroup(name);
    for (const claim of claimsFor(declaration, group)) {
      if (name === "arguments") {
        if (!stringArray(claim.value)) diagnostics.push(issue(plugin, component, claim.field));
        continue;
      }
      if (!isRecord(claim.value) || Object.values(claim.value).some((entry) => typeof entry !== "string")) {
        diagnostics.push(issue(plugin, component, claim.field));
      } else if (transport === "stdio") {
        for (const field of invalidEnvironmentFields(claim.value)) {
          diagnostics.push(issue(plugin, component, field === "" ? claim.field : `${claim.field}.${field}`));
        }
      }
    }
  }

  const workingDirectory = resolveGroup(declaration, fieldGroup("workingDirectory"), parseString);
  for (const field of [...workingDirectory.invalid, ...workingDirectory.conflicts]) {
    diagnostics.push(issue(plugin, component, field));
  }

  for (const name of ["startupTimeout", "toolTimeout"] as const) {
    const group = fieldGroup(name);
    const resolution = resolveGroup(declaration, group, parsePositiveNumber);
    for (const field of [...resolution.invalid, ...resolution.conflicts]) diagnostics.push(issue(plugin, component, field));
    if (resolution.value !== undefined) setOption(options, group, resolution.value);
  }

  const toolsValue = claimsFor(declaration, fieldGroup("tools"))[0]?.value;
  if (toolsValue !== undefined && !(stringArray(toolsValue) || isRecord(toolsValue))) {
    diagnostics.push(issue(plugin, component, fieldGroup("tools").aliases[0]!));
  }
  const allow = resolveGroup(declaration, fieldGroup("allowedTools"), parseToolList);
  for (const field of [...allow.invalid, ...allow.conflicts]) diagnostics.push(issue(plugin, component, field));
  const deny = resolveGroup(declaration, fieldGroup("deniedTools"), parseToolList);
  for (const field of [...deny.invalid, ...deny.conflicts]) diagnostics.push(issue(plugin, component, field));
  if (allow.value !== undefined) setOption(options, fieldGroup("allowedTools"), [...allow.value]);
  if (deny.value !== undefined) setOption(options, fieldGroup("deniedTools"), [...deny.value]);
  const denySet = new Set(deny.value ?? []);
  if ((allow.value ?? []).some((name) => denySet.has(name))) {
    diagnostics.push(issue(plugin, component, fieldGroup("tools").aliases[0]!));
  }

  const instructions = resolveGroup(declaration, fieldGroup("instructions"), parseString);
  for (const field of [...instructions.invalid, ...instructions.conflicts]) diagnostics.push(issue(plugin, component, field));
  if (instructions.value !== undefined) setOption(options, fieldGroup("instructions"), instructions.value);

  const resources = resolveGroup(declaration, fieldGroup("resources"), (value) =>
    typeof value === "boolean" ? value : stringArray(value) ? [...exactStringSet(value)] : undefined);
  for (const field of [...resources.invalid, ...resources.conflicts]) diagnostics.push(issue(plugin, component, field));
  if (resources.value !== undefined) {
    setOption(options, fieldGroup("resources"), resources.value);
    if (resources.value === true || Array.isArray(resources.value) && resources.value.length > 0) {
      const field = resources.claims[0]?.field ?? fieldGroup("resources").aliases[0]!;
      ruleClaims.push({
        ruleId: CompatibilityPolicyRegistry.mcp.featureResources.id,
        provenance: fieldProvenance(component, field),
      });
    }
  }

  const headerGroup = fieldGroup("headers");
  const headerResolution = resolveMcpFieldGroup(declaration, "headers", (value) => value);
  for (const field of headerResolution.conflicts) diagnostics.push(issue(plugin, component, field));
  const header = headerResolution.claims[0];
  if (header !== undefined && headerResolution.value !== undefined) {
    if (transport !== undefined && headerGroup.transports.includes(transport)) {
      for (const name of invalidHeaderFields(headerResolution.value)) {
        diagnostics.push(issue(plugin, component, name === "" ? header.field : `${header.field}.${name}`));
      }
    }
    if (header.field.includes(".") && transport !== undefined && !headerGroup.transports.includes(transport)) {
      diagnostics.push(issue(plugin, component, header.field));
    }
  }

  const authGroup = fieldGroup("authentication");
  const authClaims = claimsFor(declaration, authGroup);
  const externalBearerClaim = authClaims.find((claim) => claim.field === authGroup.externalBearerAlias);
  const nestedAuthClaim = authClaims.find((claim) => claim.field.startsWith("features."));
  const directAuthClaims = authClaims.filter((claim) =>
    claim !== externalBearerClaim && claim !== nestedAuthClaim);
  let externalBearer: string | undefined;
  if (externalBearerClaim !== undefined) {
    if (typeof externalBearerClaim.value !== "string" || externalBearerClaim.value.length === 0) {
      diagnostics.push(issue(plugin, component, externalBearerClaim.field));
    } else externalBearer = externalBearerClaim.value;
  }
  if (directAuthClaims.length > 1) {
    if (transport !== undefined && fieldAllowedForTransport(rootField(directAuthClaims[0]!.field), transport)) {
      diagnostics.push(issue(plugin, component, directAuthClaims[0]!.field));
    }
  }
  if (nestedAuthClaim !== undefined && directAuthClaims.length > 0) {
    diagnostics.push(issue(plugin, component, nestedAuthClaim.field));
  }
  const selectedAuthClaim = directAuthClaims[0] ?? nestedAuthClaim;
  if (selectedAuthClaim !== undefined && directAuthClaims.length <= 1 &&
      !(nestedAuthClaim !== undefined && directAuthClaims.length > 0)) {
    const parsed = parseAuth(selectedAuthClaim.value, externalBearer);
    if (parsed === undefined) {
      diagnostics.push(issue(plugin, component, selectedAuthClaim.field));
    } else if (transport !== "streamable-http") {
      if (selectedAuthClaim.field.includes(".") || transport !== undefined && authGroup.transports.includes(transport)) {
        diagnostics.push(issue(plugin, component, selectedAuthClaim.field));
      }
    } else {
      setOption(options, authGroup, parsed.auth);
      if (parsed.ruleId !== undefined) {
        ruleClaims.push({
          ruleId: parsed.ruleId,
          provenance: selectedAuthClaim.field.startsWith("features.")
            ? fieldProvenance(component, selectedAuthClaim.field)
            : component.declaration.provenance,
        });
      }
    }
  } else if (externalBearer !== undefined && transport === "streamable-http") {
    setOption(options, authGroup, { kind: "bearer-environment" });
  }

  for (const definition of Object.values(CompatibilityPolicyRegistry.mcp.keys.featurePayloadDefinitions)) {
    const group = fieldGroup(definition.fieldGroup as keyof typeof CompatibilityPolicyRegistry.mcp.keys.fieldGroups);
    const resolution = resolveGroup(declaration, group, (value) => value);
    for (const field of resolution.conflicts) diagnostics.push(issue(plugin, component, field));
    const claim = resolution.claims[0];
    if (claim === undefined) continue;
    if (definition.shape === "boolean-flags") {
      const parsed = booleanFeature(claim.value);
      for (const suffix of parsed.issueSuffixes) {
        diagnostics.push(issue(plugin, component, suffix === "" ? claim.field : `${claim.field}.${suffix}`));
      }
      if (parsed.value !== undefined) {
        setOption(options, group, parsed.value);
        if (parsed.value) {
          ruleClaims.push({ ruleId: definition.ruleId, provenance: fieldProvenance(component, claim.field) });
        }
      }
    } else {
      const parsed = elicitationFeature(claim.value);
      if (parsed === undefined) diagnostics.push(issue(plugin, component, claim.field));
      else {
        setOption(options, group, parsed);
        if (parsed.form) ruleClaims.push({
          ruleId: CompatibilityPolicyRegistry.mcp.featureElicitationForm.id,
          provenance: fieldProvenance(component, isRecord(claim.value) ? `${claim.field}.form` : claim.field),
        });
        if (parsed.url) ruleClaims.push({
          ruleId: CompatibilityPolicyRegistry.mcp.featureElicitationUrl.id,
          provenance: fieldProvenance(component, isRecord(claim.value) ? `${claim.field}.url` : claim.field),
        });
      }
    }
  }

  for (const [name, ruleId] of [
    ["headersHelper", CompatibilityPolicyRegistry.mcp.headersHelper.id],
    ["channels", CompatibilityPolicyRegistry.mcp.channels.id],
  ] as const) {
    for (const claim of claimsFor(declaration, fieldGroup(name))) {
      diagnostics.push(issue(plugin, component, claim.field, undefined, ruleId));
    }
  }

  const hasAuthorizationHeader = headerResolution.claims.some((claim) =>
    isRecord(claim.value) && Object.keys(claim.value).some((name) => name.toLowerCase() === "authorization"));
  const canonicalAuth = McpCanonicalAuthSchema.safeParse(options.auth);
  if (hasAuthorizationHeader && canonicalAuth.success && canonicalAuth.data.kind === "bearer-environment") {
    diagnostics.push(issue(
      plugin,
      component,
      externalBearerClaim?.field ?? selectedAuthClaim?.field ?? authGroup.aliases[0]!,
    ));
  }
  if (transport === "streamable-http" && endpoint?.security === "consent-bound-loopback-plaintext" && (
    !canonicalAuth.success || canonicalAuth.data.kind !== "none" ||
    isRecord(headerResolution.value) && Object.keys(headerResolution.value).length > 0
  )) {
    diagnostics.push(issue(
      plugin,
      component,
      urlClaim?.field ?? fieldGroup("url").aliases[0]!,
      undefined,
      CompatibilityPolicyRegistry.mcp.transportSecurity.id,
    ));
  }

  if (diagnostics.length > 0 || transport !== "stdio" && transport !== "streamable-http") {
    const sorted = diagnostics.sort(compareDiagnostics);
    if (sorted.some(diagnosticBlocksActivation)) {
      return { kind: "incompatible", diagnostics: sorted };
    }
    return { kind: "metadata-only", diagnostics: downgradeToWarnings(sorted) };
  }
  const uses = requirementUses(ruleClaims);
  return {
    kind: "supported",
    plan: McpCompatibilityPlanSchemaV1.parse({
      schemaVersion: 1,
      componentId: component.id,
      transport,
      options: McpCanonicalOptionsSchemaV1.parse(options),
      requirementCapabilityIds: uses.map((use) => use.capability),
      provenance: canonicalMcpSourceLocations(component),
    }),
    requirementUses: uses,
  };
}

/**
 * Interpret one normalized MCP declaration using the registry-owned policy.
 * Returned plans contain structural behavior only; launch and credential
 * values remain in the authoritative component declaration.
 */
export function analyzeMcpCompatibility(input: Readonly<{
  plugin: PluginKey;
  component: McpServerComponent;
}>): McpCompatibilityAnalysis {
  const plugin = PluginKeySchema.parse(input.plugin);
  const component = McpServerComponentSchema.parse(input.component);
  return analyze(plugin, component);
}
