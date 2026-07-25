import { parse } from "smol-toml";
import {
  AdoptionDocumentKindRegistry,
  type AdoptionDeclaration,
} from "../../domain/adoption.js";
import { MarketplaceNameSchema, type MarketplaceName } from "../../domain/identity.js";
import { MarketplaceSourceSchema, type MarketplaceSource } from "../../domain/source.js";
import type { Diagnostic } from "../../domain/errors.js";
import type { JsonValue } from "../../domain/schema.js";
import {
  collection,
  entryDiagnostic,
  isRecord,
  jsonPointer,
  makeDeclaration,
  schemaDiagnostic,
  type AdoptionReaderContext,
} from "../adoption-reader-support.js";

const HOST = "codex" as const;
const DOCUMENT = AdoptionDocumentKindRegistry.codexUserConfig.tag;
const OPERATIONAL_FIELDS = new Set(["source_type", "source", "ref", "sparse_paths", "last_updated", "last_revision"]);

type TomlRecord = Record<string, unknown>;

function readTables(root: TomlRecord, context: AdoptionReaderContext) {
  const declarations: AdoptionDeclaration[] = [];
  const diagnostics: Diagnostic[] = [];
  const marketplaces = root.marketplaces;
  if (marketplaces === undefined) return collection(declarations, diagnostics);
  if (!isRecord(marketplaces)) {
    return collection([], [entryDiagnostic(HOST, DOCUMENT, context.path, "/marketplaces", "FOREIGN_STATE_ROOT_INVALID", "Codex marketplaces must be a table")]);
  }

  for (const alias of Object.keys(marketplaces).sort()) {
    const tablePointer = jsonPointer("marketplaces", alias);
    const table = marketplaces[alias];
    if (!isRecord(table)) {
      diagnostics.push(entryDiagnostic(HOST, DOCUMENT, context.path, tablePointer, "ENTRY_INVALID", "Codex marketplace declaration must be a table"));
      continue;
    }
    const parsedAlias = MarketplaceNameSchema.safeParse(alias);
    if (!parsedAlias.success) {
      diagnostics.push(entryDiagnostic(HOST, DOCUMENT, context.path, tablePointer, "IDENTITY_INVALID", "Marketplace alias is not a valid Pi marketplace name"));
      continue;
    }

    const unknownField = Object.keys(table).find((key) => !OPERATIONAL_FIELDS.has(key));
    if (unknownField !== undefined) {
      diagnostics.push(entryDiagnostic(HOST, DOCUMENT, context.path, jsonPointer("marketplaces", alias, unknownField), "UNSUPPORTED_DECLARATION", "Codex marketplace table carries unsupported source semantics"));
      continue;
    }
    const sourceType = table.source_type;
    const rawSourceValue = table.source;
    if (typeof sourceType !== "string" || typeof rawSourceValue !== "string" || rawSourceValue.length === 0) {
      diagnostics.push(entryDiagnostic(HOST, DOCUMENT, context.path, tablePointer, "ENTRY_INVALID", "Codex marketplace declaration requires source_type and source"));
      continue;
    }
    if (table.sparse_paths !== undefined) {
      if (!Array.isArray(table.sparse_paths) || table.sparse_paths.length !== 0) {
        diagnostics.push(entryDiagnostic(HOST, DOCUMENT, context.path, jsonPointer("marketplaces", alias, "sparse_paths"), "UNSUPPORTED_DECLARATION", "Codex sparse marketplace checkouts are unsupported"));
        continue;
      }
    }

    let candidate: unknown;
    if (sourceType === "git") {
      if (table.ref !== undefined && (typeof table.ref !== "string" || table.ref.length === 0)) {
        diagnostics.push(entryDiagnostic(HOST, DOCUMENT, context.path, jsonPointer("marketplaces", alias, "ref"), "ENTRY_INVALID", "Codex marketplace ref must be a non-empty string"));
        continue;
      }
      candidate = {
        kind: "git",
        url: rawSourceValue,
        ...(table.ref === undefined ? {} : { ref: table.ref }),
      };
    } else if (sourceType === "local") {
      if (table.ref !== undefined) {
        diagnostics.push(entryDiagnostic(HOST, DOCUMENT, context.path, jsonPointer("marketplaces", alias, "ref"), "UNSUPPORTED_DECLARATION", "Codex local marketplace refs are unsupported"));
        continue;
      }
      candidate = { kind: "local-git", path: rawSourceValue };
    } else {
      diagnostics.push(entryDiagnostic(HOST, DOCUMENT, context.path, jsonPointer("marketplaces", alias, "source_type"), "UNSUPPORTED_DECLARATION", `Codex marketplace source type ${sourceType} is unsupported`));
      continue;
    }

    const parsedSource = MarketplaceSourceSchema.safeParse(candidate);
    if (!parsedSource.success) {
      diagnostics.push(schemaDiagnostic(HOST, DOCUMENT, context.path, jsonPointer("marketplaces", alias, "source"), parsedSource.error));
      continue;
    }
    const rawDeclaration: JsonValue = {
      source_type: sourceType,
      source: rawSourceValue,
      ...(table.ref === undefined ? {} : { ref: table.ref as string }),
    };
    try {
      declarations.push(makeDeclaration({
        host: HOST,
        document: DOCUMENT,
        alias: parsedAlias.data as MarketplaceName,
        source: parsedSource.data as MarketplaceSource,
        path: context.path,
        aliasPointer: tablePointer,
        sourcePointer: jsonPointer("marketplaces", alias, "source"),
        rawSource: rawDeclaration,
      }));
    } catch {
      diagnostics.push(entryDiagnostic(HOST, DOCUMENT, context.path, tablePointer, "ENTRY_INVALID", "Codex marketplace declaration could not be represented"));
    }
  }
  return collection(declarations, diagnostics);
}

export function readCodexUserConfigToml(
  source: string,
  context: AdoptionReaderContext,
) {
  let parsed: unknown;
  try {
    parsed = parse(source) as unknown;
  } catch {
    return collection([], [entryDiagnostic(HOST, DOCUMENT, context.path, "", "FOREIGN_STATE_ROOT_INVALID", "Codex TOML is syntactically invalid")]);
  }
  if (!isRecord(parsed)) {
    return collection([], [entryDiagnostic(HOST, DOCUMENT, context.path, "", "FOREIGN_STATE_ROOT_INVALID", "Codex TOML root must be a table")]);
  }
  return readTables(parsed, context);
}
