import { describe, expect, it } from "vitest";
import {
  StatePointersDocumentSchema,
  StateDocumentPointerSchema,
  createStatePointersDocument,
} from "../../../src/domain/state/pointers.js";
import { deriveStateBlobRef } from "../../../src/domain/state/references.js";
import { ContentDigestSchema } from "../../../src/domain/content-manifest.js";

const sha256 = () => new Uint8Array(32);
const digest = ContentDigestSchema.parse(`sha256:${"00".repeat(32)}`);
const blob = deriveStateBlobRef({ document: "config" }, sha256);
const userPointer = { kind: "hostConfig" as const, generation: 4, blob, digest };

function pointerDocument(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    scope: { kind: "user" as const },
    generation: 4,
    documents: [
      userPointer,
      { ...userPointer, kind: "installedUser" as const, blob: deriveStateBlobRef({ document: "installed" }, sha256) },
      { ...userPointer, kind: "trust" as const, blob: deriveStateBlobRef({ document: "trust" }, sha256) },
    ],
    ...overrides,
  };
}

describe("generation pointers", () => {
  it("requires the exact document set for each scope and one generation", () => {
    const parsed = createStatePointersDocument(pointerDocument());
    expect(parsed.documents).toHaveLength(3);
    expect(StateDocumentPointerSchema.parse(userPointer).kind).toBe("hostConfig");

    expect(StatePointersDocumentSchema.safeParse(pointerDocument({
      documents: [userPointer],
    })).success).toBe(false);
    expect(StatePointersDocumentSchema.safeParse(pointerDocument({
      documents: pointerDocument().documents.map((value) => ({ ...value, generation: 3 })),
    })).success).toBe(false);
  });

  it("allows only project-local state for project scopes", () => {
    const projectBlob = deriveStateBlobRef({ document: "project" }, sha256);
    const project = createStatePointersDocument({
      schemaVersion: 1,
      scope: { kind: "project", projectKey: `project-v1:sha256:${"11".repeat(32)}` },
      generation: 0,
      documents: [{ kind: "projectLocal", generation: 0, blob: projectBlob, digest }],
    });
    expect(project.documents[0]?.kind).toBe("projectLocal");
    expect(StatePointersDocumentSchema.safeParse({
      ...project,
      documents: [{ kind: "trust", generation: 0, blob: projectBlob, digest }],
    }).success).toBe(false);
  });

  it("rejects a non-previous generation and physical path fields", () => {
    expect(StatePointersDocumentSchema.safeParse(pointerDocument({ previousGeneration: 4 })).success).toBe(false);
    expect(StateDocumentPointerSchema.safeParse({ ...userPointer, path: "/tmp/state.json" }).success).toBe(false);
  });
});
