import { createHash } from "node:crypto";
import { createPluginInspectionService, type PluginInspectionService } from "../application/inspection-service.js";
import { BundleDocumentLimits, BundleDocumentLimitsSchema, type BundleDocumentLimitsContract } from "../application/inspection-contract.js";
import type { AgentSkillReaderContext, BundleReaderSet } from "../application/ports/bundle-readers.js";
import { createManifestContentReader } from "../infrastructure/filesystem/manifest-content-reader.js";
import { readBoundedYaml } from "../formats/agent-skills/frontmatter-reader.js";
import { readAgentSkill } from "../formats/agent-skills/skill-reader.js";
import { readClaudeHooks } from "../formats/claude/hook-reader.js";
import { readClaudePluginManifest } from "../formats/claude/manifest-reader.js";
import { readClaudeMcp } from "../formats/claude/mcp-reader.js";
import { readCodexHooks } from "../formats/codex/hook-reader.js";
import { readCodexPluginManifest } from "../formats/codex/manifest-reader.js";
import { readCodexMcp } from "../formats/codex/mcp-reader.js";
import { type Sha256 } from "../domain/source.js";
import type { HostPrecedence } from "../domain/host-precedence.js";

export type NodePluginInspectorOptions = Readonly<{
  limits?: Partial<BundleDocumentLimitsContract>;
  /** Resolves the user's canonical host order at call time; defaults to Claude-first. */
  hostPrecedence?: () => Promise<HostPrecedence>;
}>;

function sha256(bytes: Uint8Array): Uint8Array {
  return new Uint8Array(createHash("sha256").update(bytes).digest());
}

function frontmatterLimits(limits: BundleDocumentLimitsContract): NonNullable<AgentSkillReaderContext["limits"]> {
  return {
    maxDocumentBytes: limits.skillBytes,
    maxFrontmatterBytes: limits.frontmatterBytes,
    maxFrontmatterLines: limits.frontmatterLines,
    maxDepth: limits.frontmatterDepth,
    maxNodes: limits.frontmatterNodes,
    maxScalarBytes: limits.frontmatterScalarBytes,
  };
}

/**
 * The explicit Node composition root. Application code sees only ports; this
 * is the one place where Node I/O and all pure host readers are assembled.
 */
export function createNodePluginInspector(options: NodePluginInspectorOptions = {}): PluginInspectionService {
  const limits = BundleDocumentLimitsSchema.parse({ ...BundleDocumentLimits, ...(options.limits ?? {}) });
  const skillLimits = frontmatterLimits(limits);
  const hash: Sha256 = sha256;
  const readers: BundleReaderSet = {
    claudeManifest: readClaudePluginManifest,
    codexManifest: readCodexPluginManifest,
    claudeHooks: readClaudeHooks,
    codexHooks: readCodexHooks,
    claudeMcp: readClaudeMcp,
    codexMcp: readCodexMcp,
    agentSkill: (markdown, context) => readAgentSkill(markdown, context, hash, skillLimits),
    skillPresentation: (source, provenance, boundedLimits) => readBoundedYaml(source, provenance, boundedLimits),
  };
  return createPluginInspectionService({
    content: createManifestContentReader(hash),
    readers,
    sha256: hash,
    limits,
    ...(options.hostPrecedence === undefined ? {} : { hostPrecedence: options.hostPrecedence }),
  });
}