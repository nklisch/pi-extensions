import { z } from "zod";
import { compareUtf8 } from "./canonical-json.js";
import { McpServerComponentSchema, type McpServerComponent } from "./components.js";
import { CompatibilityPolicyRegistry } from "./compatibility-policy.js";
import type { McpCanonicalAuth } from "./mcp-compatibility-plan.js";
import {
  analyzeMcpCompatibility,
  resolveMcpFieldGroup,
} from "./mcp-compatibility-plan.js";
import { PluginKeySchema, type PluginKey } from "./identity.js";
import { analyzeMcpEndpoint, McpEndpointSecuritySchema } from "./mcp-endpoint-security.js";
import {
  isPortableMcpHeaderCredential,
  isPortableMcpValueReference,
  parseMcpTemplateTokens,
} from "./mcp-late-values.js";
import type { JsonValue } from "./schema.js";
import {
  isSensitiveFieldName,
  isSensitiveQueryName,
} from "./sensitive-fields.js";

export { parseMcpTemplateTokens } from "./mcp-late-values.js";
export type { McpTemplateToken } from "./mcp-late-values.js";

export const McpEnvironmentNameSchema = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/);
export const McpHeaderNameSchema = z.string().regex(/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/);

const McpLateValueSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("template"), template: z.string() }).strict().readonly(),
  z.object({ kind: z.literal("environment"), name: McpEnvironmentNameSchema }).strict().readonly(),
]);
export type McpLateValue = z.infer<typeof McpLateValueSchema>;

function issueTemplate(
  context: z.RefinementCtx,
  path: readonly PropertyKey[],
): void {
  context.addIssue({
    code: "custom",
    path: [...path] as (string | number)[],
    message: "MCP launch template must remain canonical and secret-free",
  });
}

function validTemplate(value: string): boolean {
  try {
    parseMcpTemplateTokens(value);
    return true;
  } catch {
    return false;
  }
}

const McpEnvironmentEntrySchema = z.object({
  name: McpEnvironmentNameSchema,
  value: z.string(),
}).strict().readonly();

const McpHeaderEntrySchema = z.object({
  name: McpHeaderNameSchema,
  value: McpLateValueSchema,
}).strict().readonly();

const McpLaunchTemplateShapeSchemaV1 = z.discriminatedUnion("transport", [
  z.object({
    schemaVersion: z.literal(1),
    transport: z.literal("stdio"),
    command: z.string().min(1),
    args: z.array(z.string()).readonly(),
    cwd: z.string().optional(),
    env: z.array(McpEnvironmentEntrySchema).readonly(),
  }).strict().readonly(),
  z.object({
    schemaVersion: z.literal(1),
    transport: z.literal("streamable-http"),
    endpointSecurity: McpEndpointSecuritySchema,
    url: z.string().min(1),
    headers: z.array(McpHeaderEntrySchema).readonly(),
    bearerToken: McpLateValueSchema.optional(),
  }).strict().readonly(),
]);

export const McpLaunchTemplateSchemaV1 = McpLaunchTemplateShapeSchemaV1.superRefine(
  (template, context) => {
    if (template.transport === "stdio") {
      const strings = [
        [template.command, ["command"]] as const,
        ...template.args.map((value, index) => [value, ["args", index]] as const),
        ...(template.cwd === undefined ? [] : [[template.cwd, ["cwd"]] as const]),
        ...template.env.map((entry, index) => [entry.value, ["env", index, "value"]] as const),
      ];
      for (const [value, path] of strings) {
        if (!validTemplate(value)) issueTemplate(context, path);
      }
      let previous: string | undefined;
      for (const [index, entry] of template.env.entries()) {
        if (previous !== undefined && compareUtf8(previous, entry.name) >= 0) {
          issueTemplate(context, ["env", index, "name"]);
        }
        previous = entry.name;
        if (isSensitiveFieldName(entry.name) && !isPortableMcpValueReference(entry.value)) {
          issueTemplate(context, ["env", index, "value"]);
        }
      }
      return;
    }

    const endpoint = validTemplate(template.url) ? analyzeMcpEndpoint(template.url) : undefined;
    if (endpoint === undefined || endpoint.security !== template.endpointSecurity ||
        [...endpoint?.url.searchParams ?? []].some(([name, value]) =>
          isSensitiveQueryName(name) && !isPortableMcpValueReference(value))) {
      issueTemplate(context, ["url"]);
    }

    let previousHeader: string | undefined;
    for (const [index, header] of template.headers.entries()) {
      const canonical = header.name.toLowerCase();
      if (previousHeader !== undefined && compareUtf8(previousHeader, canonical) >= 0) {
        issueTemplate(context, ["headers", index, "name"]);
      }
      previousHeader = canonical;
      if (header.value.kind === "template") {
        if (!validTemplate(header.value.template) || /[\r\n\0]/.test(header.value.template) ||
            isSensitiveFieldName(header.name) &&
              !isPortableMcpHeaderCredential(header.name, header.value.template)) {
          issueTemplate(context, ["headers", index, "value"]);
        }
      }
    }
    if (template.bearerToken?.kind === "template" &&
        !isPortableMcpValueReference(template.bearerToken.template)) {
      issueTemplate(context, ["bearerToken"]);
    }
    if (template.bearerToken !== undefined &&
        template.headers.some((header) => header.name.toLowerCase() === "authorization")) {
      issueTemplate(context, ["bearerToken"]);
    }
    if (template.endpointSecurity === "consent-bound-loopback-plaintext" &&
        (template.headers.length > 0 || template.bearerToken !== undefined)) {
      issueTemplate(context, ["endpointSecurity"]);
    }
  },
);
export type McpLaunchTemplate = z.infer<typeof McpLaunchTemplateSchemaV1>;

export class McpLaunchTemplateError extends Error {
  constructor() {
    super("MCP launch template is invalid");
    this.name = "McpLaunchTemplateError";
  }
}

type JsonRecord = Readonly<Record<string, JsonValue>>;
type McpFieldGroupName = keyof typeof CompatibilityPolicyRegistry.mcp.keys.fieldGroups;

function fail(): never {
  throw new McpLaunchTemplateError();
}

function isRecord(value: JsonValue | undefined): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function valueAtPath(declaration: JsonRecord, path: string): JsonValue | undefined {
  let current: JsonValue = declaration;
  for (const segment of path.split(".")) {
    if (!isRecord(current) || !Object.prototype.hasOwnProperty.call(current, segment)) return undefined;
    current = current[segment]!;
  }
  return current;
}

/** The compatibility registry owns every accepted launch-field spelling. */
function fieldValue(declaration: JsonRecord, name: McpFieldGroupName): JsonValue | undefined {
  const resolution = resolveMcpFieldGroup(declaration, name, (value) => value);
  if (resolution.invalid.length > 0 || resolution.conflicts.length > 0) fail();
  return resolution.value;
}

function stringArray(value: JsonValue | undefined): readonly string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) fail();
  return value as readonly string[];
}

function stdioTemplate(declaration: JsonRecord): McpLaunchTemplate {
  const command = fieldValue(declaration, "command");
  if (typeof command !== "string" || command.length === 0) fail();
  const cwd = fieldValue(declaration, "workingDirectory");
  if (cwd !== undefined && typeof cwd !== "string") fail();
  const rawEnvironment = fieldValue(declaration, "environment");
  if (rawEnvironment !== undefined && !isRecord(rawEnvironment)) fail();
  const env = Object.entries(rawEnvironment ?? {})
    .map(([name, value]) => {
      if (typeof value !== "string") fail();
      return McpEnvironmentEntrySchema.parse({ name, value });
    })
    .sort((left, right) => compareUtf8(left.name, right.name));
  return McpLaunchTemplateSchemaV1.parse({
    schemaVersion: 1,
    transport: "stdio",
    command,
    args: stringArray(fieldValue(declaration, "arguments")),
    ...(cwd === undefined ? {} : { cwd }),
    env,
  });
}

function headerValue(value: JsonValue): McpLateValue {
  if (typeof value === "string") return { kind: "template", template: value };
  if (!isRecord(value) || Object.keys(value).length !== 1 || typeof value.env !== "string") fail();
  return McpLateValueSchema.parse({ kind: "environment", name: value.env });
}

function bearerEnvironment(
  declaration: JsonRecord,
  auth: McpCanonicalAuth,
): McpLateValue | undefined {
  if (auth.kind !== "bearer-environment") return undefined;
  const group = CompatibilityPolicyRegistry.mcp.keys.fieldGroups.authentication;
  const topLevelValue = group.externalBearerAlias === undefined
    ? undefined
    : valueAtPath(declaration, group.externalBearerAlias);
  const topLevel = typeof topLevelValue === "string" ? topLevelValue : undefined;
  const selected = group.aliases
    .filter((alias) => alias !== group.externalBearerAlias)
    .map((alias) => valueAtPath(declaration, alias))
    .find((value) => value !== undefined);
  const nested = isRecord(selected)
    ? CompatibilityPolicyRegistry.mcp.keys.authSelectorDefinitions.bearerEnvironmentKeys
      .map((key) => selected[key])
      .find((value): value is string => typeof value === "string")
    : undefined;
  const name = nested ?? topLevel;
  if (name === undefined) fail();
  return McpLateValueSchema.parse({ kind: "environment", name });
}

function httpTemplate(declaration: JsonRecord, auth: McpCanonicalAuth): McpLaunchTemplate {
  const url = fieldValue(declaration, "url");
  if (typeof url !== "string" || url.length === 0) fail();
  const endpoint = analyzeMcpEndpoint(url);
  if (endpoint === undefined) fail();
  const rawHeaders = fieldValue(declaration, "headers");
  if (rawHeaders !== undefined && !isRecord(rawHeaders)) fail();
  const seen = new Set<string>();
  const headers = Object.entries(rawHeaders ?? {})
    .map(([name, value]) => {
      const canonical = name.toLowerCase();
      if (seen.has(canonical)) fail();
      seen.add(canonical);
      McpHeaderNameSchema.parse(name);
      return McpHeaderEntrySchema.parse({ name, value: headerValue(value) });
    })
    .sort((left, right) => compareUtf8(left.name.toLowerCase(), right.name.toLowerCase()) || compareUtf8(left.name, right.name));
  const bearerToken = bearerEnvironment(declaration, auth);
  if (bearerToken !== undefined && headers.some((entry) => entry.name.toLowerCase() === "authorization")) fail();
  return McpLaunchTemplateSchemaV1.parse({
    schemaVersion: 1,
    transport: "streamable-http",
    endpointSecurity: endpoint.security,
    url,
    headers,
    ...(bearerToken === undefined ? {} : { bearerToken }),
  });
}

/**
 * Project one compatibility-approved declaration into its unexpanded launch
 * template. The shared MCP analysis remains the acceptance and alias authority;
 * this mapper only copies its launch-bearing values into the strict contract.
 */
export function createMcpLaunchTemplate(
  componentInput: McpServerComponent,
  pluginInput: PluginKey = PluginKeySchema.parse("mcp-launch-template@internal"),
): McpLaunchTemplate {
  try {
    const component = McpServerComponentSchema.parse(componentInput);
    const analysis = analyzeMcpCompatibility({
      plugin: PluginKeySchema.parse(pluginInput),
      component,
    });
    if (analysis.kind !== "supported" || !isRecord(component.declaration.value)) fail();
    const declaration = component.declaration.value;
    return analysis.plan.transport === "stdio"
      ? stdioTemplate(declaration)
      : httpTemplate(declaration, analysis.plan.options.auth);
  } catch (error) {
    if (error instanceof McpLaunchTemplateError) throw error;
    throw new McpLaunchTemplateError();
  }
}
