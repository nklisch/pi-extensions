import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createHostPrecedenceService } from "../../src/application/host-precedence-service.js";
import { createNativeControlParser } from "../../src/application/native-control-parser.js";
import { NativeControlCommandSchema } from "../../src/application/native-control-registry.js";
import { GenerationSchema, HostConfigDocumentSchema } from "../../src/domain/state/config-state.js";

const sha256 = (bytes: Uint8Array): Uint8Array => new Uint8Array(createHash("sha256").update(bytes).digest());
const signal = new AbortController().signal;

function environment(hostPrecedence?: readonly ["claude" | "codex", "claude" | "codex"]) {
  let generation = 0;
  let config = HostConfigDocumentSchema.parse({
    schemaVersion: 4,
    generation: GenerationSchema.parse(0),
    global: {
      application: "manual",
      cadence: "balanced",
      ...(hostPrecedence === undefined ? {} : { resolution: { hostPrecedence } }),
    },
    scope: {},
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
      // A concurrent commit landing between the read and this mutation is a
      // generation race; the flag simulates it deterministically.
      if (raceCommit) generation += 1;
      if (request.expectedGeneration !== generation) return { kind: "stale-generation" as const, expected: request.expectedGeneration, actual: generation };
      generation += 1;
      config = HostConfigDocumentSchema.parse({ ...prepared.mutation.replace.config, generation });
      return { kind: "committed" as const, value: prepared.value, snapshot: snapshot() };
    },
  };
  return {
    service: createHostPrecedenceService({ state, mutations, sha256 } as any),
    config: () => config,
    raceNextCommit() { raceCommit = true; },
  };
}

describe("host precedence control command", () => {
  it("parses both precedence orders through the registry grammar", () => {
    const parser = createNativeControlParser();
    for (const order of ["claude-first", "codex-first"] as const) {
      const parsed = parser.parseArgv(["config", "host-precedence", order]);
      expect(parsed.kind).toBe("parsed");
      if (parsed.kind !== "parsed") continue;
      expect(parsed.command).toMatchObject({ command: "config.host-precedence", request: { order } });
    }
    expect(parser.parseArgv(["config", "host-precedence", "codex"]).kind).toBe("invalid");
    expect(parser.parseArgv(["config", "host-precedence"]).kind).toBe("invalid");
  });

  it("validates the raw request through the command schema", () => {
    const invocation = { grammarVersion: "plugin-control/v1", output: "json", nonInteractive: true, input: { kind: "none" } };
    expect(NativeControlCommandSchema.parse({
      command: "config.host-precedence",
      request: { order: "codex-first" },
      invocation,
    })).toMatchObject({ command: "config.host-precedence", request: { order: "codex-first" } });
    expect(() => NativeControlCommandSchema.parse({
      command: "config.host-precedence",
      request: { order: "claude" },
      invocation,
    })).toThrow();
  });

  it("writes codex-first precedence and reads it back from the same state", async () => {
    const env = environment();
    expect(await env.service.currentHostPrecedence()).toEqual(["claude", "codex"]);
    const result = await env.service.setHostPrecedence({ order: "codex-first" }, signal);
    expect(result).toMatchObject({ kind: "changed", order: "codex-first", precedence: ["codex", "claude"] });
    expect(env.config().global.resolution.hostPrecedence).toEqual(["codex", "claude"]);
    expect(await env.service.currentHostPrecedence()).toEqual(["codex", "claude"]);
  });

  it("reports an idempotent rewrite as unchanged", async () => {
    const env = environment(["codex", "claude"]);
    const result = await env.service.setHostPrecedence({ order: "codex-first" }, signal);
    expect(result).toMatchObject({ kind: "unchanged", precedence: ["codex", "claude"] });
  });

  it("reports a generation race as stale without changing state", async () => {
    const env = environment();
    env.raceNextCommit();
    const result = await env.service.setHostPrecedence({ order: "codex-first" }, signal);
    expect(result).toMatchObject({ kind: "stale", reason: "generation" });
    expect(env.config().global.resolution.hostPrecedence).toEqual(["claude", "codex"]);
  });
});
