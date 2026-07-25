import { z } from "zod";
import {
  ComponentKindRegistry,
  flattenComponents,
  type Component,
  type PluginComponents,
} from "./components.js";
import {
  type ConfigurationOption,
} from "./configuration.js";
import { CompatibilityReportSchema, type CompatibilityReport } from "./compatibility.js";
import { ContentDigestSchema, hashContent, type ContentDigest } from "./content-manifest.js";
import { NormalizedPluginSchema, type NormalizedPlugin } from "./plugin.js";
import type { Sha256 } from "./source.js";

/**
 * The fields in a trust surface are deliberately not the whole normalized
 * component. Provenance and presentation metadata can change without changing
 * what will execute. This registry is the single place where executable
 * variants, their safe identity, and their digest projection are defined.
 */
const SkillTrustEntrySchema = z.object({
  kind: z.literal(ComponentKindRegistry.skill.tag),
  id: z.string().min(1),
  name: z.string().min(1),
  root: z.string().min(1),
}).strict().readonly();

const HookTrustEntrySchema = z.object({
  kind: z.literal(ComponentKindRegistry.hook.tag),
  id: z.string().min(1),
  event: z.string().min(1),
  matcher: z.string().optional(),
  handler: z.unknown(),
}).strict().readonly();

const McpTrustEntrySchema = z.object({
  kind: z.literal(ComponentKindRegistry.mcpServer.tag),
  id: z.string().min(1),
  nativeKey: z.string().min(1),
  declaration: z.unknown(),
}).strict().readonly();

/** Configuration defaults are intentionally excluded from this projection. */
const ConfigurationTrustEntrySchema = z.object({
  kind: z.literal("configuration"),
  key: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
  valueKind: z.string().min(1),
  required: z.boolean(),
  sensitive: z.boolean(),
  constraints: z.record(z.string(), z.unknown()),
}).strict().readonly();

export const ExecutableSurfaceKindRegistry = {
  skill: { tag: "skill", schema: SkillTrustEntrySchema },
  hook: { tag: "hook", schema: HookTrustEntrySchema },
  mcpServer: { tag: "mcp-server", schema: McpTrustEntrySchema },
  configuration: { tag: "configuration", schema: ConfigurationTrustEntrySchema },
} as const;

type ExecutableSurfaceRegistry = typeof ExecutableSurfaceKindRegistry;
type ExecutableSurfaceSchemaMap = {
  [K in keyof ExecutableSurfaceRegistry]: ExecutableSurfaceRegistry[K]["schema"];
};

function schemaValues<T extends Record<string, z.ZodTypeAny>>(
  registry: T,
): [T[keyof T], ...T[keyof T][]] {
  const values = Object.values(registry) as T[keyof T][];
  if (values.length === 0) throw new Error("executable surface registry cannot be empty");
  return values as [T[keyof T], ...T[keyof T][]];
}

const executableSurfaceSchemas: ExecutableSurfaceSchemaMap = {
  skill: SkillTrustEntrySchema,
  hook: HookTrustEntrySchema,
  mcpServer: McpTrustEntrySchema,
  configuration: ConfigurationTrustEntrySchema,
};

export const ExecutableSurfaceEntrySchema = z.discriminatedUnion(
  "kind",
  schemaValues(executableSurfaceSchemas),
).readonly();
export type ExecutableSurfaceEntry = z.infer<typeof ExecutableSurfaceEntrySchema>;

export const ExecutableSurfaceSchema = z.object({
  version: z.literal("executable-surface-v1"),
  entries: z.array(ExecutableSurfaceEntrySchema).readonly(),
}).strict().readonly();
export type ExecutableSurface = z.infer<typeof ExecutableSurfaceSchema>;

function utf8Compare(left: string, right: string): number {
  const encoder = new TextEncoder();
  const a = encoder.encode(left);
  const b = encoder.encode(right);
  const length = Math.min(a.byteLength, b.byteLength);
  for (let index = 0; index < length; index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return a.byteLength - b.byteLength;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(object).sort(utf8Compare).map((key) => [key, canonicalize(object[key])]),
    );
  }
  return value;
}

function sortEntries(entries: readonly ExecutableSurfaceEntry[]): ExecutableSurfaceEntry[] {
  const kindOrder = new Map<string, number>([
    [ExecutableSurfaceKindRegistry.skill.tag, 0],
    [ExecutableSurfaceKindRegistry.hook.tag, 1],
    [ExecutableSurfaceKindRegistry.mcpServer.tag, 2],
    [ExecutableSurfaceKindRegistry.configuration.tag, 3],
  ]);
  return [...entries].sort((left, right) => {
    const kindDifference = (kindOrder.get(left.kind) ?? Number.MAX_SAFE_INTEGER) -
      (kindOrder.get(right.kind) ?? Number.MAX_SAFE_INTEGER);
    if (kindDifference !== 0) return kindDifference;
    const leftIdentity = entryIdentity(left);
    const rightIdentity = entryIdentity(right);
    return utf8Compare(leftIdentity, rightIdentity);
  });
}

function entryIdentity(entry: ExecutableSurfaceEntry): string {
  switch (entry.kind) {
    case "skill":
    case "hook":
    case "mcp-server":
      return entry.id;
    case "configuration":
      return entry.key;
    default:
      return assertNever(entry);
  }
}

function componentEntries(components: PluginComponents): ExecutableSurfaceEntry[] {
  const entries: ExecutableSurfaceEntry[] = [];
  for (const component of flattenComponents(components)) {
    switch (component.kind) {
      case "skill":
        entries.push({
          kind: "skill",
          id: component.id,
          name: component.name.value,
          root: component.root.value,
        });
        break;
      case "hook":
        entries.push({
          kind: "hook",
          id: component.id,
          event: component.event.value,
          ...(component.matcher === undefined ? {} : { matcher: component.matcher.value }),
          handler: canonicalize(component.handler.value),
        });
        break;
      case "mcp-server":
        entries.push({
          kind: "mcp-server",
          id: component.id,
          nativeKey: component.nativeKey.value,
          declaration: canonicalize(component.declaration.value),
        });
        break;
      case "foreign":
        // Foreign declarations are compatibility evidence, not executable
        // Pi components. An incompatible foreign component is rejected by the
        // complete compatibility check before this projection is built.
        break;
      default:
        assertNever(component);
    }
  }
  return entries;
}

function optionEntry(option: ConfigurationOption): ExecutableSurfaceEntry {
  const { kind: _kind, default: _default, ...constraints } = option.value;
  return {
    kind: "configuration",
    key: option.key,
    valueKind: option.value.kind,
    required: option.required,
    sensitive: option.sensitive,
    constraints: canonicalize(constraints) as Record<string, unknown>,
  };
}

function samePluginIdentity(plugin: NormalizedPlugin, report: CompatibilityReport): boolean {
  return plugin.identity.key === report.plugin.key &&
    plugin.identity.marketplaceName === report.plugin.marketplaceName &&
    plugin.identity.marketplaceEntryName === report.plugin.marketplaceEntryName &&
    plugin.identity.manifestName === report.plugin.manifestName;
}

function assertCompleteCompatibility(
  plugin: NormalizedPlugin,
  report: CompatibilityReport,
): void {
  if (!samePluginIdentity(plugin, report)) {
    throw new Error("compatibility report identity does not match plugin");
  }
  const componentIds = new Set(flattenComponents(plugin.components).map((component) => component.id));
  const assessedIds = new Set(report.components.map((component) => component.componentId));
  if (componentIds.size !== assessedIds.size || [...componentIds].some((id) => !assessedIds.has(id))) {
    throw new Error("compatibility report does not cover the complete plugin inventory");
  }
  if (!report.activatable) {
    throw new Error("plugin compatibility report is not activatable");
  }
}

/** Build the canonical, safe-to-hash executable surface for a complete bundle. */
export function createExecutableSurface(
  plugin: NormalizedPlugin,
  report: CompatibilityReport,
): ExecutableSurface {
  const validPlugin = NormalizedPluginSchema.parse(plugin);
  const validReport = CompatibilityReportSchema.parse(report);
  assertCompleteCompatibility(validPlugin, validReport);
  const entries = [
    ...componentEntries(validPlugin.components),
    ...validPlugin.configuration.options.map(optionEntry),
  ];
  return ExecutableSurfaceSchema.parse({
    version: "executable-surface-v1",
    entries: sortEntries(entries),
  });
}

/** Hash exactly the registry-owned canonical surface representation. */
export function digestExecutableSurface(
  surface: ExecutableSurface,
  sha256: Sha256,
): ContentDigest {
  const valid = ExecutableSurfaceSchema.parse(surface);
  const canonical = JSON.stringify(canonicalize(valid));
  return ContentDigestSchema.parse(hashContent(
    new TextEncoder().encode(`executable-surface-v1\0${canonical}`),
    sha256,
  ));
}

export function verifyExecutableSurface(
  surface: unknown,
  sha256: Sha256,
): ExecutableSurface {
  const valid = ExecutableSurfaceSchema.parse(surface);
  const sorted = sortEntries(valid.entries);
  if (JSON.stringify(sorted) !== JSON.stringify(valid.entries)) {
    throw new Error("executable surface entries are not canonical");
  }
  return valid;
}

function assertNever(value: never): never {
  throw new Error(`unhandled executable surface variant: ${String(value)}`);
}

export type { Component };
export {
  SkillTrustEntrySchema,
  HookTrustEntrySchema,
  McpTrustEntrySchema,
  ConfigurationTrustEntrySchema,
};
