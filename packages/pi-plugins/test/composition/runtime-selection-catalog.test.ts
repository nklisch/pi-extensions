import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { McpLaunchBindingSchemaV1 } from "../../src/application/ports/mcp-launch-context.js";
import { deriveMcpRuntimeServerKey } from "../../src/application/ports/mcp-runtime.js";
import { deriveProjectKey } from "../../src/domain/state/scope.js";
import { createRuntimeSelectionCatalog, type RuntimeSelection } from "../../src/composition/runtime-selection-catalog.js";
import { mcp } from "../fixtures/compatibility/mcp.js";

const sha256 = (bytes: Uint8Array): Uint8Array => new Uint8Array(createHash("sha256").update(bytes).digest());
const identity = { kind: "path-only" as const, canonicalRoot: "file:///workspace/project/" as never, limitation: "identity-changes-with-canonical-root" as const };
const currentProject = { identity, projectKey: deriveProjectKey(identity, sha256), trust: { kind: "trusted" as const } };
const component = mcp({ command: "server" }, "catalog") as never;
const binding = McpLaunchBindingSchemaV1.parse({
  schemaVersion: 1,
  source: {
    schemaVersion: 1,
    scope: { kind: "user" },
    plugin: "direct@community",
    revision: `sha256:${"1".repeat(64)}`,
    projectionDigest: `sha256:${"2".repeat(64)}`,
  },
  serverKey: deriveMcpRuntimeServerKey(component.id),
  componentId: component.id,
  transport: "stdio",
});

function selection(value: string): RuntimeSelection {
  return {
    scope: { kind: "user" },
    plugin: "direct@community" as never,
    revision: { revision: `sha256:${"1".repeat(64)}`, evidence: { compatibility: { fingerprint: `sha256:${"3".repeat(64)}` } } } as never,
    compatibility: {} as never,
    skillHook: { prepared: { expectation: { projection: { digest: `sha256:${"2".repeat(64)}` } } } } as never,
    hooks: [],
    mcp: [{ binding, selection: { value } as never }],
  };
}

describe("runtime selection catalog", () => {
  it("exposes a monotonic content-bound read epoch", async () => {
    const catalog = createRuntimeSelectionCatalog(currentProject);
    const initial = catalog.snapshot().epoch;
    await catalog.replace([selection("first")], currentProject);
    const first = catalog.snapshot().epoch;
    await catalog.replace([selection("first")], currentProject);
    const second = catalog.snapshot().epoch;
    expect(first).not.toBe(initial);
    expect(second).not.toBe(first);
    expect(first).toMatch(/^sha256:[0-9a-f]{64}$/);
    await catalog.close();
  });

  it("atomically replaces epochs while admitted MCP callbacks retain the old immutable selection", async () => {
    const catalog = createRuntimeSelectionCatalog(currentProject);
    await catalog.replace([selection("old")], currentProject);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let observed: string | undefined;
    const oldCallback = catalog.withSelection(binding, new AbortController().signal, async (selected) => {
      observed = (selected as unknown as { value: string }).value;
      await gate;
      expect((selected as unknown as { value: string }).value).toBe("old");
    });
    await Promise.resolve();
    await catalog.replace([selection("new")], currentProject);
    await catalog.withSelection(binding, new AbortController().signal, async (selected) => {
      expect((selected as unknown as { value: string }).value).toBe("new");
    });
    expect(observed).toBe("old");
    release();
    await oldCallback;
    await catalog.close();
  });

  it("rejects new callbacks during close and drains existing pins idempotently", async () => {
    const catalog = createRuntimeSelectionCatalog(currentProject);
    await catalog.replace([selection("active")], currentProject);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const callback = catalog.withSelection(binding, new AbortController().signal, async () => gate);
    await Promise.resolve();
    let closed = false;
    const closing = catalog.close().then(() => { closed = true; });
    await Promise.resolve();
    expect(closed).toBe(false);
    await expect(catalog.withSelection(binding, new AbortController().signal, async () => {})).rejects.toThrow("closed");
    release();
    await callback;
    await closing;
    await catalog.close();
  });
});
