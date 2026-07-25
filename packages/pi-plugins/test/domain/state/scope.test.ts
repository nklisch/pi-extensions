import { createHash } from "node:crypto";
import { describe, expect, expectTypeOf, it } from "vitest";
import { z } from "zod";
import {
  CanonicalProjectRootSchema,
  ProjectIdentitySchema,
  ProjectKeySchema,
  ScopeContextSchema,
  ScopeReferenceSchema,
  createScopeContext,
  deriveProjectKey,
  toScopeReference,
  type ProjectIdentity,
  type ScopeContext,
} from "../../../src/domain/state/scope.js";
import { SourceHashSchema } from "../../../src/domain/source.js";

const sha256 = (bytes: Uint8Array): Uint8Array =>
  new Uint8Array(createHash("sha256").update(bytes).digest());
const root = CanonicalProjectRootSchema.parse("file:///home/example/project/");
const fingerprint = SourceHashSchema.parse(`sha256:${"11".repeat(32)}`);
const repositoryIdentity = ProjectIdentitySchema.parse({
  kind: "repository",
  canonicalRoot: root,
  repositoryFingerprint: fingerprint,
});
const pathOnlyIdentity = ProjectIdentitySchema.parse({
  kind: "path-only",
  canonicalRoot: root,
  limitation: "identity-changes-with-canonical-root",
});

describe("project scope identity", () => {
  it("derives a deterministic root- and repository-bound golden key", () => {
    const first = deriveProjectKey(repositoryIdentity, sha256);
    const second = deriveProjectKey(repositoryIdentity, sha256);

    expect(first).toBe("project-v1:sha256:2717e9385f3520ee4b43a22cb0349f815fd1436ae6b5e34e7ff29bf98bc3e64a");
    expect(second).toBe(first);
    expect(ProjectKeySchema.safeParse(first).success).toBe(true);
  });

  it("changes identity when root, repository fingerprint, or identity kind changes", () => {
    const sameRootDifferentFingerprint = ProjectIdentitySchema.parse({
      ...repositoryIdentity,
      repositoryFingerprint: SourceHashSchema.parse(`sha256:${"22".repeat(32)}`),
    });
    const moved = ProjectIdentitySchema.parse({
      ...repositoryIdentity,
      canonicalRoot: CanonicalProjectRootSchema.parse("file:///home/example/moved/") ,
    });

    const key = deriveProjectKey(repositoryIdentity, sha256);
    expect(deriveProjectKey(sameRootDifferentFingerprint, sha256)).not.toBe(key);
    expect(deriveProjectKey(moved, sha256)).not.toBe(key);
    expect(deriveProjectKey(pathOnlyIdentity, sha256)).not.toBe(key);
  });

  it("accepts only canonical, credential-free file roots", () => {
    const invalidRoots = [
      "https://example.com/project/",
      "file://user:password@example.com/project/",
      "file:///home/example/project/?query=1",
      "file:///home/example/project/#fragment",
      "file:///home/example/./project/",
      "file:///home/example/project/../other/",
      "file:///home/example//project/",
      "file:///home/example/%2e%2e/other/",
      "file:///home/example/%2Fescape/",
      "file:///home/example/project\\child/",
      `file:///home/example/project${String.fromCharCode(0xd800)}/`,
    ];
    for (const invalid of invalidRoots) {
      expect(CanonicalProjectRootSchema.safeParse(invalid).success, invalid).toBe(false);
    }
    expect(CanonicalProjectRootSchema.safeParse("file:///home/example/project/").success).toBe(true);
    expect(CanonicalProjectRootSchema.safeParse("file:///home/example/project").success).toBe(true);
  });

  it("keeps path-only identity explicit instead of treating it as a repository", () => {
    expect(pathOnlyIdentity).toEqual({
      kind: "path-only",
      canonicalRoot: root,
      limitation: "identity-changes-with-canonical-root",
    });
    expect(ProjectIdentitySchema.safeParse({
      kind: "path-only",
      canonicalRoot: root,
    }).success).toBe(false);
    expect(ProjectIdentitySchema.safeParse({
      ...pathOnlyIdentity,
      repositoryFingerprint: fingerprint,
    }).success).toBe(false);
  });

  it("recomputes and verifies project keys before creating context", () => {
    const projectKey = deriveProjectKey(repositoryIdentity, sha256);
    const context = createScopeContext({
      kind: "project",
      identity: repositoryIdentity,
      projectKey,
    }, sha256);

    expect(context).toEqual({ kind: "project", identity: repositoryIdentity, projectKey });
    expect(() => createScopeContext({
      kind: "project",
      identity: repositoryIdentity,
      projectKey: deriveProjectKey(pathOnlyIdentity, sha256),
    }, sha256)).toThrow(/project key/);
    expect(() => createScopeContext({
      kind: "project",
      identity: repositoryIdentity,
      projectKey,
      extra: true,
    }, sha256)).toThrow();
  });

  it("reduces contexts to path-free persisted references", () => {
    const user = createScopeContext({ kind: "user" }, sha256);
    const project = createScopeContext({
      kind: "project",
      identity: repositoryIdentity,
      projectKey: deriveProjectKey(repositoryIdentity, sha256),
    }, sha256);

    expect(toScopeReference(user)).toEqual({ kind: "user" });
    const projectReference = toScopeReference(project);
    if (project.kind !== "project") throw new Error("expected project scope");
    expect(projectReference).toEqual({ kind: "project", projectKey: project.projectKey });
    expect(JSON.stringify(projectReference)).not.toContain("file:");
    expect(ScopeReferenceSchema.parse(projectReference)).toEqual(projectReference);
    expect(ScopeContextSchema.parse(project)).toEqual(project);
  });

  it("derives public types from strict schemas", () => {
    expectTypeOf<z.infer<typeof ProjectIdentitySchema>>().toEqualTypeOf<ProjectIdentity>();
    expectTypeOf<z.infer<typeof ScopeContextSchema>>().toEqualTypeOf<ScopeContext>();
    expectTypeOf<z.infer<typeof ProjectKeySchema>>().toEqualTypeOf<import("../../../src/domain/state/scope.js").ProjectKey>();
  });
});
