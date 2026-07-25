import type {
  ForeignComponent,
  HookComponent,
  McpServerComponent,
  SkillComponent,
} from "../../domain/components.js";
import type {
  PluginManifestClaims,
} from "../../domain/bundle-ingestion.js";
import type { NativeHost, Provenance } from "../../domain/provenance.js";
import type { JsonValue } from "../../domain/schema.js";
import type { PluginKey } from "../../domain/identity.js";
import type { ReadResult } from "../../domain/errors.js";

export type PluginManifestReaderContext = Readonly<{
  path: string;
  plugin: PluginKey;
}>;

export type PluginManifestReader = (
  input: unknown,
  context: PluginManifestReaderContext,
) => ReadResult<PluginManifestClaims>;

export type HookDocumentReaderContext = Readonly<{
  plugin: PluginKey;
  nativeHost: NativeHost;
  provenance: Provenance;
}>;

export type HookDocumentReader = (
  input: unknown,
  context: HookDocumentReaderContext,
) => ReadResult<readonly (HookComponent | ForeignComponent)[]>;

export type McpDocumentReaderContext = Readonly<{
  plugin: PluginKey;
  nativeHost: NativeHost;
  provenance: Provenance;
}>;

export type McpDocumentReader = (
  input: unknown,
  context: McpDocumentReaderContext,
) => ReadResult<readonly McpServerComponent[]>;

export type AgentSkillReaderContext = Readonly<{
  plugin: PluginKey;
  root: string;
  documentPath: string;
  provenance: Provenance;
  presentation?: JsonValue;
  /** Optional bounded-parser settings supplied by the composition root. */
  limits?: Readonly<{
    maxDocumentBytes: number;
    maxFrontmatterBytes: number;
    maxFrontmatterLines: number;
    maxDepth: number;
    maxNodes: number;
    maxScalarBytes: number;
  }>;
}>;

export type SkillPresentationReader = (
  source: string,
  provenance: Provenance,
  limits?: AgentSkillReaderContext["limits"],
) => ReadResult<JsonValue>;

export type AgentSkillReader = (
  markdown: string,
  context: AgentSkillReaderContext,
) => ReadResult<SkillComponent>;

/** Pure reader dependencies injected by the composition layer later. */
export interface BundleReaderSet {
  readonly claudeManifest: PluginManifestReader;
  readonly codexManifest: PluginManifestReader;
  readonly claudeHooks: HookDocumentReader;
  readonly codexHooks: HookDocumentReader;
  readonly claudeMcp: McpDocumentReader;
  readonly codexMcp: McpDocumentReader;
  readonly agentSkill: AgentSkillReader;
  /** Optional because unit callers may not need Codex presentation parsing. */
  readonly skillPresentation?: SkillPresentationReader;
}
