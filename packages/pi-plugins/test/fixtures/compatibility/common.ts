import { createHash } from "node:crypto";
import { createContentManifest, createMaterializationBinding, hashContent, type ContentManifestEntry } from "../../../src/domain/content-manifest.js";
import { RuntimeCapabilityRegistry, RuntimeCapabilitySnapshotSchema, type RuntimeCapabilitySnapshot } from "../../../src/domain/compatibility-policy.js";
import { createPluginInspectionService } from "../../../src/application/inspection-service.js";
import type { BundleReaderSet } from "../../../src/application/ports/bundle-readers.js";
import { readAgentSkill } from "../../../src/formats/agent-skills/skill-reader.js";
import { readBoundedYaml } from "../../../src/formats/agent-skills/frontmatter-reader.js";
import { readClaudeHooks } from "../../../src/formats/claude/hook-reader.js";
import { readClaudePluginManifest } from "../../../src/formats/claude/manifest-reader.js";
import { readClaudeMcp } from "../../../src/formats/claude/mcp-reader.js";
import { readClaudeMarketplace } from "../../../src/formats/claude/marketplace-reader.js";
import { readCodexHooks } from "../../../src/formats/codex/hook-reader.js";
import { readCodexPluginManifest } from "../../../src/formats/codex/manifest-reader.js";
import { readCodexMcp } from "../../../src/formats/codex/mcp-reader.js";
import { NormalizedPluginSchema, type NormalizedPlugin } from "../../../src/domain/plugin.js";
import { createResolvedPluginSource } from "../../../src/domain/source.js";
import type { Claimed } from "../../../src/domain/provenance.js";
import { claim, type Provenance } from "../../../src/domain/provenance.js";
import type { JsonValue } from "../../../src/domain/schema.js";
import type { MarketplaceInstallationPolicy } from "../../../src/domain/marketplace.js";
import type { BundleInspectionInput } from "../../../src/application/inspection-contract.js";

export const sha256 = (bytes: Uint8Array): Uint8Array =>
  new Uint8Array(createHash("sha256").update(bytes).digest());

export const text = (value: string): Uint8Array => new TextEncoder().encode(value);

export const fixtureProvenance = (
  path = ".claude-plugin/plugin.json",
  pointer = "/components",
  host: "claude" | "codex" = "claude",
  documentKind: "manifest" | "hooks" | "mcp" | "skill" | "convention" = "manifest",
): Provenance => ({
  location: { host, documentKind, path, pointer },
});

export function componentId(
  kind: "skill" | "hook" | "mcp-server" | "foreign",
  token: string,
): string {
  const hex = token.replace(/[^0-9a-f]/giu, "0").padEnd(1, "0");
  return `component-v1:${kind}:${hex.repeat(64).slice(0, 64)}`;
}

export function source() {
  return createResolvedPluginSource({
    kind: "git",
    url: "https://example.invalid/compatibility.git",
    revision: "a".repeat(40),
  }, sha256);
}

export function capabilities(
  overrides: Readonly<Record<string, "available" | "unavailable">> = {},
  explanations: Readonly<Record<string, string>> = {},
): RuntimeCapabilitySnapshot {
  return RuntimeCapabilitySnapshotSchema.parse({
    capabilities: Object.fromEntries(Object.values(RuntimeCapabilityRegistry).map((entry) => [
      entry.id,
      {
        status: overrides[entry.id] ?? "available",
        explanation: explanations[entry.id] ?? `${entry.id} fixture capability`,
      },
    ])),
    capturedBy: "compatibility-fixture",
  });
}

export function directPlugin(
  overrides: Readonly<{
    components?: Readonly<{
      skills?: readonly unknown[];
      hooks?: readonly unknown[];
      mcpServers?: readonly unknown[];
      foreign?: readonly unknown[];
    }>;
    configuration?: unknown;
    metadata?: readonly unknown[];
    identity?: Readonly<Record<string, unknown>>;
  }> = {},
): NormalizedPlugin {
  return NormalizedPluginSchema.parse({
    identity: {
      key: "fixture@compatibility",
      marketplaceName: "compatibility",
      marketplaceEntryName: "fixture",
      ...overrides.identity,
    },
    source: source(),
    configuration: overrides.configuration ?? { options: [] },
    components: {
      skills: overrides.components?.skills ?? [],
      hooks: overrides.components?.hooks ?? [],
      mcpServers: overrides.components?.mcpServers ?? [],
      foreign: overrides.components?.foreign ?? [],
    },
    metadata: overrides.metadata ?? [],
  });
}

export type PolicyRequirementExpectation = Readonly<{
  id: string;
  status: "available" | "unavailable";
}>;

export type PolicyOutcome = Readonly<{
  componentVerdicts: readonly ("supported" | "incompatible")[];
  activatable: boolean;
  diagnosticCodes: readonly string[];
  diagnosticRuleIds: readonly string[];
  requirements: readonly PolicyRequirementExpectation[];
  diagnosticSourcePointers: readonly string[];
}>;

export function expectedRequirement(
  kind: "skill" | "hook" | "mcp-server" | "foreign",
  token: string,
  capability: string,
  status: PolicyRequirementExpectation["status"] = "available",
): PolicyRequirementExpectation {
  const id = `requirement-v1:${capability}:${componentId(kind, token)}`;
  return { id, status };
}

export function expectedOutcome(
  componentVerdicts: readonly ("supported" | "metadata-only" | "incompatible")[],
  activatable: boolean,
  options: Readonly<Partial<Omit<PolicyOutcome, "componentVerdicts" | "activatable">>> = {},
): PolicyOutcome {
  return {
    componentVerdicts,
    activatable,
    diagnosticCodes: [],
    diagnosticRuleIds: [],
    requirements: [],
    diagnosticSourcePointers: [],
    ...options,
  };
}

export type PolicyFixture = Readonly<{
  id: string;
  ruleId: string;
  positive: () => NormalizedPlugin;
  negative: () => NormalizedPlugin;
  positiveVerdict: "supported" | "metadata-only" | "incompatible";
  positiveExpected: PolicyOutcome;
  negativeExpected: PolicyOutcome;
  positivePolicy?: unknown;
  negativePolicy?: unknown;
  diagnosticRuleId?: string;
}>;

export type RawBundleFixture = Readonly<{
  manifest?: Readonly<Record<string, JsonValue>>;
  skillMarkdown?: string;
  skillPresentation?: string;
  hooks?: JsonValue;
  mcpServers?: JsonValue;
  marketplacePolicy?: Readonly<{ installation: "AVAILABLE" | "INSTALLED_BY_DEFAULT" | "NOT_AVAILABLE"; authentication?: string }>;
  marketplaceMetadata?: Readonly<Record<string, JsonValue>>;
}>;

function filesFor(spec: RawBundleFixture): ReadonlyMap<string, Uint8Array> {
  const manifest: Record<string, JsonValue> = {
    name: "fixture",
    ...(spec.skillMarkdown === undefined ? {} : { skills: "./skills" }),
    ...(spec.hooks === undefined ? {} : { hooks: spec.hooks }),
    ...(spec.mcpServers === undefined ? {} : { mcpServers: spec.mcpServers }),
    ...(spec.manifest ?? {}),
  };
  const files = new Map<string, Uint8Array>([
    [".claude-plugin/plugin.json", text(JSON.stringify(manifest))],
  ]);
  if (spec.skillMarkdown !== undefined) {
    files.set("skills/demo/SKILL.md", text(spec.skillMarkdown));
  }
  if (spec.skillPresentation !== undefined) {
    files.set("skills/demo/agents/openai.yaml", text(spec.skillPresentation));
  }
  return files;
}

function contentManifest(files: ReadonlyMap<string, Uint8Array>) {
  const directories = new Set<string>();
  for (const path of files.keys()) {
    const segments = path.split("/");
    for (let index = 1; index < segments.length; index += 1) {
      directories.add(segments.slice(0, index).join("/"));
    }
  }
  const entries: ContentManifestEntry[] = [
    ...[...directories].sort().map((path) => ({ kind: "directory" as const, path, mode: 0o755 as const })),
    ...[...files.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([path, bytes]) => ({
      kind: "file" as const,
      path,
      mode: 0o644 as const,
      size: bytes.byteLength,
      digest: hashContent(bytes, sha256),
    })),
  ];
  return createContentManifest(entries, sha256);
}

function readers(): BundleReaderSet {
  return {
    claudeManifest: readClaudePluginManifest,
    codexManifest: readCodexPluginManifest,
    claudeHooks: readClaudeHooks,
    codexHooks: readCodexHooks,
    claudeMcp: readClaudeMcp,
    codexMcp: readCodexMcp,
    agentSkill: (markdown, context) => readAgentSkill(markdown, context, sha256),
    skillPresentation: readBoundedYaml,
  };
}

function marketplaceEntryFor(spec: RawBundleFixture) {
  return readClaudeMarketplace({
    name: "compatibility",
    plugins: [{
      name: "fixture",
      source: "./plugin",
      strict: false,
      ...(spec.marketplacePolicy === undefined ? {} : { policy: spec.marketplacePolicy }),
      ...(spec.marketplaceMetadata ?? {}),
    }],
  }).marketplace.entries[0];
}

export function marketplacePolicyForFixture(spec: RawBundleFixture): MarketplaceInstallationPolicy | undefined {
  return marketplaceEntryFor(spec)?.policy;
}

export async function inspectNormalizedBundle(spec: RawBundleFixture): Promise<NormalizedPlugin> {
  const files = filesFor(spec);
  const marketplaceEntry = marketplaceEntryFor(spec);
  if (marketplaceEntry === undefined) throw new Error("compatibility marketplace fixture did not produce an entry");

  const declaredSource = marketplaceEntry.source.value;
  if (declaredSource.kind !== "marketplace-path") throw new Error("compatibility fixture is not a marketplace path");
  const materializedSource = createResolvedPluginSource({
    kind: "marketplace-path",
    marketplaceRevision: "b".repeat(40),
    path: declaredSource.path,
  }, sha256);
  const manifest = contentManifest(files);
  const input: BundleInspectionInput = {
    entry: marketplaceEntry,
    materialized: {
      root: "/virtual/compatibility-fixture",
      source: materializedSource,
      content: manifest,
      binding: createMaterializationBinding(materializedSource.hash, manifest.rootDigest, sha256),
    },
  };
  const service = createPluginInspectionService({
    content: {
      async readFile(file) {
        const bytes = files.get(file.entry.path);
        if (bytes === undefined) throw new Error(`missing compatibility fixture file ${file.entry.path}`);
        return bytes;
      },
    },
    readers: readers(),
    sha256,
  });
  const result = await service.inspect(input, new AbortController().signal);
  if (!result.ok) {
    throw new Error(`compatibility fixture ingestion failed: ${result.diagnostics.map((item) => item.message).join("; ")}`);
  }
  return result.value;
}

export function claimFixture<T>(value: T, provenance = fixtureProvenance()): Claimed<T> {
  return claim(value, provenance);
}

export type { MarketplaceInstallationPolicy };
