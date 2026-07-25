import { z } from "zod";
import { ContentDigestSchema, type ContentDigest } from "../content-manifest.js";
import { StateBlobRefSchema, type StateBlobRef } from "./references.js";
import {
  ScopeReferenceSchema,
  type ScopeReference,
} from "./scope.js";
import { GenerationSchema, type Generation } from "./config-state.js";

/**
 * The kind registry is the one source for pointer labels. The full
 * StateDocumentRegistry adds schemas without creating a second list of
 * pointer-addressable kinds.
 */
export const StateDocumentKindRegistry = {
  hostConfig: { tag: "host-config", label: "host configuration" },
  installedUser: { tag: "installed-user", label: "installed user state" },
  trust: { tag: "trust", label: "trust state" },
  projectLocal: { tag: "project-local", label: "project-local state" },
  portableProject: { tag: "portable-project", label: "portable project declaration" },
  pointers: { tag: "pointers", label: "generation pointers" },
} as const;

export type StateDocumentKind = keyof typeof StateDocumentKindRegistry;
const stateDocumentKindValues = Object.keys(
  StateDocumentKindRegistry,
) as [StateDocumentKind, ...StateDocumentKind[]];
export const StateDocumentKindSchema = z.enum(stateDocumentKindValues);

export const PointerDocumentKindSchema = z.enum([
  "hostConfig",
  "installedUser",
  "trust",
  "projectLocal",
]);
export type PointerDocumentKind = z.infer<typeof PointerDocumentKindSchema>;

/** A pointer names a logical blob and its verified content digest, never a path. */
export const StateDocumentPointerSchema = z
  .object({
    kind: PointerDocumentKindSchema,
    generation: GenerationSchema,
    blob: StateBlobRefSchema,
    digest: ContentDigestSchema,
  })
  .strict()
  .readonly();
export type StateDocumentPointer = z.infer<typeof StateDocumentPointerSchema>;

function addIssue(
  context: z.RefinementCtx,
  path: readonly (string | number)[],
  message: string,
): void {
  context.addIssue({ code: "custom", path: [...path], message });
}

function expectedKinds(scope: ScopeReference): readonly PointerDocumentKind[] {
  return scope.kind === "user"
    ? ["hostConfig", "installedUser", "trust"]
    : ["projectLocal"];
}

function sameScope(left: ScopeReference, right: ScopeReference): boolean {
  if (left.kind === "user") return right.kind === "user";
  return right.kind === "project" && left.projectKey === right.projectKey;
}

/**
 * One pointer document is the authority for one complete scope generation.
 * Pointer validation is intentionally stricter than record validation: there
 * is no safe sibling to expose when the selected generation is ambiguous.
 */
export const StatePointersDocumentSchema = z
  .object({
    schemaVersion: z.literal(1),
    scope: ScopeReferenceSchema,
    generation: GenerationSchema,
    previousGeneration: GenerationSchema.optional(),
    documents: z.array(StateDocumentPointerSchema).readonly(),
  })
  .strict()
  .readonly()
  .superRefine((document, context) => {
    const required = expectedKinds(document.scope);
    if (document.documents.length !== required.length) {
      addIssue(
        context,
        ["documents"],
        "pointer document set does not match its scope",
      );
    }

    const seen = new Set<PointerDocumentKind>();
    for (const [index, pointer] of document.documents.entries()) {
      if (seen.has(pointer.kind)) {
        addIssue(context, ["documents", index, "kind"], "duplicate document kind");
      }
      seen.add(pointer.kind);
      if (!required.includes(pointer.kind)) {
        addIssue(
          context,
          ["documents", index, "kind"],
          "document kind is not allowed for this scope",
        );
      }
      if (pointer.generation !== document.generation) {
        addIssue(
          context,
          ["documents", index, "generation"],
          "pointer generation does not match the enclosing generation",
        );
      }
    }
    for (const kind of required) {
      if (!seen.has(kind)) {
        addIssue(context, ["documents"], `missing required ${kind} document`);
      }
    }

    if (document.previousGeneration !== undefined &&
        document.previousGeneration >= document.generation) {
      addIssue(
        context,
        ["previousGeneration"],
        "previous generation must be lower than the current generation",
      );
    }
  });
export type StatePointersDocument = z.infer<
  typeof StatePointersDocumentSchema
>;

/** Validate a pointer document at the domain boundary. */
export function createStatePointersDocument(
  input: unknown,
): StatePointersDocument {
  return StatePointersDocumentSchema.parse(input);
}

export function verifyStatePointersScope(
  input: unknown,
  scope: ScopeReference,
  generation: Generation,
): StatePointersDocument {
  const document = StatePointersDocumentSchema.parse(input);
  const expectedScope = ScopeReferenceSchema.parse(scope);
  if (!sameScope(document.scope, expectedScope)) {
    throw new Error("state pointer scope does not match the requested scope");
  }
  if (document.generation !== generation) {
    throw new Error("state pointer generation does not match the requested generation");
  }
  return document;
}

export type { ContentDigest, Generation, ScopeReference, StateBlobRef };
