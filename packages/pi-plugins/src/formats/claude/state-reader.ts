import {
  AdoptionDocumentKindRegistry,
  type AdoptionDeclaration,
} from "../../domain/adoption.js";
import {
  MarketplaceNameSchema,
  type MarketplaceName,
} from "../../domain/identity.js";
import {
  MarketplaceSourceSchema,
  type MarketplaceSource,
} from "../../domain/source.js";
import {
  collection,
  entryDiagnostic,
  isJsonRecord,
  jsonPointer,
  makeDeclaration,
  own,
  parseJsonRoot,
  schemaDiagnostic,
  type AdoptionReaderContext,
} from "../adoption-reader-support.js";
import type { Diagnostic } from "../../domain/errors.js";
import type { JsonValue } from "../../domain/schema.js";

const HOST = "claude" as const;
const KNOWN_DOCUMENT = AdoptionDocumentKindRegistry.claudeKnownMarketplaces.tag;
const SETTINGS_DOCUMENT = AdoptionDocumentKindRegistry.claudeUserSettings.tag;

type JsonRecord = { readonly [key: string]: JsonValue };

function unsupported(
  document: typeof KNOWN_DOCUMENT | typeof SETTINGS_DOCUMENT,
  path: string,
  pointer: string,
  message: string,
): Diagnostic {
  return entryDiagnostic(HOST, document, path, pointer, "UNSUPPORTED_DECLARATION", message);
}

function sourceFromEntry(
  raw: JsonValue | undefined,
  document: typeof KNOWN_DOCUMENT | typeof SETTINGS_DOCUMENT,
  path: string,
  pointer: string,
): { source?: MarketplaceSource; diagnostic?: Diagnostic } {
  if (raw === undefined || !isJsonRecord(raw)) {
    return {
      diagnostic: entryDiagnostic(HOST, document, path, pointer, "ENTRY_INVALID", "Marketplace source must be an object"),
    };
  }
  const sourceType = raw.source;
  if (typeof sourceType !== "string") {
    return {
      diagnostic: entryDiagnostic(HOST, document, path, pointer, "ENTRY_INVALID", "Marketplace source type is missing"),
    };
  }

  const allowed = sourceType === "github"
    ? ["source", "repo", "ref"]
    : sourceType === "git"
      ? ["source", "url", "ref"]
      : sourceType === "directory"
        ? ["source", "path"]
        : [];
  if (allowed.length === 0) {
    return {
      diagnostic: unsupported(document, path, pointer, `Claude marketplace source type ${sourceType} is unsupported`),
    };
  }
  const unknown = Object.keys(raw).find((key) => !allowed.includes(key));
  if (unknown !== undefined) {
    return {
      diagnostic: unsupported(document, path, `${pointer}/${unknown.replaceAll("~", "~0").replaceAll("/", "~1")}`, "Claude marketplace source carries unsupported source semantics"),
    };
  }

  const candidate: unknown = sourceType === "github"
    ? {
        kind: "github",
        repository: raw.repo,
        ...(raw.ref === undefined ? {} : { ref: raw.ref }),
      }
    : sourceType === "git"
      ? {
          kind: "git",
          url: raw.url,
          ...(raw.ref === undefined ? {} : { ref: raw.ref }),
        }
      : {
          kind: "local-git",
          path: raw.path,
        };
  const parsed = MarketplaceSourceSchema.safeParse(candidate);
  if (!parsed.success) {
    return { diagnostic: schemaDiagnostic(HOST, document, path, pointer, parsed.error) };
  }
  return { source: parsed.data };
}

function readEntries(
  root: JsonRecord,
  document: typeof KNOWN_DOCUMENT | typeof SETTINGS_DOCUMENT,
  context: AdoptionReaderContext,
): ReturnType<typeof collection<AdoptionDeclaration>> {
  const declarations: AdoptionDeclaration[] = [];
  const diagnostics: Diagnostic[] = [];
  for (const alias of Object.keys(root).sort()) {
    const entryPointer = jsonPointer(alias);
    const rawEntry = root[alias];
    if (!isJsonRecord(rawEntry)) {
      diagnostics.push(entryDiagnostic(HOST, document, context.path, entryPointer, "ENTRY_INVALID", "Marketplace declaration must be an object"));
      continue;
    }
    const parsedAlias = MarketplaceNameSchema.safeParse(alias);
    if (!parsedAlias.success) {
      diagnostics.push(entryDiagnostic(HOST, document, context.path, entryPointer, "IDENTITY_INVALID", "Marketplace alias is not a valid Pi marketplace name"));
      continue;
    }
    const semanticField = ["skipLfs", "hostPattern", "settings"].find((field) => own(rawEntry, field));
    if (semanticField !== undefined) {
      diagnostics.push(unsupported(document, context.path, jsonPointer(alias, semanticField), "Claude marketplace declaration carries unsupported source semantics"));
      continue;
    }
    if (!own(rawEntry, "source")) {
      diagnostics.push(entryDiagnostic(HOST, document, context.path, entryPointer, "ENTRY_INVALID", "Marketplace declaration has no source"));
      continue;
    }
    const rawSource = rawEntry.source;
    if (rawSource === undefined) {
      diagnostics.push(entryDiagnostic(HOST, document, context.path, entryPointer, "ENTRY_INVALID", "Marketplace declaration has no source"));
      continue;
    }
    const parsedSource = sourceFromEntry(rawSource, document, context.path, jsonPointer(alias, "source"));
    if (parsedSource.diagnostic !== undefined) {
      diagnostics.push(parsedSource.diagnostic);
      continue;
    }
    try {
      declarations.push(makeDeclaration({
        host: HOST,
        document,
        alias: parsedAlias.data as MarketplaceName,
        source: parsedSource.source!,
        path: context.path,
        aliasPointer: entryPointer,
        sourcePointer: jsonPointer(alias, "source"),
        rawSource,
      }));
    } catch {
      diagnostics.push(entryDiagnostic(HOST, document, context.path, entryPointer, "ENTRY_INVALID", "Marketplace declaration could not be represented"));
    }
  }
  return collection(declarations, diagnostics);
}

export function readClaudeKnownMarketplacesJson(
  source: string,
  context: AdoptionReaderContext,
) {
  const parsed = parseJsonRoot(source, HOST, KNOWN_DOCUMENT, context.path);
  if (parsed.value === undefined) return collection([], parsed.diagnostics);
  return readEntries(parsed.value as JsonRecord, KNOWN_DOCUMENT, context);
}

export function readClaudeUserSettingsJson(
  source: string,
  context: AdoptionReaderContext,
) {
  const parsed = parseJsonRoot(source, HOST, SETTINGS_DOCUMENT, context.path);
  if (parsed.value === undefined) return collection([], parsed.diagnostics);
  const root = parsed.value;
  if (root === undefined || !isJsonRecord(root)) return collection([], parsed.diagnostics);
  const extra = root.extraKnownMarketplaces;
  if (extra === undefined) return collection([], parsed.diagnostics);
  if (!isJsonRecord(extra)) {
    return collection([], [
      ...parsed.diagnostics,
      entryDiagnostic(HOST, SETTINGS_DOCUMENT, context.path, "/extraKnownMarketplaces", "FOREIGN_STATE_ROOT_INVALID", "extraKnownMarketplaces must be an object"),
    ]);
  }
  return readEntries(extra, SETTINGS_DOCUMENT, context);
}
