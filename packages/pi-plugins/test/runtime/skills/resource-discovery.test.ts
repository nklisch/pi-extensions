import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createContentIndex } from "../../../src/application/content-index.js";
import { ProjectionExpectationSchema } from "../../../src/application/ports/runtime-projection.js";
import { SkillHookSnapshotObservationSchema } from "../../../src/runtime/skills/contribution-observation.js";
import { createSkillResourceDiscoveryRuntime } from "../../../src/runtime/skills/resource-discovery.js";
import { createSkillHookRuntimeCatalog } from "../../../src/runtime/skill-hook/runtime-catalog.js";
import { claim } from "../../../src/domain/provenance.js";
import { createContentManifest, hashContent } from "../../../src/domain/content-manifest.js";
import type { SkillHookRuntimeSnapshot } from "../../../src/runtime/skill-hook/runtime-snapshot.js";
import type { SkillHookSnapshotParticipant } from "../../../src/runtime/skill-hook/lifecycle-participant.js";
import type { CurrentProjectRuntimeContext } from "../../../src/application/ports/project-trust.js";
import type { SkillResourcePathPort } from "../../../src/application/ports/skill-resource-path.js";
import type { ContentDigest } from "../../../src/domain/content-manifest.js";

const sha256 = (bytes: Uint8Array): Uint8Array => new Uint8Array(createHash("sha256").update(bytes).digest());
const digest = (letter: string) => `sha256:${letter.repeat(64)}` as ContentDigest;
const project: CurrentProjectRuntimeContext = {
  identity: { kind: "path-only", canonicalRoot: "file:///workspace/", limitation: "identity-changes-with-canonical-root" },
  projectKey: `project-v1:sha256:${"1".repeat(64)}` as never,
  trust: { kind: "trusted" },
};
const provenance = { location: { host: "claude" as const, documentKind: "manifest" as const, path: "plugin.json", pointer: "/skills" } };
const source = { kind: "skill" as const, id: `component-v1:skill:${"a".repeat(64)}` as never, name: claim("demo", provenance), root: claim("skills/demo", provenance), metadata: [] };
const otherSource = { ...source, id: `component-v1:skill:${"b".repeat(64)}` as never, root: claim("skills/other", provenance) };

function manifestFor(paths: readonly string[]) {
  const entries = paths.flatMap((path) => {
    const bytes = new TextEncoder().encode(path);
    return [
      { kind: "directory" as const, path: "skills", mode: 0o755 as const },
      { kind: "directory" as const, path, mode: 0o755 as const },
      { kind: "file" as const, path: `${path}/SKILL.md`, mode: 0o644 as const, size: bytes.byteLength, digest: hashContent(bytes, sha256) },
    ];
  });
  const unique = [...new Map(entries.map((entry) => [entry.path, entry])).values()];
  return createContentManifest(unique, sha256);
}

function snapshot(plugin: string, scope: SkillHookRuntimeSnapshot["scope"], skills = [source]): SkillHookRuntimeSnapshot {
  const projectionDigest = digest("a");
  const revision = digest("b");
  const manifest = manifestFor(skills.map((skill) => skill.root.value));
  return {
    schemaVersion: 1,
    scope,
    plugin: plugin as never,
    revision,
    projectionDigest,
    projectionRef: `runtime-projection-v1:sha256:${"f".repeat(64)}` as never,
    currentProject: project,
    content: { kind: "plugin", root: `/immutable/${plugin}/${scope.kind}`, identity: {} as never, manifest, contentRef: `plugin-content-v1:sha256:${"2".repeat(64)}` as never },
    data: { root: `/data/${plugin}`, scope, plugin: plugin as never, dataRef: `plugin-data-v1:sha256:${"3".repeat(64)}` as never },
    skills,
    hooks: [],
    contributionDigest: digest("c"),
  } as never;
}

function expectation(value: SkillHookRuntimeSnapshot): Extract<ReturnType<typeof ProjectionExpectationSchema.parse>, { kind: "active" }> {
  return ProjectionExpectationSchema.parse({
    kind: "active",
    projection: {
      schemaVersion: 1,
      scope: value.scope,
      plugin: value.plugin,
      pluginIdentity: {
        key: value.plugin,
        marketplaceName: "community",
        marketplaceEntryName: value.plugin.split("@")[0]!,
      },
      compatibilityDigest: digest("e"),
      revision: value.revision,
      contentRef: value.content.contentRef,
      dataRef: value.data.dataRef,
      components: { skills: value.skills, hooks: [], mcpServers: [] },
      digest: value.projectionDigest,
    },
    projectionRef: value.projectionRef,
  }) as Extract<ReturnType<typeof ProjectionExpectationSchema.parse>, { kind: "active" }>;
}

function sourceObserver(values: readonly SkillHookRuntimeSnapshot[]): SkillHookSnapshotParticipant {
  const byKey = new Map(values.map((value) => [`${value.scope.kind}:${value.plugin}`, value]));
  return {
    async reconcile() { return { kind: "applied", count: values.length } as const; },
    async observe(input) {
      const parsed = ProjectionExpectationSchema.parse(input);
      const value = parsed.kind === "active" ? byKey.get(`${parsed.projection.scope.kind}:${parsed.projection.plugin}`) : undefined;
      if (parsed.kind === "active" && value !== undefined) {
        return { kind: "ready", observation: SkillHookSnapshotObservationSchema.parse({
          kind: "active", participant: "skills-hooks-snapshot", scope: value.scope, plugin: value.plugin,
          revision: value.revision, projectionDigest: value.projectionDigest, currentProject: project,
          contributionDigest: value.contributionDigest, skillComponentIds: value.skills.map((item) => item.id), hookComponentIds: [],
        }) };
      }
      if (parsed.kind === "inactive") return { kind: "ready", observation: SkillHookSnapshotObservationSchema.parse({
        kind: "inactive", participant: "skills-hooks-snapshot", scope: parsed.scope, plugin: parsed.plugin,
        projectionDigest: parsed.digest, currentProject: project, contributionDigest: digest("d"), skillComponentIds: [], hookComponentIds: [],
      }) };
      return { kind: "failed", code: "OBSERVATION_MISMATCH" };
    },
  };
}

describe("deterministic skill resource discovery", () => {
  it("orders targets and deduplicates one canonical file while retaining logical observations", async () => {
    const user = snapshot("user@community", { kind: "user" }, [source]);
    const projectTarget = snapshot("project@community", { kind: "project", projectKey: project.projectKey }, [otherSource]);
    const values = [projectTarget, user];
    const owned = createSkillHookRuntimeCatalog();
    owned.publish(values, project);
    const paths: SkillResourcePathPort = { async verify() { return { kind: "ready", value: { path: "/immutable/shared/SKILL.md", canonicalPath: "/immutable/shared/SKILL.md" } }; } };
    const runtime = createSkillResourceDiscoveryRuntime({ snapshots: sourceObserver(values), catalog: owned.catalog, paths, sha256 });
    const result = await runtime.resources.discover({ reason: "startup", projectTrusted: true }, new AbortController().signal);
    expect(result).toEqual({ kind: "ready", skillPaths: ["/immutable/shared/SKILL.md"], failedTargets: [] });
    expect(await runtime.participant.observe(expectation(user), new AbortController().signal)).toMatchObject({
      kind: "ready",
      observation: { scope: { kind: "user" }, plugin: "user@community", skillComponentIds: [source.id] },
    });
    expect(await runtime.participant.observe(expectation(projectTarget), new AbortController().signal)).toMatchObject({
      kind: "ready",
      observation: { scope: { kind: "project", projectKey: project.projectKey }, plugin: "project@community", skillComponentIds: [otherSource.id] },
    });
  });

  it("denies an untrusted project target without removing a valid user path", async () => {
    const user = snapshot("user@community", { kind: "user" });
    const projectTarget = snapshot("project@community", { kind: "project", projectKey: project.projectKey });
    const values = [projectTarget, user];
    const owned = createSkillHookRuntimeCatalog();
    owned.publish(values, project);
    const paths: SkillResourcePathPort = { async verify(file) { return { kind: "ready", value: { path: `${file.root}/${file.entry.path}`, canonicalPath: `${file.root}/${file.entry.path}` } }; } };
    const runtime = createSkillResourceDiscoveryRuntime({ snapshots: sourceObserver(values), catalog: owned.catalog, paths, sha256 });
    const result = await runtime.resources.discover({ reason: "startup", projectTrusted: false }, new AbortController().signal);
    expect(result).toMatchObject({
      kind: "ready",
      skillPaths: ["/immutable/user@community/user/skills/demo/SKILL.md"],
      failedTargets: [{ scope: { kind: "project", projectKey: project.projectKey }, plugin: "project@community", code: "PROJECT_UNTRUSTED" }],
    });
    expect(await runtime.participant.observe(expectation(user), new AbortController().signal)).toMatchObject({ kind: "ready" });
    expect(await runtime.participant.observe(expectation(projectTarget), new AbortController().signal)).toEqual({ kind: "failed", code: "RESOURCE_UNAVAILABLE" });
  });

  it("records a project identity mismatch while retaining unrelated user evidence", async () => {
    const user = snapshot("user@community", { kind: "user" });
    const otherProjectKey = `project-v1:sha256:${"2".repeat(64)}` as never;
    const mismatchedProject = snapshot("other-project@community", { kind: "project", projectKey: otherProjectKey });
    const values = [mismatchedProject, user];
    const owned = createSkillHookRuntimeCatalog();
    owned.publish(values, project);
    const paths: SkillResourcePathPort = { async verify(file) { return { kind: "ready", value: { path: `${file.root}/${file.entry.path}`, canonicalPath: `${file.root}/${file.entry.path}` } }; } };
    const runtime = createSkillResourceDiscoveryRuntime({ snapshots: sourceObserver(values), catalog: owned.catalog, paths, sha256 });
    const result = await runtime.resources.discover({ reason: "reload", projectTrusted: true }, new AbortController().signal);
    expect(result).toMatchObject({
      kind: "ready",
      skillPaths: ["/immutable/user@community/user/skills/demo/SKILL.md"],
      failedTargets: [{ scope: { kind: "project", projectKey: otherProjectKey }, plugin: "other-project@community", code: "PROJECT_IDENTITY_MISMATCH" }],
    });
    expect(await runtime.participant.observe(expectation(user), new AbortController().signal)).toMatchObject({ kind: "ready" });
    expect(await runtime.participant.observe(expectation(mismatchedProject), new AbortController().signal)).toEqual({ kind: "failed", code: "RESOURCE_UNAVAILABLE" });
  });

  it("isolates one bad target, retains healthy paths, and prevents observation", async () => {
    const good = snapshot("good@community", { kind: "user" });
    const bad = snapshot("bad@community", { kind: "user" });
    const owned = createSkillHookRuntimeCatalog();
    owned.publish([bad, good], project);
    const paths: SkillResourcePathPort = { async verify(file) { return file.root.includes("bad@community") ? { kind: "failed", code: "ROOT_MUTATED" } : { kind: "ready", value: { path: `${file.root}/${file.entry.path}`, canonicalPath: file.entry.path } }; } };
    const runtime = createSkillResourceDiscoveryRuntime({ snapshots: sourceObserver([bad, good]), catalog: owned.catalog, paths, sha256 });
    const result = await runtime.resources.discover({ reason: "reload", projectTrusted: true }, new AbortController().signal);
    expect(result).toMatchObject({ kind: "ready", skillPaths: ["/immutable/good@community/user/skills/demo/SKILL.md"], failedTargets: [{ plugin: "bad@community", code: "ROOT_MUTATED" }] });
    expect(await runtime.participant.observe(expectation(bad), new AbortController().signal)).toEqual({ kind: "failed", code: "RESOURCE_UNAVAILABLE" });
  });

  it("invalidates prior discovery on applied reconcile and keeps cancellation atomic", async () => {
    const value = snapshot("demo@community", { kind: "user" });
    const owned = createSkillHookRuntimeCatalog();
    owned.publish([value], project);
    const runtime = createSkillResourceDiscoveryRuntime({
      snapshots: sourceObserver([value]),
      catalog: owned.catalog,
      paths: { async verify(file) { return { kind: "ready", value: { path: file.root, canonicalPath: file.root } }; } },
      sha256,
    });
    expect((await runtime.resources.discover({ reason: "startup", projectTrusted: true }, new AbortController().signal)).kind).toBe("ready");
    expect((await runtime.participant.observe(expectation(value), new AbortController().signal)).kind).toBe("ready");
    await runtime.participant.reconcile({ active: [], currentProject: project }, new AbortController().signal);
    expect(await runtime.participant.observe(expectation(value), new AbortController().signal)).toMatchObject({ kind: "failed", code: "CATALOG_UNINITIALIZED" });
  });
});