import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  createExecutableSurface,
  digestExecutableSurface,
  ExecutableSurfaceSchema,
} from "../../src/domain/executable-surface.js";
import { createCompatibilityReport } from "../../src/domain/compatibility.js";
import { flattenComponents } from "../../src/domain/components.js";
import { directPlugin, claimFixture, componentId } from "../fixtures/compatibility/common.js";

const sha256 = (bytes: Uint8Array): Uint8Array =>
  new Uint8Array(createHash("sha256").update(bytes).digest());

function reportFor(plugin: ReturnType<typeof directPlugin>) {
  return createCompatibilityReport({
    plugin: plugin.identity,
    activatable: true,
    components: flattenComponents(plugin.components).map((component) => ({
      componentId: component.id,
      verdict: { kind: "supported" },
      requirementIds: [],
      diagnostics: [],
    })),
    requirements: [],
    diagnostics: [],
  });
}

function hook(idToken: string, command: string) {
  return {
    kind: "hook" as const,
    id: componentId("hook", idToken),
    event: claimFixture("SessionStart"),
    handler: claimFixture({ kind: "shell" as const, command }),
    metadata: [],
  };
}

describe("canonical executable surface", () => {
  it("derives one stable projection despite declaration and provenance ordering", () => {
    const first = directPlugin({
      components: { hooks: [hook("a", "echo ready")] },
      configuration: { options: [
        {
          key: "TOKEN",
          label: claimFixture("Token"),
          value: { kind: "string" },
          required: true,
          sensitive: true,
          provenance: [claimFixture("TOKEN").provenance[0]!],
        },
      ] },
    });
    const second = directPlugin({
      components: { hooks: [hook("a", "echo ready")] },
      configuration: { options: [
        {
          key: "TOKEN",
          label: claimFixture("A different label"),
          value: { kind: "string" },
          required: true,
          sensitive: true,
          provenance: [claimFixture("other").provenance[0]!],
        },
      ] },
    });

    const firstSurface = createExecutableSurface(first, reportFor(first));
    const secondSurface = createExecutableSurface(second, reportFor(second));
    expect(firstSurface).toEqual(secondSurface);
    expect(digestExecutableSurface(firstSurface, sha256)).toBe(
      digestExecutableSurface(secondSurface, sha256),
    );
    expect(ExecutableSurfaceSchema.parse(firstSurface)).toEqual(firstSurface);
  });

  it("includes execution-defining hook fields and rejects incomplete reports", () => {
    const plugin = directPlugin({ components: { hooks: [hook("a", "echo ready")] } });
    const report = reportFor(plugin);
    expect(() => createExecutableSurface(plugin, {
      ...report,
      components: [],
    })).toThrow();
    const changed = directPlugin({ components: { hooks: [hook("a", "echo changed")] } });
    expect(digestExecutableSurface(
      createExecutableSurface(plugin, report),
      sha256,
    )).not.toBe(digestExecutableSurface(createExecutableSurface(changed, reportFor(changed)), sha256));
  });

  it("does not project foreign metadata-only components as executable entries", () => {
    const plugin = directPlugin({ components: { foreign: [{
      kind: "foreign",
      id: componentId("foreign", "f"),
      nativeHost: "claude",
      nativeKind: claimFixture("future"),
      declarationSubkey: "future",
      declaration: claimFixture({ enabled: true }),
    }] } });
    const surface = createExecutableSurface(plugin, reportFor(plugin));
    expect(surface.entries).toEqual([]);
  });
});
