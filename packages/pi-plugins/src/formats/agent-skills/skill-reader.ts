import { z } from "zod";
import {
  ComponentKindRegistry,
  RetainedMetadataSchema,
  SkillComponentSchema,
  type RetainedMetadata,
  type SkillComponent,
} from "../../domain/components.js";
import { deriveComponentId } from "../../domain/component-identity.js";
import {
  DiagnosticSchema,
  ErrorCodeRegistry,
  type ReadResult,
} from "../../domain/errors.js";
import { PluginKeySchema, type PluginKey } from "../../domain/identity.js";
import { claim, ProvenanceSchema, type Provenance } from "../../domain/provenance.js";
import { JsonValueSchema, type JsonValue } from "../../domain/schema.js";
import { type Sha256 } from "../../domain/source.js";
import {
  readBoundedFrontmatter,
  readBoundedYaml,
  type FrontmatterLimits,
} from "./frontmatter-reader.js";

export type AgentSkillReaderContext = Readonly<{
  plugin: PluginKey;
  root: string;
  documentPath: string;
  provenance: Provenance;
  presentation?: JsonValue;
}>;

export type AgentSkillReader = (
  markdown: string,
  context: AgentSkillReaderContext,
) => ReadResult<SkillComponent>;

const prototypeKeys = new Set(["__proto__", "prototype", "constructor"]);

const KnownSkillFrontmatterSchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
  license: z.string().min(1).optional(),
  compatibility: z.string().min(1).optional(),
  metadata: z.record(z.string(), z.string()).optional(),
  "allowed-tools": z.string().optional(),
  "disable-model-invocation": z.boolean().optional(),
}).strict();

function pointerSegment(value: string): string {
  return value.replaceAll("~", "~0").replaceAll("/", "~1");
}

function sourceAt(
  context: AgentSkillReaderContext,
  pointer: string,
  declaration?: JsonValue,
  overrides: Readonly<{ host?: "claude" | "codex"; path?: string; documentKind?: "skill" | "convention" }> = {},
): Provenance {
  const base = ProvenanceSchema.parse(context.provenance);
  return ProvenanceSchema.parse({
    location: {
      ...base.location,
      host: overrides.host ?? base.location.host,
      path: overrides.path ?? context.documentPath,
      documentKind: overrides.documentKind ?? "skill",
      pointer,
    },
    ...(declaration === undefined ? {} : { declaration }),
  });
}

function invalid(
  operation: string,
  provenance: Provenance,
  error: unknown,
): ReadResult<never> {
  const validProvenance = ProvenanceSchema.parse(provenance);
  const message = error instanceof Error ? error.message : String(error);
  const details = error instanceof z.ZodError
    ? {
        issues: error.issues.map((issue) => ({
          code: issue.code,
          path: issue.path.map(String),
          message: issue.message,
        })),
      }
    : undefined;
  return {
    ok: false,
    diagnostics: [DiagnosticSchema.parse({
      code: ErrorCodeRegistry.schemaInvalid,
      severity: "error",
      operation,
      message,
      location: validProvenance.location,
      ...(details === undefined ? {} : { details }),
    })],
  };
}

function canonicalRoot(root: unknown): string {
  if (typeof root !== "string" || root.length === 0) {
    throw new TypeError("skill root must be a non-empty relative path");
  }
  if (root.includes("\\") || root.includes("\0") || root.startsWith("/")) {
    throw new TypeError("skill root must be a relative slash path");
  }
  const withPrefix = root.startsWith("./") ? root.slice(2) : root;
  if (withPrefix === "" || withPrefix === ".") return ".";
  const segments = withPrefix.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    throw new TypeError("skill root contains an unsafe path segment");
  }
  return segments.join("/");
}

function canonicalDocumentPath(path: unknown): string {
  if (typeof path !== "string" || path.length === 0 || path.includes("\\") || path.includes("\0") || path.startsWith("/")) {
    throw new TypeError("skill document path must be a relative slash path");
  }
  const withoutPrefix = path.startsWith("./") ? path.slice(2) : path;
  const segments = withoutPrefix.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    throw new TypeError("skill document path contains an unsafe path segment");
  }
  return segments.join("/");
}

function expectedSkillPath(root: string): string {
  return root === "." ? "SKILL.md" : `${root}/SKILL.md`;
}

function metadata(
  key: string,
  value: JsonValue,
  provenance: Provenance,
): RetainedMetadata {
  return RetainedMetadataSchema.parse({ key, claimed: claim(value, provenance) });
}

function boundedPresentation(
  presentation: JsonValue,
  context: AgentSkillReaderContext,
  limits?: Partial<FrontmatterLimits>,
): JsonValue {
  const valid = JsonValueSchema.parse(presentation);
  const serialized = JSON.stringify(valid);
  if (serialized === undefined) throw new TypeError("Codex presentation is not JSON-compatible");
  // Parsing from bounded YAML is the normal path. The JSON walk here keeps
  // callers that already parsed presentation data under the same limits.
  const result = readBoundedYaml(serialized, sourceAt(
    context,
    "",
    valid,
    {
      host: "codex",
      path: context.root === "." ? "agents/openai.yaml" : `${canonicalRoot(context.root)}/agents/openai.yaml`,
      documentKind: "convention",
    },
  ), limits);
  if (!result.ok) throw new TypeError(result.diagnostics[0]?.message ?? "Codex presentation is invalid");
  return result.value;
}

function normalizeSkillFrontmatter(
  attributes: JsonValue,
  context: AgentSkillReaderContext,
): Readonly<{ name: string; metadata: RetainedMetadata[] }> {
  if (attributes === null || typeof attributes !== "object" || Array.isArray(attributes)) {
    throw new TypeError("Agent Skills frontmatter must be a mapping");
  }
  const record = attributes as { readonly [key: string]: JsonValue };
  const parsed = KnownSkillFrontmatterSchema.parse({
    name: record.name,
    description: record.description,
    ...(record.license === undefined ? {} : { license: record.license }),
    ...(record.compatibility === undefined ? {} : { compatibility: record.compatibility }),
    ...(record.metadata === undefined ? {} : { metadata: record.metadata }),
    ...(record["allowed-tools"] === undefined ? {} : { "allowed-tools": record["allowed-tools"] }),
    ...(record["disable-model-invocation"] === undefined
      ? {}
      : { "disable-model-invocation": record["disable-model-invocation"] }),
  });

  const metadataValues: RetainedMetadata[] = [];
  for (const field of Object.keys(record).sort()) {
    if (prototypeKeys.has(field)) throw new TypeError(`unsafe Agent Skills field: ${field}`);
    if (field === "name") continue;
    metadataValues.push(metadata(
      `agent-skills.${field}`,
      record[field]!,
      sourceAt(context, `/${pointerSegment(field)}`, record[field]),
    ));
  }
  // The parsed object is deliberately used for validation only. Retaining the
  // original null-prototype values avoids reintroducing a prototype-bearing
  // tree after the safe YAML conversion.
  void parsed;
  return { name: record.name as string, metadata: metadataValues };
}

/** Parse an optional bounded Codex `agents/openai.yaml` presentation document. */
export function readCodexSkillPresentation(
  source: string,
  provenance: Provenance,
  limits?: Partial<FrontmatterLimits>,
): ReadResult<JsonValue> {
  return readBoundedYaml(source, provenance, limits);
}

export function readAgentSkill(
  markdown: string,
  context: AgentSkillReaderContext,
  sha256: Sha256,
  limits?: Partial<FrontmatterLimits>,
): ReadResult<SkillComponent> {
  const operation = "readAgentSkill";
  try {
    const plugin = PluginKeySchema.parse(context.plugin);
    const root = canonicalRoot(context.root);
    const documentPath = canonicalDocumentPath(context.documentPath);
    if (documentPath !== expectedSkillPath(root)) {
      throw new TypeError("skill document must be the manifest-indexed SKILL.md beneath its declared root");
    }
    const provenance = sourceAt({ ...context, root, documentPath }, "");
    const frontmatter = readBoundedFrontmatter(markdown, provenance, limits);
    if (!frontmatter.ok) return frontmatter;
    const normalized = normalizeSkillFrontmatter(frontmatter.value.attributes, { ...context, root, documentPath });
    const presentationMetadata: RetainedMetadata[] = [];
    if (context.presentation !== undefined) {
      const presentation = boundedPresentation(context.presentation, { ...context, root, documentPath }, limits);
      if (presentation !== null && typeof presentation === "object" && !Array.isArray(presentation)) {
        const presentationRecord = presentation as { readonly [key: string]: JsonValue };
        for (const field of Object.keys(presentationRecord).sort()) {
          if (prototypeKeys.has(field)) throw new TypeError(`unsafe Codex presentation field: ${field}`);
          presentationMetadata.push(metadata(
            `codex.agents.${field}`,
            presentationRecord[field]!,
            sourceAt(
              { ...context, root, documentPath },
              `/${pointerSegment(field)}`,
              presentationRecord[field],
              {
                host: "codex",
                path: root === "." ? "agents/openai.yaml" : `${root}/agents/openai.yaml`,
                documentKind: "convention",
              },
            ),
          ));
        }
      } else {
        presentationMetadata.push(metadata(
          "codex.agents.presentation",
          presentation,
          sourceAt(
            { ...context, root, documentPath },
            "",
            presentation,
            {
              host: "codex",
              path: root === "." ? "agents/openai.yaml" : `${root}/agents/openai.yaml`,
              documentKind: "convention",
            },
          ),
        ));
      }
    }

    const id = deriveComponentId(plugin, {
      kind: ComponentKindRegistry.skill.tag,
      root,
    }, sha256);
    const skill = SkillComponentSchema.parse({
      kind: ComponentKindRegistry.skill.tag,
      id,
      name: claim(normalized.name, sourceAt(
        { ...context, root, documentPath },
        "/name",
        normalized.name,
      )),
      root: claim(root, sourceAt(
        { ...context, root, documentPath },
        "",
        root,
      )),
      metadata: [...normalized.metadata, ...presentationMetadata],
    });
    return { ok: true, value: skill, diagnostics: [] };
  } catch (error) {
    return invalid(operation, context.provenance, error);
  }
}
