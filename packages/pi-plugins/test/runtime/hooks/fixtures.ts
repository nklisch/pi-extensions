import type { HookComponent } from "../../../src/domain/components.js";
import type { SkillHookRuntimeCatalog } from "../../../src/runtime/skill-hook/runtime-catalog.js";
import type { SkillHookRuntimeSnapshot } from "../../../src/runtime/skill-hook/runtime-snapshot.js";
import type { HookSessionEvidence } from "../../../src/runtime/hooks/event-contract.js";

const provenance = [{ location: { host: "claude" as const, documentKind: "hooks" as const, path: "hooks.json", pointer: "/hooks" } }];
const claim = <T>(value: T) => ({ value, provenance });
export const project = {
  identity: { kind: "path-only" as const, canonicalRoot: "file:///workspace/project/", limitation: "identity-changes-with-canonical-root" as const },
  projectKey: `project-v1:sha256:${"1".repeat(64)}`,
  trust: { kind: "trusted" as const },
};
export const session = (overrides: Partial<HookSessionEvidence> = {}): HookSessionEvidence => ({
  sessionId: "session-1",
  transcriptPath: "/sessions/session-1.jsonl",
  cwd: "/workspace/project",
  currentProject: project,
  piProjectTrusted: true,
  ...overrides,
});
export function hook(event: string, matcher?: string, metadata: readonly unknown[] = [], token = "a"): HookComponent {
  return {
    kind: "hook",
    id: `component-v1:hook:${token.repeat(64).slice(0, 64)}` as HookComponent["id"],
    event: claim(event),
    ...(matcher === undefined ? {} : { matcher: claim(matcher) }),
    handler: claim({ kind: "exec", command: `canary-${token}`, args: [] }),
    metadata,
  } as HookComponent;
}
export function snapshot(scope: { kind: "user" } | { kind: "project"; projectKey: string }, hooks: readonly HookComponent[], plugin = "fixture@community", current = project): SkillHookRuntimeSnapshot {
  return {
    schemaVersion: 1,
    scope,
    plugin: plugin as SkillHookRuntimeSnapshot["plugin"],
    revision: `sha256:${"2".repeat(64)}`,
    projectionDigest: `sha256:${"3".repeat(64)}`,
    projectionRef: `runtime-projection-v1:sha256:${"4".repeat(64)}`,
    currentProject: current,
    content: { kind: "plugin", root: `/content/${scope.kind}`, identity: { kind: "plugin", sourceHash: `sha256:${"5".repeat(64)}`, binding: `sha256:${"6".repeat(64)}`, key: `plugin-store-v1:sha256:${"7".repeat(64)}` }, manifest: {} as never, contentRef: `plugin-content-v1:sha256:${"8".repeat(64)}` },
    data: { root: `/data/${scope.kind}`, scope, plugin: plugin as SkillHookRuntimeSnapshot["plugin"], dataRef: `plugin-data-v1:sha256:${"9".repeat(64)}` },
    skills: [], hooks,
    contributionDigest: `sha256:${"a".repeat(64)}`,
  };
}
export function catalog(snapshots: readonly SkillHookRuntimeSnapshot[]): SkillHookRuntimeCatalog {
  return { list: () => snapshots, get: (scope, plugin) => snapshots.find((value) => value.scope.kind === scope.kind && value.plugin === plugin) };
}
export { claim };
