import { z } from "zod";
import {
  McpServerComponentSchema,
  RetainedMetadataSchema,
  type McpServerComponent,
  type RetainedMetadata,
} from "../domain/components.js";
import {
  DiagnosticSchema,
  ErrorCodeRegistry,
  type Diagnostic,
  type ReadResult,
} from "../domain/errors.js";
import { PluginKeySchema, type PluginKey } from "../domain/identity.js";
import {
  claim,
  ProvenanceSchema,
  type NativeHost,
  type Provenance,
} from "../domain/provenance.js";
import { JsonValueSchema, type JsonValue } from "../domain/schema.js";
import { stableComponentId, stableJson } from "./stable-component-id.js";

export type McpDocumentReaderContext = Readonly<{
  plugin: PluginKey;
  nativeHost: NativeHost;
  provenance: Provenance;
}>;

export type McpDocumentReader = (
  input: unknown,
  context: McpDocumentReaderContext,
) => ReadResult<readonly McpServerComponent[]>;

export class McpReaderFailure extends Error {
  readonly pointer: string;
  readonly details: JsonValue | undefined;

  constructor(pointer: string, message: string, details?: JsonValue) {
    super(message);
    this.name = "McpReaderFailure";
    this.pointer = pointer;
    this.details = details;
  }
}

function pointerSegment(key: string | number): string {
  return String(key).replaceAll("~", "~0").replaceAll("/", "~1");
}

function childPointer(base: string | undefined, key: string | number): string {
  return `${base ?? ""}/${pointerSegment(key)}`;
}

function isRecord(value: JsonValue): value is { readonly [key: string]: JsonValue } {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function provenanceKey(provenance: Provenance): string {
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

function mergeProvenance(
  left: readonly Provenance[],
  right: readonly Provenance[],
): readonly [Provenance, ...Provenance[]] {
  const result: Provenance[] = [];
  for (const candidate of [...left, ...right].sort((a, b) => {
    const leftKey = provenanceKey(a);
    const rightKey = provenanceKey(b);
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
  })) {
    if (!result.some((entry) => provenanceKey(entry) === provenanceKey(candidate))) result.push(candidate);
  }
  if (result.length === 0) throw new Error("MCP provenance cannot be empty");
  return result as [Provenance, ...Provenance[]];
}

function sourceAt(
  context: McpDocumentReaderContext,
  pointer: string,
  declaration?: JsonValue,
): Provenance {
  return ProvenanceSchema.parse({
    location: { ...context.provenance.location, pointer },
    ...(declaration === undefined ? {} : { declaration }),
  });
}

function metadata(
  context: McpDocumentReaderContext,
  shape: string,
  pointer: string,
): RetainedMetadata {
  return RetainedMetadataSchema.parse({
    key: `${context.nativeHost}.mcp.shape`,
    claimed: claim(shape, sourceAt(context, pointer)),
  });
}

function invalid<T>(
  operation: string,
  context: McpDocumentReaderContext,
  error: unknown,
): ReadResult<T> {
  let pointer = context.provenance.location.pointer ?? "";
  let message = `${operation} input is invalid`;
  let details: JsonValue | undefined;
  if (error instanceof McpReaderFailure) {
    pointer = error.pointer;
    message = error.message;
    details = error.details;
  } else if (error instanceof z.ZodError) {
    const first = error.issues[0];
    pointer = first === undefined
      ? pointer
      : childPointer(pointer, first.path.map(String).join("/"));
    message = first?.message ?? message;
    details = {
      issues: error.issues.map((issue) => ({
        code: issue.code,
        path: issue.path.map(String),
        message: issue.message,
      })),
    };
  } else if (error instanceof Error) {
    message = error.message;
  } else {
    message = String(error);
  }
  const diagnostic: Diagnostic = DiagnosticSchema.parse({
    code: ErrorCodeRegistry.schemaInvalid,
    severity: "error",
    operation,
    message,
    location: { ...context.provenance.location, pointer },
    plugin: PluginKeySchema.parse(context.plugin),
    ...(details === undefined ? {} : { details }),
  });
  return { ok: false, diagnostics: [diagnostic] };
}

export function mergeMcpComponents(
  left: McpServerComponent,
  right: McpServerComponent,
): McpServerComponent {
  if (left.nativeKey.value !== right.nativeKey.value || stableJson(left.declaration.value) !== stableJson(right.declaration.value)) {
    throw new McpReaderFailure(
      right.declaration.provenance[0]?.location.pointer ?? "",
      `conflicting MCP declarations for native key ${right.nativeKey.value}`,
      {
        left: {
          value: left.declaration.value,
          provenance: left.declaration.provenance as unknown as JsonValue,
        },
        right: {
          value: right.declaration.value,
          provenance: right.declaration.provenance as unknown as JsonValue,
        },
      },
    );
  }
  const metadata = [...left.metadata];
  for (const candidate of right.metadata) {
    const existing = metadata.find((entry) => entry.key === candidate.key);
    if (existing === undefined) {
      metadata.push(candidate);
      continue;
    }
    if (stableJson(existing.claimed.value) !== stableJson(candidate.claimed.value)) {
      throw new McpReaderFailure(
        candidate.claimed.provenance[0]?.location.pointer ?? "",
        `conflicting MCP shape claims for native key ${left.nativeKey.value}`,
        {
          left: existing.claimed as unknown as JsonValue,
          right: candidate.claimed as unknown as JsonValue,
        },
      );
    }
    metadata[metadata.indexOf(existing)] = {
      key: existing.key,
      claimed: {
        value: existing.claimed.value,
        provenance: mergeProvenance(existing.claimed.provenance, candidate.claimed.provenance),
      },
    };
  }
  return McpServerComponentSchema.parse({
    ...left,
    nativeKey: {
      value: left.nativeKey.value,
      provenance: mergeProvenance(left.nativeKey.provenance, right.nativeKey.provenance),
    },
    declaration: {
      value: left.declaration.value,
      provenance: mergeProvenance(left.declaration.provenance, right.declaration.provenance),
    },
    metadata,
  });
}

export function deduplicateMcpComponents(
  components: readonly McpServerComponent[],
): readonly McpServerComponent[] {
  const byKey = new Map<string, McpServerComponent>();
  for (const component of components) {
    const existing = byKey.get(component.nativeKey.value);
    byKey.set(component.nativeKey.value, existing === undefined ? component : mergeMcpComponents(existing, component));
  }
  return [...byKey.values()].sort((left, right) => left.nativeKey.value.localeCompare(right.nativeKey.value));
}

export function readMcpDocument(
  operation: string,
  input: unknown,
  context: McpDocumentReaderContext,
  expectedHost?: NativeHost,
): ReadResult<readonly McpServerComponent[]> {
  try {
    if (expectedHost !== undefined && context.nativeHost !== expectedHost) {
      throw new McpReaderFailure(
        context.provenance.location.pointer ?? "",
        `${operation} requires ${expectedHost} provenance`,
      );
    }
    const plugin = PluginKeySchema.parse(context.plugin);
    const root = JsonValueSchema.parse(input);
    if (!isRecord(root)) {
      throw new McpReaderFailure(context.provenance.location.pointer ?? "", "MCP document must be an object");
    }
    const rootPointer = context.provenance.location.pointer ?? "";
    const wrappedKeys = [
      ...(Object.prototype.hasOwnProperty.call(root, "mcpServers") ? ["mcpServers"] : []),
      ...(Object.prototype.hasOwnProperty.call(root, "mcp_servers") ? ["mcp_servers"] : []),
    ];
    if (wrappedKeys.length > 1) {
      throw new McpReaderFailure(rootPointer, "MCP document cannot contain both wrapper spellings");
    }
    const wrapper = wrappedKeys[0];
    const shape = wrapper === undefined
      ? context.provenance.location.documentKind === "manifest" ? "inline-manifest-map" : "direct-map"
      : wrapper === "mcpServers" ? "claude-wrapped" : "codex-wrapped";
    const mapValue = wrapper === undefined ? root : root[wrapper]!;
    if (!isRecord(mapValue)) {
      throw new McpReaderFailure(
        wrapper === undefined ? rootPointer : childPointer(rootPointer, wrapper),
        "MCP server map must be an object",
      );
    }

    const components: McpServerComponent[] = [];
    for (const [nativeKey, declaration] of Object.entries(mapValue)) {
      const serverPointer = childPointer(
        wrapper === undefined ? rootPointer : childPointer(rootPointer, wrapper),
        nativeKey,
      );
      if (nativeKey.length === 0) {
        throw new McpReaderFailure(serverPointer, "MCP server keys cannot be empty");
      }
      if (!isRecord(declaration)) {
        throw new McpReaderFailure(serverPointer, "MCP server declarations must be JSON objects");
      }
      const provenance = sourceAt(context, serverPointer, declaration);
      components.push(McpServerComponentSchema.parse({
        kind: "mcp-server",
        id: stableComponentId(plugin, { kind: "mcp-server", nativeKey }),
        nativeKey: claim(nativeKey, provenance),
        // Deliberately do not interpret this object. In particular, command,
        // URL, auth, headers, env, and capabilities remain opaque JSON.
        declaration: claim(declaration, provenance),
        metadata: [metadata(context, shape, serverPointer)],
      }));
    }
    return {
      ok: true,
      value: deduplicateMcpComponents(components),
      diagnostics: [],
    };
  } catch (error) {
    return invalid(operation, context, error);
  }
}
