import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  composeSkillHookContributionObservation,
  SkillHookSnapshotObservationSchema,
  SkillResourceContributionObservationSchema,
} from "../../../src/runtime/skills/contribution-observation.js";
import { composeActivationObservation } from "../../../src/application/ports/lifecycle-reload.js";
import { ProjectionExpectationSchema, createInactiveProjectionExpectation } from "../../../src/application/ports/runtime-projection.js";
import type { ProjectionExpectation } from "../../../src/application/ports/runtime-projection.js";
import { ContentDigestSchema } from "../../../src/domain/content-manifest.js";
import type { ComponentId } from "../../../src/domain/components.js";
import type { CurrentProjectRuntimeContext } from "../../../src/application/ports/project-trust.js";

const sha256 = (bytes: Uint8Array): Uint8Array => new Uint8Array(createHash("sha256").update(bytes).digest());
const digest = (letter: string) => ContentDigestSchema.parse(`sha256:${letter.repeat(64)}`);
const component = (letter: string) => `component-v1:skill:${letter.repeat(64)}` as ComponentId;
const project = {
  identity: { kind: "path-only", canonicalRoot: "file:///workspace/", limitation: "identity-changes-with-canonical-root" },
  projectKey: `project-v1:sha256:${"1".repeat(64)}`,
  trust: { kind: "trusted" },
} as CurrentProjectRuntimeContext;

function activeExpectation(): Extract<ProjectionExpectation, { kind: "active" }> {
  const parsed = ProjectionExpectationSchema.parse({
    kind: "active",
    projection: {
      schemaVersion: 1,
      scope: { kind: "user" },
      plugin: "demo@community",
      pluginIdentity: {
        key: "demo@community",
        marketplaceName: "community",
        marketplaceEntryName: "demo",
      },
      compatibilityDigest: digest("5"),
      revision: digest("a"),
      contentRef: `plugin-content-v1:sha256:${"2".repeat(64)}`,
      dataRef: `plugin-data-v1:sha256:${"3".repeat(64)}`,
      components: { skills: [], hooks: [], mcpServers: [] },
      digest: digest("b"),
    },
    projectionRef: `runtime-projection-v1:sha256:${"4".repeat(64)}`,
  });
  if (parsed.kind !== "active") throw new Error("active fixture did not parse");
  return parsed;
}

function sourceAndResource(expectation: Extract<ProjectionExpectation, { kind: "active" }>) {
  const source = SkillHookSnapshotObservationSchema.parse({
    kind: "active",
    participant: "skills-hooks-snapshot",
    scope: expectation.projection.scope,
    plugin: expectation.projection.plugin,
    revision: expectation.projection.revision,
    projectionDigest: expectation.projection.digest,
    currentProject: project,
    contributionDigest: digest("c"),
    skillComponentIds: [],
    hookComponentIds: [],
  });
  const resources = SkillResourceContributionObservationSchema.parse({
    kind: "active",
    participant: "skill-resources",
    scope: expectation.projection.scope,
    plugin: expectation.projection.plugin,
    revision: expectation.projection.revision,
    projectionDigest: expectation.projection.digest,
    currentProject: project,
    contributionDigest: digest("d"),
    skillComponentIds: [],
  }) as Extract<ReturnType<typeof SkillResourceContributionObservationSchema.parse>, { kind: "active" }>;
  return { source, resources };
}

describe("skill/hook contribution observation", () => {
  it("composes empty skill slices only from matching source and resource evidence", () => {
    const expectation = activeExpectation();
    const { source, resources } = sourceAndResource(expectation);
    const result = composeSkillHookContributionObservation({ expectation, snapshot: source, resources, sha256 });
    expect(result).toMatchObject({ participant: "skills-hooks", kind: "active", skillComponentIds: [], hookComponentIds: [] });
    expect(() => composeActivationObservation({ expectation, skillsHooks: source as never, mcp: {
      kind: "active", participant: "mcp", scope: expectation.projection.scope, plugin: expectation.projection.plugin,
      revision: expectation.projection.revision, projectionDigest: expectation.projection.digest, currentProject: project,
      contributionDigest: digest("e"), registration: { kind: "none" },
    } })).toThrow();
  });

  it("rejects component, project, and projection mismatches", () => {
    const expectation = activeExpectation();
    const { source, resources } = sourceAndResource(expectation);
    expect(() => composeSkillHookContributionObservation({
      expectation,
      snapshot: source,
      resources: { ...resources, skillComponentIds: [component("f")] },
      sha256,
    })).toThrow();
    expect(() => composeSkillHookContributionObservation({
      expectation,
      snapshot: source,
      resources: { ...resources, currentProject: { ...project, trust: { kind: "untrusted" } } },
      sha256,
    })).toThrow();
  });

  it("proves inactive absence with the exact tombstone and both participants", () => {
    const expectation = createInactiveProjectionExpectation({ scope: { kind: "user" }, plugin: "demo@community", sha256 });
    const source = SkillHookSnapshotObservationSchema.parse({
      kind: "inactive", participant: "skills-hooks-snapshot", scope: expectation.scope, plugin: expectation.plugin,
      projectionDigest: expectation.digest, currentProject: project, contributionDigest: digest("1"),
      skillComponentIds: [], hookComponentIds: [],
    });
    const resources = SkillResourceContributionObservationSchema.parse({
      kind: "inactive", participant: "skill-resources", scope: expectation.scope, plugin: expectation.plugin,
      projectionDigest: expectation.digest, currentProject: project, contributionDigest: digest("2"), skillComponentIds: [],
    });
    expect(composeSkillHookContributionObservation({ expectation, snapshot: source, resources, sha256 })).toMatchObject({ kind: "inactive", projectionDigest: expectation.digest });
  });
});