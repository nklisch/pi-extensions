import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createHookContextVisibilityProvider, createHookVisibilityService } from "../../src/application/hook-visibility-service.js";
import { createNativeControlParser } from "../../src/application/native-control-parser.js";
import { NativeControlCommandSchema } from "../../src/application/native-control-registry.js";
import { GenerationSchema, HostConfigDocumentSchema } from "../../src/domain/state/config-state.js";

const sha256 = (bytes: Uint8Array): Uint8Array => new Uint8Array(createHash("sha256").update(bytes).digest());
const signal = new AbortController().signal;

function environment(contextVisibility?: "hidden" | "line" | "full") {
  let generation = 0;
  let config = HostConfigDocumentSchema.parse({
    schemaVersion: 4,
    generation: GenerationSchema.parse(0),
    global: { application: "manual", cadence: "balanced" },
    scope: {},
    ...(contextVisibility === undefined ? {} : { hooks: { contextVisibility } }),
    records: [],
  });
  const snapshot = () => ({
    scope: { kind: "user" as const },
    generation: GenerationSchema.parse(generation),
    pointers: { schemaVersion: 1, scope: { kind: "user" }, generation, documents: [] },
    config,
    installed: { schemaVersion: 2, generation, marketplaces: [], plugins: [] },
    trust: { schemaVersion: 1, generation, records: [] },
    corruptions: [],
  }) as any;
  const state = { async read() { return { ok: true as const, snapshot: snapshot() }; } };
  let raceCommit = false;
  const mutations = {
    async runPreparedMutation(request: any, prepare: any) {
      const prepared = await prepare({ snapshot: snapshot(), assertOwned: async () => undefined });
      await prepared.beforeCommit?.();
      if (raceCommit) generation += 1;
      if (request.expectedGeneration !== generation) return { kind: "stale-generation" as const, expected: request.expectedGeneration, actual: generation };
      generation += 1;
      config = HostConfigDocumentSchema.parse({ ...prepared.mutation.replace.config, generation });
      return { kind: "committed" as const, value: prepared.value, snapshot: snapshot() };
    },
  };
  return {
    service: createHookVisibilityService({ state, mutations, sha256 } as any),
    config: () => config,
    raceNextCommit() { raceCommit = true; },
  };
}

describe("hook visibility control command", () => {
  it("parses every visibility value and an omitted positional through the registry grammar", () => {
    const parser = createNativeControlParser();
    for (const visibility of ["hidden", "line", "full"] as const) {
      const parsed = parser.parseArgv(["config", "hook-visibility", visibility]);
      expect(parsed.kind).toBe("parsed");
      if (parsed.kind !== "parsed") continue;
      expect(parsed.command).toMatchObject({ command: "config.hook-visibility", request: { visibility } });
    }
    const read = parser.parseArgv(["config", "hook-visibility"]);
    expect(read.kind).toBe("parsed");
    if (read.kind === "parsed") expect(read.command.request).toEqual({});
    expect(parser.parseArgv(["config", "hook-visibility", "loud"]).kind).toBe("invalid");
  });

  it("validates the raw request through the command schema", () => {
    const invocation = { grammarVersion: "plugin-control/v1", output: "json", nonInteractive: true, input: { kind: "none" } };
    expect(NativeControlCommandSchema.parse({
      command: "config.hook-visibility",
      request: {},
      invocation,
    })).toMatchObject({ command: "config.hook-visibility", request: {} });
    expect(() => NativeControlCommandSchema.parse({
      command: "config.hook-visibility",
      request: { visibility: "loud" },
      invocation,
    })).toThrow();
  });

  it("defaults to the transcript line for pre-existing documents", async () => {
    const env = environment();
    expect(env.config().hooks.contextVisibility).toBe("line");
    expect(await env.service.currentVisibility()).toEqual({ kind: "current", visibility: "line" });
  });

  it("writes a new visibility and reads it back from the same state", async () => {
    const env = environment();
    const result = await env.service.setVisibility({ visibility: "full" }, signal);
    expect(result).toMatchObject({ kind: "changed", visibility: "full" });
    expect(env.config().hooks.contextVisibility).toBe("full");
    expect(await env.service.currentVisibility()).toEqual({ kind: "current", visibility: "full" });
  });

  it("reports an idempotent rewrite as unchanged", async () => {
    const env = environment("hidden");
    const result = await env.service.setVisibility({ visibility: "hidden" }, signal);
    expect(result).toMatchObject({ kind: "unchanged", visibility: "hidden" });
  });

  it("reports a generation race as stale without changing state", async () => {
    const env = environment();
    env.raceNextCommit();
    const result = await env.service.setVisibility({ visibility: "full" }, signal);
    expect(result).toMatchObject({ kind: "stale", reason: "generation" });
    expect(env.config().hooks.contextVisibility).toBe("line");
  });

  it("degrades the call-time provider to the default when state is unreadable", async () => {
    const state = { async read() { return { ok: false as const, corruption: { code: "IO" } }; } };
    expect(await createHookContextVisibilityProvider(state as any)()).toBe("line");
  });
});
