import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSkills } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createManifestContentReader } from "../../src/infrastructure/filesystem/manifest-content-reader.js";
import { createManifestSkillPathVerifier } from "../../src/infrastructure/filesystem/manifest-skill-path-verifier.js";
import { createSkillResourceDiscoveryRuntime } from "../../src/runtime/skills/resource-discovery.js";
import { createSkillHookRuntimeCatalog } from "../../src/runtime/skill-hook/runtime-catalog.js";
import { SkillHookSnapshotObservationSchema } from "../../src/runtime/skills/contribution-observation.js";
import { registerSkillResourceDiscovery } from "../../src/pi/skill-resource-discovery.js";
import { ProjectionExpectationSchema } from "../../src/application/ports/runtime-projection.js";
import { createContentManifest, hashContent, type ContentDigest } from "../../src/domain/content-manifest.js";
import { claim } from "../../src/domain/provenance.js";
import { CanonicalProjectRootSchema, ProjectIdentitySchema, deriveProjectKey } from "../../src/domain/state/scope.js";
import type { SkillHookRuntimeSnapshot } from "../../src/runtime/skill-hook/runtime-snapshot.js";
import type { SkillHookSnapshotParticipant } from "../../src/runtime/skill-hook/lifecycle-participant.js";
import type { CurrentProjectRuntimeContext } from "../../src/application/ports/project-trust.js";

const sha256 = (bytes: Uint8Array): Uint8Array => new Uint8Array(createHash("sha256").update(bytes).digest());
const digest = (letter: string) => `sha256:${letter.repeat(64)}` as ContentDigest;
const provenance = { location: { host: "claude" as const, documentKind: "manifest" as const, path: "plugin.json", pointer: "/skills" } };
const identity = ProjectIdentitySchema.parse({ kind: "path-only", canonicalRoot: CanonicalProjectRootSchema.parse("file:///workspace/project/"), limitation: "identity-changes-with-canonical-root" });
const currentProject: CurrentProjectRuntimeContext = { identity, projectKey: deriveProjectKey(identity, sha256), trust: { kind: "trusted" } };

const handlers = new Map<string, Array<(...args: readonly unknown[]) => unknown>>();
function fakePi(): ExtensionAPI {
  return { on(event: string, handler: (...args: readonly unknown[]) => unknown) { handlers.set(event, [...(handlers.get(event) ?? []), handler]); } } as unknown as ExtensionAPI;
}
function context(trusted: boolean): ExtensionContext {
  return { cwd: "/workspace/project", isProjectTrusted: () => trusted } as unknown as ExtensionContext;
}
async function makeWritable(path: string): Promise<void> {
  const stat = await lstat(path).catch(() => undefined);
  if (stat === undefined) return;
  if (stat.isDirectory() && !stat.isSymbolicLink()) {
    for (const child of await readdir(path)) await makeWritable(join(path, child));
    await chmod(path, 0o755).catch(() => undefined);
  } else if (!stat.isSymbolicLink()) await chmod(path, 0o644).catch(() => undefined);
}

async function publishSkill(root: string, plugin: string, componentToken: string, declaredName: string): Promise<SkillHookRuntimeSnapshot> {
  const skillRoot = join(root, "skills", "demo");
  const bytes = new TextEncoder().encode(`---\nname: ${declaredName}\ndescription: integration\n---\n`);
  const asset = new TextEncoder().encode("kept beside the skill");
  await mkdir(join(skillRoot, "assets"), { recursive: true });
  await writeFile(join(skillRoot, "SKILL.md"), bytes);
  await writeFile(join(skillRoot, "assets", "helper.txt"), asset);
  const manifest = createContentManifest([
    { kind: "directory", path: "skills", mode: 0o755 },
    { kind: "directory", path: "skills/demo", mode: 0o755 },
    { kind: "directory", path: "skills/demo/assets", mode: 0o755 },
    { kind: "file", path: "skills/demo/SKILL.md", mode: 0o644, size: bytes.byteLength, digest: hashContent(bytes, sha256) },
    { kind: "file", path: "skills/demo/assets/helper.txt", mode: 0o644, size: asset.byteLength, digest: hashContent(asset, sha256) },
  ], sha256);
  await chmod(join(skillRoot, "SKILL.md"), 0o444);
  await chmod(join(skillRoot, "assets", "helper.txt"), 0o444);
  await chmod(join(skillRoot, "assets"), 0o555);
  await chmod(skillRoot, 0o555);
  await chmod(join(root, "skills"), 0o555);
  const skill = { kind: "skill" as const, id: `component-v1:skill:${componentToken.repeat(64).slice(0, 64)}` as never, name: claim(declaredName, provenance), root: claim("skills/demo", provenance), metadata: [] };
  return {
    schemaVersion: 1,
    scope: plugin.startsWith("user") ? { kind: "user" } : { kind: "project", projectKey: currentProject.projectKey },
    plugin: plugin as never,
    revision: digest(componentToken),
    projectionDigest: digest("e"),
    projectionRef: `runtime-projection-v1:sha256:${"f".repeat(64)}` as never,
    currentProject,
    content: { kind: "plugin", root, identity: {} as never, manifest, contentRef: `plugin-content-v1:sha256:${"a".repeat(64)}` as never },
    data: { root: join(root, "data"), scope: plugin.startsWith("user") ? { kind: "user" } : { kind: "project", projectKey: currentProject.projectKey }, plugin: plugin as never, dataRef: `plugin-data-v1:sha256:${"b".repeat(64)}` as never },
    skills: [skill], hooks: [], contributionDigest: digest("c"),
  } as never;
}

function expectation(value: SkillHookRuntimeSnapshot) {
  return ProjectionExpectationSchema.parse({ kind: "active", projection: {
    schemaVersion: 1,
    scope: value.scope,
    plugin: value.plugin,
    pluginIdentity: {
      key: value.plugin,
      marketplaceName: "community",
      marketplaceEntryName: value.plugin.split("@")[0]!,
    },
    compatibilityDigest: digest("d"),
    revision: value.revision,
    contentRef: value.content.contentRef,
    dataRef: value.data.dataRef,
    components: { skills: value.skills, hooks: [], mcpServers: [] },
    digest: value.projectionDigest,
  }, projectionRef: value.projectionRef });
}

describe("Pi skill resource discovery integration", () => {
  it("contributes immutable user/project files and leaves native collision authority to Pi", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-skill-discovery-integration-"));
    try {
      const userRoot = join(root, "user-revision");
      const projectRoot = join(root, "project-revision");
      await mkdir(userRoot, { recursive: true });
      await mkdir(projectRoot, { recursive: true });
      const user = await publishSkill(userRoot, "user-plugin@community", "a", "same-name");
      const project = await publishSkill(projectRoot, "project-plugin@community", "b", "same-name");
      const values = [user, project];
      let current = values;
      const catalog = createSkillHookRuntimeCatalog();
      catalog.publish(current, currentProject);
      const source: SkillHookSnapshotParticipant = {
        async reconcile() { return { kind: "applied", count: current.length }; },
        async observe(input, _signal) {
          const parsed = ProjectionExpectationSchema.parse(input);
          const value = parsed.kind === "active" ? current.find((item) => item.plugin === parsed.projection.plugin) : undefined;
          if (parsed.kind === "active" && value !== undefined) return { kind: "ready", observation: SkillHookSnapshotObservationSchema.parse({
            kind: "active", participant: "skills-hooks-snapshot", scope: value.scope, plugin: value.plugin, revision: value.revision,
            projectionDigest: value.projectionDigest, currentProject, contributionDigest: value.contributionDigest,
            skillComponentIds: value.skills.map((item) => item.id), hookComponentIds: [],
          }) };
          if (parsed.kind === "inactive") return { kind: "ready", observation: SkillHookSnapshotObservationSchema.parse({
            kind: "inactive", participant: "skills-hooks-snapshot", scope: parsed.scope, plugin: parsed.plugin, projectionDigest: parsed.digest,
            currentProject, contributionDigest: digest("d"), skillComponentIds: [], hookComponentIds: [],
          }) };
          return { kind: "failed", code: "OBSERVATION_MISMATCH" };
        },
      };
      const runtime = createSkillResourceDiscoveryRuntime({ snapshots: source, catalog: catalog.catalog, paths: createManifestSkillPathVerifier({ content: createManifestContentReader(sha256) }), sha256 });
      await runtime.participant.reconcile({ active: [], currentProject }, new AbortController().signal);
      const pi = fakePi();
      registerSkillResourceDiscovery(pi, runtime.resources);
      const handler = handlers.get("resources_discover")![0]!;
      const result = await handler({ type: "resources_discover", cwd: "/workspace/project", reason: "startup" }, context(true));
      expect(result).toEqual({ skillPaths: [join(userRoot, "skills/demo/SKILL.md"), join(projectRoot, "skills/demo/SKILL.md")] });
      const loaded = loadSkills({ cwd: "/workspace/project", agentDir: root, skillPaths: (result as { skillPaths: string[] }).skillPaths, includeDefaults: false });
      expect(loaded.skills).toHaveLength(1);
      expect(loaded.skills[0]?.filePath).toBe(join(userRoot, "skills/demo/SKILL.md"));
      expect(loaded.diagnostics.length).toBeGreaterThan(0);
      expect(await import("node:fs/promises").then(({ readFile }) => readFile(join(projectRoot, "skills/demo/assets/helper.txt"), "utf8"))).toBe("kept beside the skill");
    } finally {
      await makeWritable(root);
      await rm(root, { recursive: true, force: true });
      handlers.clear();
    }
  });

  it("recomputes removal and update paths instead of retaining stale roots", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-skill-discovery-reload-"));
    try {
      const revisionRoot = join(root, "revision-a");
      await mkdir(revisionRoot, { recursive: true });
      const active = await publishSkill(revisionRoot, "user-plugin@community", "a", "active");
      const catalog = createSkillHookRuntimeCatalog();
      catalog.publish([active], currentProject);
      let current = [active];
      const source: SkillHookSnapshotParticipant = {
        async reconcile() { return { kind: "applied", count: current.length }; },
        async observe(input) { const parsed = ProjectionExpectationSchema.parse(input); const value = parsed.kind === "active" ? current.find((item) => item.plugin === parsed.projection.plugin) : undefined; if (value === undefined) return { kind: "ready", observation: SkillHookSnapshotObservationSchema.parse({ kind: "inactive", participant: "skills-hooks-snapshot", scope: parsed.kind === "inactive" ? parsed.scope : { kind: "user" }, plugin: parsed.kind === "inactive" ? parsed.plugin : "user-plugin@community", projectionDigest: parsed.kind === "inactive" ? parsed.digest : digest("d"), currentProject, contributionDigest: digest("d"), skillComponentIds: [], hookComponentIds: [] }) }; return { kind: "ready", observation: SkillHookSnapshotObservationSchema.parse({ kind: "active", participant: "skills-hooks-snapshot", scope: value.scope, plugin: value.plugin, revision: value.revision, projectionDigest: value.projectionDigest, currentProject, contributionDigest: value.contributionDigest, skillComponentIds: value.skills.map((item) => item.id), hookComponentIds: [] }) }; },
      };
      const runtime = createSkillResourceDiscoveryRuntime({ snapshots: source, catalog: catalog.catalog, paths: createManifestSkillPathVerifier({ content: createManifestContentReader(sha256) }), sha256 });
      const signal = new AbortController().signal;
      await runtime.participant.reconcile({ active: [], currentProject }, signal);
      const first = await runtime.resources.discover({ reason: "startup", projectTrusted: true }, signal);
      expect(first).toMatchObject({ kind: "ready", skillPaths: [join(revisionRoot, "skills/demo/SKILL.md")] });
      current = [];
      catalog.publish([], currentProject);
      await runtime.participant.reconcile({ active: [], currentProject }, signal);
      expect(await runtime.resources.discover({ reason: "reload", projectTrusted: true }, signal)).toMatchObject({ kind: "ready", skillPaths: [] });
    } finally {
      await makeWritable(root);
      await rm(root, { recursive: true, force: true });
    }
  });
});