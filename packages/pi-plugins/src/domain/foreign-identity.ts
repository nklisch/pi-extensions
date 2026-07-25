import { type Claimed, ProvenanceSchema, type Provenance } from "./provenance.js";
import { type JsonValue } from "./schema.js";

/**
 * A foreign declaration's identity is a semantic role, not a source pointer.
 * These registries describe shapes whose members carry their own stable names;
 * all other declarations occupy the single role for their native kind.
 */
const ForeignDeclarationShapeRegistry = {
  keyed: ["apps", "channels", "connectors", "dependencies", "lspServers", "plugins"],
  listed: ["agents", "commands", "dependencies", "plugins", "themes", "outputStyles"],
} as const;

const DefaultForeignDeclarationSubkey = "default";

type ForeignDeclarationInput = Readonly<{
  value: JsonValue;
  provenance: readonly Provenance[];
}>;

type ForeignDeclarationClaim = Readonly<{
  declarationSubkey: string;
  declaration: Claimed<JsonValue>;
}>;

function stableJson(value: JsonValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const record = value as { readonly [key: string]: JsonValue };
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key]!)}`).join(",")}}`;
}

function pointerSegment(value: string | number): string {
  return String(value).replaceAll("~", "~0").replaceAll("/", "~1");
}

function childPointer(pointer: string | undefined, key: string | number): string {
  return `${pointer ?? ""}/${pointerSegment(key)}`;
}

function derivedProvenance(
  provenance: Provenance,
  key: string | number,
  declaration: JsonValue,
): Provenance {
  return ProvenanceSchema.parse({
    ...provenance,
    location: {
      ...provenance.location,
      pointer: childPointer(provenance.location.pointer, key),
    },
    declaration,
  });
}

function sliceClaim(
  claim: Claimed<JsonValue>,
  key: string | number,
  declaration: JsonValue,
): Claimed<JsonValue> {
  return {
    value: declaration,
    provenance: claim.provenance.map((provenance) => derivedProvenance(provenance, key, declaration)) as [Provenance, ...Provenance[]],
  };
}

function contains(values: readonly string[], value: string): boolean {
  return values.includes(value);
}

function keyedSubkey(key: string): string {
  return `key:${key}`;
}

function listedSubkey(value: JsonValue): string {
  return `item:${stableJson(value)}`;
}

/**
 * Split only shapes with an explicit semantic collection convention. A plain
 * object remains one declaration: treating every object property as an item
 * would turn arbitrary runtime configuration into unrelated components.
 */
export function splitForeignDeclaration(
  nativeKind: string,
  declarationInput: ForeignDeclarationInput,
): readonly ForeignDeclarationClaim[] {
  if (declarationInput.provenance.length === 0) {
    throw new TypeError("foreign declaration provenance cannot be empty");
  }
  const declaration: Claimed<JsonValue> = {
    value: declarationInput.value,
    provenance: declarationInput.provenance as [Provenance, ...Provenance[]],
  };
  if (contains(ForeignDeclarationShapeRegistry.keyed, nativeKind) &&
      declaration.value !== null && typeof declaration.value === "object" && !Array.isArray(declaration.value)) {
    const values = Object.entries(declaration.value as { readonly [key: string]: JsonValue });
    if (values.length > 0) {
      return values
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, value]) => ({
          declarationSubkey: keyedSubkey(key),
          declaration: sliceClaim(declaration, key, value),
        }));
    }
  }

  if (contains(ForeignDeclarationShapeRegistry.listed, nativeKind) && Array.isArray(declaration.value)) {
    if (declaration.value.length === 1) {
      return [{
        declarationSubkey: DefaultForeignDeclarationSubkey,
        declaration: sliceClaim(declaration, 0, declaration.value[0]!),
      }];
    }
    return declaration.value.map((value, index) => ({
      declarationSubkey: listedSubkey(value),
      declaration: sliceClaim(declaration, index, value),
    }));
  }

  return [{
    declarationSubkey: DefaultForeignDeclarationSubkey,
    declaration,
  }];
}

export type { ForeignDeclarationClaim };
