import YAML, {
  isAlias,
  isMap,
  isNode,
  isScalar,
  isSeq,
  type Node,
  type YAMLMap,
  type YAMLSeq,
} from "yaml";
import {
  DiagnosticSchema,
  ErrorCodeRegistry,
  type ReadResult,
} from "../../domain/errors.js";
import { ProvenanceSchema, type Provenance } from "../../domain/provenance.js";
import { type JsonValue } from "../../domain/schema.js";

export type FrontmatterLimits = Readonly<{
  maxDocumentBytes: number;
  maxFrontmatterBytes: number;
  maxFrontmatterLines: number;
  maxDepth: number;
  maxNodes: number;
  maxScalarBytes: number;
}>;

export const DEFAULT_FRONTMATTER_LIMITS: FrontmatterLimits = Object.freeze({
  maxDocumentBytes: 1024 * 1024,
  maxFrontmatterBytes: 16 * 1024,
  maxFrontmatterLines: 256,
  maxDepth: 8,
  maxNodes: 256,
  maxScalarBytes: 8 * 1024,
});

const unsafeKeys = new Set(["__proto__", "prototype", "constructor"]);

type BoundedYamlResult = Readonly<{
  attributes: JsonValue;
  source: string;
}>;

class FrontmatterFailure extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = "FrontmatterFailure";
  }
}

function validLimit(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
  return value;
}

function resolveLimits(input?: Partial<FrontmatterLimits>): FrontmatterLimits {
  const merged = { ...DEFAULT_FRONTMATTER_LIMITS, ...(input ?? {}) };
  for (const [name, value] of Object.entries(merged)) validLimit(name, value);
  return Object.freeze(merged);
}

function utf8Length(value: string, start = 0, end = value.length, limit?: number): number {
  let bytes = 0;
  for (let index = start; index < end; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff || index + 1 >= end) {
        throw new FrontmatterFailure("document contains invalid UTF-8 (lone surrogate)");
      }
      bytes += 4;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new FrontmatterFailure("document contains invalid UTF-8 (lone surrogate)");
    } else if (code <= 0x7f) {
      bytes += 1;
    } else if (code <= 0x7ff) {
      bytes += 2;
    } else {
      bytes += 3;
    }
    if (limit !== undefined && bytes > limit) return bytes;
  }
  return bytes;
}

function rejectDocumentEncoding(value: unknown, limits: FrontmatterLimits): string {
  if (typeof value !== "string") {
    throw new FrontmatterFailure("document must be a UTF-8 string");
  }
  if (value.includes("\ufeff")) {
    throw new FrontmatterFailure("BOM characters are not permitted in YAML documents");
  }
  const bytes = utf8Length(value, 0, value.length, limits.maxDocumentBytes);
  if (bytes > limits.maxDocumentBytes) {
    throw new FrontmatterFailure("document byte limit exceeded");
  }
  return value;
}

function lineIs(value: string, start: number, end: number, expected: string): boolean {
  let actualEnd = end;
  if (actualEnd > start && value.charCodeAt(actualEnd - 1) === 0x0d) actualEnd -= 1;
  if (actualEnd - start !== expected.length) return false;
  for (let index = 0; index < expected.length; index += 1) {
    if (value.charCodeAt(start + index) !== expected.charCodeAt(index)) return false;
  }
  return true;
}

function locateFrontmatter(
  markdown: string,
  limits: FrontmatterLimits,
): Readonly<{ source: string; body: string }> {
  const firstNewline = markdown.indexOf("\n");
  if (firstNewline < 0 || !lineIs(markdown, 0, firstNewline, "---")) {
    throw new FrontmatterFailure("skill must begin with a YAML frontmatter delimiter");
  }

  const sourceStart = firstNewline + 1;
  let cursor = sourceStart;
  let lines = 0;
  while (cursor <= markdown.length) {
    const newline = markdown.indexOf("\n", cursor);
    const lineEnd = newline < 0 ? markdown.length : newline;
    if (lineIs(markdown, cursor, lineEnd, "---")) {
      const sourceBytes = utf8Length(markdown, sourceStart, cursor, limits.maxFrontmatterBytes);
      if (sourceBytes > limits.maxFrontmatterBytes) {
        throw new FrontmatterFailure("frontmatter byte limit exceeded");
      }
      const source = markdown.slice(sourceStart, cursor);
      const bodyStart = newline < 0 ? markdown.length : newline + 1;
      return { source, body: markdown.slice(bodyStart) };
    }

    if (lineIs(markdown, cursor, lineEnd, "...")) {
      throw new FrontmatterFailure("multi-document YAML markers are not permitted");
    }
    lines += 1;
    if (lines > limits.maxFrontmatterLines) {
      throw new FrontmatterFailure("frontmatter line limit exceeded");
    }
    // Check each line before slicing the complete frontmatter source. The
    // document-wide scan above has already rejected lone surrogates.
    const currentBytes = utf8Length(markdown, cursor, lineEnd);
    if (currentBytes > limits.maxFrontmatterBytes) {
      throw new FrontmatterFailure("frontmatter byte limit exceeded");
    }
    if (newline < 0) {
      throw new FrontmatterFailure("frontmatter closing delimiter is missing");
    }
    cursor = newline + 1;
  }

  throw new FrontmatterFailure("frontmatter closing delimiter is missing");
}

function nodeHasForbiddenDecoration(node: Node): boolean {
  return isNode(node) && (node.tag !== undefined || "anchor" in node && Boolean(node.anchor));
}

function scalarValue(node: Node, limits: FrontmatterLimits): JsonValue {
  if (!isScalar(node)) throw new FrontmatterFailure("YAML scalar node is invalid");
  if (nodeHasForbiddenDecoration(node)) {
    throw new FrontmatterFailure("YAML anchors and explicit tags are not permitted");
  }
  const value = node.value;
  const source = typeof node.source === "string" ? node.source : undefined;
  if (source !== undefined && utf8Length(source, 0, source.length, limits.maxScalarBytes) > limits.maxScalarBytes) {
    throw new FrontmatterFailure("YAML scalar byte limit exceeded");
  }
  if (typeof value === "string") {
    if (utf8Length(value, 0, value.length, limits.maxScalarBytes) > limits.maxScalarBytes) {
      throw new FrontmatterFailure("YAML scalar byte limit exceeded");
    }
    return value;
  }
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  throw new FrontmatterFailure("YAML contains a non-JSON scalar");
}

function convertNode(
  node: Node,
  depth: number,
  state: Readonly<{ limits: FrontmatterLimits; count: { value: number } }>,
): JsonValue {
  state.count.value += 1;
  if (state.count.value > state.limits.maxNodes) {
    throw new FrontmatterFailure("YAML node limit exceeded");
  }
  if (depth > state.limits.maxDepth) {
    throw new FrontmatterFailure("YAML nesting depth limit exceeded");
  }
  if (isAlias(node)) {
    throw new FrontmatterFailure("YAML aliases are not permitted");
  }
  if (nodeHasForbiddenDecoration(node)) {
    throw new FrontmatterFailure("YAML anchors and explicit tags are not permitted");
  }
  if (isScalar(node)) return scalarValue(node, state.limits);

  if (isSeq(node)) {
    const result: JsonValue[] = [];
    for (const item of (node as YAMLSeq<Node>).items) {
      result.push(item === null ? null : convertNode(item, depth + 1, state));
    }
    return result;
  }

  if (isMap(node)) {
    const result = Object.create(null) as Record<string, JsonValue>;
    const seen = new Set<string>();
    for (const pair of (node as YAMLMap<Node, Node>).items) {
      if (!isScalar(pair.key)) {
        throw new FrontmatterFailure("YAML mapping keys must be strings");
      }
      const key = scalarValue(pair.key, state.limits);
      if (typeof key !== "string") {
        throw new FrontmatterFailure("YAML mapping keys must be strings");
      }
      if (unsafeKeys.has(key)) {
        throw new FrontmatterFailure(`YAML mapping key is unsafe: ${key}`);
      }
      if (key === "<<") {
        throw new FrontmatterFailure("YAML merge keys are not permitted");
      }
      if (seen.has(key)) {
        throw new FrontmatterFailure(`duplicate YAML mapping key: ${key}`);
      }
      seen.add(key);
      result[key] = pair.value === null
        ? null
        : convertNode(pair.value, depth + 1, state);
    }
    return result;
  }

  throw new FrontmatterFailure("YAML node is not JSON-compatible");
}

function isBlockScalarIndicator(line: string, index: number): boolean {
  const suffix = line.slice(index);
  if (!/^[|>](?:(?:[1-9][+-]?)|(?:[+-][1-9]?))?\s*(?:#.*)?$/u.test(suffix)) return false;
  const prefix = line.slice(0, index).trimEnd();
  return prefix.length === 0 || prefix.endsWith(":") || prefix.endsWith("-");
}

function rejectExcessiveFlowNesting(source: string, maxDepth: number): void {
  let depth = 0;
  let quote: "single" | "double" | undefined;
  let escaped = false;
  let blockParentIndent: number | undefined;
  for (const line of source.split("\n")) {
    const indent = /^ */u.exec(line)?.[0].length ?? 0;
    if (blockParentIndent !== undefined) {
      if (line.trim().length === 0 || indent > blockParentIndent) continue;
      blockParentIndent = undefined;
    }
    for (let index = 0; index < line.length; index += 1) {
      const character = line[index]!;
      if (quote === "double") {
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === '"') quote = undefined;
        continue;
      }
      if (quote === "single") {
        if (character !== "'") continue;
        if (line[index + 1] === "'") index += 1;
        else quote = undefined;
        continue;
      }
      if (character === '"') {
        quote = "double";
        continue;
      }
      if (character === "'") {
        quote = "single";
        continue;
      }
      if (character === "#" && (index === 0 || /\s/u.test(line[index - 1]!))) break;
      if ((character === "|" || character === ">") && isBlockScalarIndicator(line, index)) {
        blockParentIndent = indent;
        break;
      }
      if (character === "[" || character === "{") {
        depth += 1;
        // yaml's compose phase was historically recursive. Rejecting at the
        // lexical boundary keeps hostile flow collections away from that phase,
        // even if a future parser regression reintroduces unbounded recursion.
        if (depth > maxDepth) throw new FrontmatterFailure("YAML nesting depth limit exceeded");
      } else if ((character === "]" || character === "}") && depth > 0) {
        depth -= 1;
      }
    }
  }
}

function parseBoundedYaml(
  source: string,
  limits: FrontmatterLimits,
): BoundedYamlResult {
  rejectDocumentEncoding(source, limits);
  if (utf8Length(source, 0, source.length, limits.maxFrontmatterBytes) > limits.maxFrontmatterBytes) {
    throw new FrontmatterFailure("YAML document byte limit exceeded");
  }
  rejectExcessiveFlowNesting(source, limits.maxDepth);
  const document = YAML.parseDocument(source, {
    intAsBigInt: false,
    keepSourceTokens: false,
    prettyErrors: true,
    strict: true,
    uniqueKeys: true,
    version: "1.2",
    schema: "core",
    customTags: [],
  });
  if (document.errors.length > 0) {
    throw new FrontmatterFailure(document.errors[0]?.message ?? "YAML document is invalid");
  }
  if (document.warnings.length > 0) {
    throw new FrontmatterFailure(document.warnings[0]?.message ?? "YAML document has unsafe warnings");
  }
  if (document.contents === null) {
    return { attributes: null, source };
  }
  const count = { value: 0 };
  const attributes = convertNode(document.contents, 1, { limits, count });
  return { attributes, source };
}

function failure(
  operation: string,
  provenance: Provenance,
  error: unknown,
): ReadResult<never> {
  const validProvenance = ProvenanceSchema.parse(provenance);
  const message = error instanceof Error ? error.message : String(error);
  return {
    ok: false,
    diagnostics: [DiagnosticSchema.parse({
      code: ErrorCodeRegistry.schemaInvalid,
      severity: "error",
      operation,
      message,
      location: validProvenance.location,
    })],
  };
}

/** Parse one bounded, single-document YAML value without resolving aliases. */
export function readBoundedYaml(
  source: string,
  provenance: Provenance,
  limits?: Partial<FrontmatterLimits>,
): ReadResult<JsonValue> {
  const operation = "readBoundedYaml";
  try {
    const validLimits = resolveLimits(limits);
    const parsed = parseBoundedYaml(source, validLimits);
    return { ok: true, value: parsed.attributes, diagnostics: [] };
  } catch (error) {
    return failure(operation, provenance, error);
  }
}

export function readBoundedFrontmatter(
  markdown: string,
  provenance: Provenance,
  limits?: Partial<FrontmatterLimits>,
): ReadResult<Readonly<{ attributes: JsonValue; body: string }>> {
  const operation = "readBoundedFrontmatter";
  try {
    const validLimits = resolveLimits(limits);
    const validMarkdown = rejectDocumentEncoding(markdown, validLimits);
    const located = locateFrontmatter(validMarkdown, validLimits);
    const parsed = parseBoundedYaml(located.source, validLimits);
    return {
      ok: true,
      value: { attributes: parsed.attributes, body: located.body },
      diagnostics: [],
    };
  } catch (error) {
    return failure(operation, provenance, error);
  }
}
