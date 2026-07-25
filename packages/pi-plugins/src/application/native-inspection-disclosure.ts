import { analyzeMcpCompatibility } from "../domain/mcp-compatibility-plan.js";
import { canonicalJson, compareUtf8 } from "../domain/canonical-json.js";
import {
  CompatibilityReportSchema,
  type CompatibilityReport,
} from "../domain/compatibility.js";
import { analyzeMcpEndpoint } from "../domain/mcp-endpoint-security.js";
import { createMcpLaunchTemplate } from "../domain/mcp-launch-template.js";
import { NormalizedPluginSchema, type NormalizedPlugin } from "../domain/plugin.js";
import { ProvenanceSchema, type Provenance } from "../domain/provenance.js";
import {
  MarketplaceSourceSchema,
  PluginSourceSchema,
  ResolvedMarketplaceSourceSchema,
  ResolvedPluginSourceSchema,
  type MarketplaceSource,
  type PluginSource,
  type ResolvedMarketplaceSource,
  type ResolvedPluginSource,
} from "../domain/source.js";
import {
  NativeComponentInventoryViewSchema,
  NativeMcpEndpointSchema,
  NativeProvenanceViewSchema,
  NativeRedactedUrlSchema,
  NativeSourceViewSchema,
  type NativeComponentInventoryView,
  type NativeProvenanceView,
  type NativeSourceView,
} from "./native-inspection-contract.js";
import { NativeDisplayLimits, toSafeDisplayField } from "./native-inspection-display.js";

// Classify paths for every host, not the machine running inspection. Leading
// slash/backslash covers POSIX, UNC, device, and Windows root-relative forms;
// any drive-qualified or file: form is treated as sensitive provenance.
const ABSOLUTE_PATH = /^(?:[\\/]|[A-Za-z]:|file:)/iu;

function safePath(value: string, allowAbsolute = false) {
  const projected = !allowAbsolute && ABSOLUTE_PATH.test(value) ? "[redacted-absolute-path]" : value;
  return toSafeDisplayField(projected, { maxScalars: NativeDisplayLimits.pathScalars });
}

function safeLabel(value: string) {
  return toSafeDisplayField(value, { maxScalars: NativeDisplayLimits.labelScalars });
}

export function projectRedactedUrl(value: string) {
  let parsed: URL | undefined;
  try {
    parsed = new URL(value);
  } catch {
    const scp = /^(?:[^@\s]+@)?([^:\s]+):(.+)$/u.exec(value);
    const rawPath = scp?.[2] ?? "[unavailable]";
    const redactedPath = rawPath.split(/[?#]/u, 1)[0] || "[unavailable]";
    return NativeRedactedUrlSchema.parse({
      scheme: scp === null ? "unknown" : "ssh",
      host: safeLabel(scp?.[1] ?? "[unavailable]"),
      path: safePath(redactedPath),
      queryPresent: value.includes("?"),
      fragmentPresent: value.includes("#"),
    });
  }
  const scheme = ["http:", "https:", "ssh:", "git:"].includes(parsed.protocol)
    ? parsed.protocol.slice(0, -1)
    : "unknown";
  return NativeRedactedUrlSchema.parse({
    scheme,
    host: safeLabel(parsed.hostname || "[unavailable]"),
    ...(parsed.port === "" ? {} : { port: safeLabel(parsed.port) }),
    path: safePath(decodeSafePath(parsed.pathname)),
    queryPresent: parsed.search.length > 0,
    fragmentPresent: parsed.hash.length > 0,
  });
}

function projectMcpEndpoint(value: string) {
  const endpoint = analyzeMcpEndpoint(value);
  if (endpoint === undefined) throw new Error("MCP endpoint is not safe to disclose");
  return NativeMcpEndpointSchema.parse({
    scheme: endpoint.url.protocol === "https:" ? "https" : "http",
    host: safeLabel(endpoint.url.hostname.replace(/^\[|\]$/gu, "")),
    port: safeLabel(endpoint.effectivePort),
    // URL paths are not filesystem paths. Preserve their exact encoded form so
    // consent cannot visually alias `%2F` with a literal path separator.
    path: safePath(endpoint.url.pathname, true),
    queryPresent: endpoint.url.search.length > 0,
  });
}

function decodeSafePath(path: string): string {
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}

function sourceInput(
  input: MarketplaceSource | PluginSource | ResolvedPluginSource | ResolvedMarketplaceSource,
): Readonly<{ source: MarketplaceSource | PluginSource | ResolvedPluginSource; identity?: string; revision?: string }> {
  const resolvedMarketplace = ResolvedMarketplaceSourceSchema.safeParse(input);
  if (resolvedMarketplace.success) {
    return { source: resolvedMarketplace.data.declared, identity: resolvedMarketplace.data.hash, revision: resolvedMarketplace.data.revision };
  }
  const resolvedPlugin = ResolvedPluginSourceSchema.safeParse(input);
  if (resolvedPlugin.success) {
    const source = resolvedPlugin.data;
    const revision = source.kind === "npm" ? source.version : source.kind === "marketplace-path" ? source.marketplaceRevision : source.revision;
    return { source, identity: source.hash, revision };
  }
  const marketplace = MarketplaceSourceSchema.safeParse(input);
  if (marketplace.success) return { source: marketplace.data };
  return { source: PluginSourceSchema.parse(input) };
}

/** Project source identity without canonical strings, credentials, or URL values. */
export function projectSafeSource(
  input: MarketplaceSource | PluginSource | ResolvedPluginSource | ResolvedMarketplaceSource,
): NativeSourceView {
  const { source, identity, revision } = sourceInput(input);
  const common = { kind: source.kind, ...(identity === undefined ? {} : { identity }), ...(revision === undefined ? {} : { revision: safeLabel(revision) }) };
  switch (source.kind) {
    case "github":
      return NativeSourceViewSchema.parse({ ...common, location: safePath(source.repository) });
    case "git":
      return NativeSourceViewSchema.parse({ ...common, endpoint: projectRedactedUrl(source.url) });
    case "local-git":
      // A local declaration is explicit user-selected identity, unlike custody
      // and generated roots, which are never accepted by this function.
      return NativeSourceViewSchema.parse({ ...common, location: safePath(source.path, true) });
    case "marketplace-path":
      return NativeSourceViewSchema.parse({ ...common, location: safePath(source.path) });
    case "git-subdir":
      return NativeSourceViewSchema.parse({ ...common, endpoint: projectRedactedUrl(source.url), location: safePath(source.path) });
    case "npm":
      return NativeSourceViewSchema.parse({
        ...common,
        package: safeLabel(source.package),
        ...(source.registry === undefined ? {} : { endpoint: projectRedactedUrl(source.registry) }),
      });
  }
}

export function projectSafeProvenance(input: readonly Provenance[]): readonly NativeProvenanceView[] {
  const unique = new Map<string, Provenance>();
  for (const raw of input) {
    const value = ProvenanceSchema.parse(raw);
    const location = value.location;
    unique.set(canonicalJson(location), value);
  }
  const projected = [...unique.entries()]
    .sort(([left], [right]) => compareUtf8(left, right))
    .slice(0, NativeDisplayLimits.maxProvenance)
    .map(([, value]) => NativeProvenanceViewSchema.parse({
      host: value.location.host,
      documentKind: value.location.documentKind,
      path: safePath(value.location.path),
      ...(value.location.pointer === undefined ? {} : { pointer: safePath(value.location.pointer) }),
      ...(value.location.line === undefined ? {} : { line: value.location.line }),
      ...(value.location.column === undefined ? {} : { column: value.location.column }),
    }));
  return Object.freeze(projected);
}

function assessmentMap(report: CompatibilityReport | undefined) {
  return new Map(report?.components.map((assessment) => [assessment.componentId, assessment]) ?? []);
}

function authentication(component: NormalizedPlugin["components"]["mcpServers"][number]) {
  const analysis = analyzeMcpCompatibility({ plugin: "native-inspection@internal" as never, component });
  if (analysis.kind !== "supported") return "unavailable" as const;
  const auth = analysis.plan.options.auth;
  if (auth.kind === "oauth") return auth.flow === "authorization-code" ? "oauth-authorization-code" as const : "oauth-client-credentials" as const;
  return auth.kind;
}

/**
 * Project complete normalized inventory using the existing compatibility
 * report and MCP analysis. Raw declarations and all late-bound values are
 * structurally omitted.
 */
export function projectSafeComponents(input: Readonly<{
  plugin: NormalizedPlugin;
  compatibility?: CompatibilityReport;
}>): NativeComponentInventoryView {
  const plugin = NormalizedPluginSchema.parse(input.plugin);
  const compatibility = input.compatibility === undefined ? undefined : CompatibilityReportSchema.parse(input.compatibility);
  if (compatibility !== undefined && compatibility.plugin.key !== plugin.identity.key) {
    throw new Error("compatibility report belongs to another plugin");
  }
  const assessments = assessmentMap(compatibility);
  const base = (component: { id: string }, provenance: readonly Provenance[]) => {
    const assessment = assessments.get(component.id as never);
    return {
      componentId: component.id,
      verdict: assessment?.verdict.kind ?? "unavailable",
      requirementIds: assessment?.requirementIds ?? [],
      provenance: projectSafeProvenance(provenance),
    };
  };
  const skills = plugin.components.skills.map((component) => ({
    ...base(component, [...component.name.provenance, ...component.root.provenance]),
    kind: "skill" as const,
    name: safeLabel(component.name.value),
    root: safePath(component.root.value),
  })).sort((left, right) => compareUtf8(left.componentId, right.componentId));
  const hooks = plugin.components.hooks.map((component) => {
    const handler = component.handler.value.kind === "shell"
      ? {
          kind: "shell" as const,
          command: toSafeDisplayField(component.handler.value.command, { maxScalars: NativeDisplayLimits.commandScalars }),
          ...(component.handler.value.shell === undefined ? {} : { shell: component.handler.value.shell }),
          ...(component.handler.value.timeoutMs === undefined ? {} : { timeoutMs: component.handler.value.timeoutMs }),
        }
      : {
          kind: "exec" as const,
          command: toSafeDisplayField(component.handler.value.command, { maxScalars: NativeDisplayLimits.commandScalars }),
          args: component.handler.value.args.slice(0, NativeDisplayLimits.maxArguments).map((argument) =>
            toSafeDisplayField(argument, { maxScalars: NativeDisplayLimits.argumentScalars })),
          ...(component.handler.value.timeoutMs === undefined ? {} : { timeoutMs: component.handler.value.timeoutMs }),
        };
    return {
      ...base(component, [...component.event.provenance, ...(component.matcher?.provenance ?? []), ...component.handler.provenance]),
      kind: "hook" as const,
      event: safeLabel(component.event.value),
      ...(component.matcher === undefined ? {} : { matcher: safeLabel(component.matcher.value) }),
      handler,
    };
  }).sort((left, right) => compareUtf8(left.componentId, right.componentId));
  const mcpServers = plugin.components.mcpServers.map((component) => {
    let disclosure: Record<string, unknown> = { args: [], environmentNames: [], headerNames: [] };
    try {
      const template = createMcpLaunchTemplate(component, plugin.identity.key);
      if (template.transport === "stdio") {
        disclosure = {
          transport: template.transport,
          command: toSafeDisplayField(template.command, { maxScalars: NativeDisplayLimits.commandScalars }),
          args: template.args.slice(0, NativeDisplayLimits.maxArguments).map((argument) => toSafeDisplayField(argument, { maxScalars: NativeDisplayLimits.argumentScalars })),
          environmentNames: template.env.slice(0, NativeDisplayLimits.maxArguments).map((entry) => safeLabel(entry.name)),
          headerNames: [],
        };
      } else {
        disclosure = {
          transport: template.transport,
          args: [],
          url: projectMcpEndpoint(template.url),
          environmentNames: template.bearerToken?.kind === "environment" ? [safeLabel(template.bearerToken.name)] : [],
          headerNames: template.headers.slice(0, NativeDisplayLimits.maxArguments).map((entry) => safeLabel(entry.name)),
        };
      }
    } catch {
      // Incompatible components retain identity and provenance, never raw
      // declaration fallback.
    }
    const analysis = (() => {
      try { return analyzeMcpCompatibility({ plugin: plugin.identity.key, component }); }
      catch { return undefined; }
    })();
    const options = analysis?.kind === "supported" ? analysis.plan.options : undefined;
    return {
      ...base(component, [...component.nativeKey.provenance, ...component.declaration.provenance]),
      kind: "mcp-server" as const,
      nativeKey: safeLabel(component.nativeKey.value),
      ...disclosure,
      authentication: authentication(component),
      toolPolicy: {
        allowed: [...(options?.allowedTools ?? [])].sort(compareUtf8).map(safeLabel),
        denied: [...(options?.deniedTools ?? [])].sort(compareUtf8).map(safeLabel),
        approval: options === undefined ? "not-applicable" : options.toolApproval === true ? "required" : "default",
      },
      ...(options?.startupTimeoutMs === undefined ? {} : { startupTimeoutMs: options.startupTimeoutMs }),
      ...(options?.toolTimeoutMs === undefined ? {} : { toolTimeoutMs: options.toolTimeoutMs }),
    };
  }).sort((left, right) => compareUtf8(left.componentId, right.componentId));
  const foreign = plugin.components.foreign.map((component) => ({
    ...base(component, component.declaration.provenance),
    kind: "foreign" as const,
    nativeHost: component.nativeHost,
    nativeKind: safeLabel(component.nativeKind.value),
  })).sort((left, right) => compareUtf8(left.componentId, right.componentId));

  return NativeComponentInventoryViewSchema.parse({
    counts: { skills: skills.length, hooks: hooks.length, mcpServers: mcpServers.length, foreign: foreign.length },
    skills,
    hooks,
    mcpServers,
    foreign,
  });
}
