import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { createKeyedMutationScheduler } from "../../../src/infrastructure/state/keyed-mutation-scheduler.js";
import { createGenerationMutationCoordinator } from "../../../src/application/generation-mutation-coordinator.js";
import { parseStateMutation } from "../../../src/application/state-contract.js";
import { HostConfigDocumentSchema } from "../../../src/domain/state/config-state.js";
import { createSqliteScopeLockManager } from "../../../src/infrastructure/state/sqlite-scope-lock.js";

const [lockRoot, statePath, role, mode = "normal"] = process.argv.slice(2);
if (![lockRoot, statePath, role].every((value) => typeof value === "string" && value.length > 0)) {
  throw new Error("lockRoot, statePath, and role are required");
}

const scope = { kind: "user" };
const plugin = "demo@marketplace";
const sha256 = (bytes) => new Uint8Array(createHash("sha256").update(bytes).digest());
const mutation = parseStateMutation({
  scope,
  expectedGeneration: 0,
  replace: {
    config: HostConfigDocumentSchema.parse({ schemaVersion: 4, generation: 0, records: [] }),
  },
}, sha256);

const pendingCommands = [];
const commandWaiters = new Map();
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  for (const command of chunk.split(/\r?\n/).filter(Boolean)) {
    const waiter = commandWaiters.get(command);
    if (waiter !== undefined) {
      commandWaiters.delete(command);
      waiter();
    } else {
      pendingCommands.push(command);
    }
  }
});
process.stdin.resume();

function command(commandName) {
  const index = pendingCommands.indexOf(commandName);
  if (index !== -1) {
    pendingCommands.splice(index, 1);
    return Promise.resolve();
  }
  return new Promise((resolve) => commandWaiters.set(commandName, resolve));
}

function event(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

async function stateSnapshot() {
  const raw = JSON.parse(await readFile(statePath, "utf8"));
  if (!Number.isSafeInteger(raw.generation) || raw.generation < 0) throw new Error("shared generation file is invalid");
  const generation = raw.generation;
  const pointer = (kind) => ({
    kind,
    generation,
    blob: `state-blob-v1:sha256:${"1".repeat(64)}`,
    digest: `sha256:${"0".repeat(64)}`,
  });
  return {
    scope,
    generation,
    pointers: {
      schemaVersion: 1,
      scope,
      generation,
      documents: [pointer("hostConfig"), pointer("installedUser"), pointer("trust")],
    },
    config: { schemaVersion: 4, generation, records: [] },
    installed: { schemaVersion: 2, generation, marketplaces: [], plugins: [] },
    trust: { schemaVersion: 1, generation, records: [] },
    corruptions: [],
  };
}

const locks = await createSqliteScopeLockManager({
  lockRoot,
  retryDelayMs: { minimum: 5, maximum: 5 },
  random: () => 0,
  // This child harness intentionally bypasses only the platform classifier;
  // SQLite's real cross-process transaction and the coordinator remain under test.
  verifyLocalFilesystem: async () => {},
});
event({ event: "ready", role, mode });
await command("go");
event({ event: "started", role });

const controller = new AbortController();
if (mode === "cancel-wait") {
  void command("cancel").then(() => controller.abort(new Error("cancelled while waiting for scope lock")));
}

const state = {
  async read() {
    return { ok: true, snapshot: await stateSnapshot() };
  },
  async commit(value) {
    const current = await stateSnapshot();
    if (value.expectedGeneration !== current.generation) {
      return { kind: "stale-generation", expected: value.expectedGeneration, actual: current.generation };
    }
    await writeFile(statePath, JSON.stringify({ generation: current.generation + 1 }), "utf8");
    return { kind: "committed", snapshot: await stateSnapshot() };
  },
};

const coordinator = createGenerationMutationCoordinator({
  scheduler: createKeyedMutationScheduler(),
  locks,
  state,
});

try {
  const result = await coordinator.runPreparedMutation(
    { scope, plugins: [plugin], expectedGeneration: 0 },
    async () => {
      event({ event: "entered", role });
      if (mode === "pause") await command("continue");
      return { mutation, value: role };
    },
    controller.signal,
  );
  event({ event: "result", role, result });
} catch (error) {
  event({
    event: "error",
    role,
    name: error instanceof Error ? error.name : "UnknownError",
    message: error instanceof Error ? error.message : String(error),
    cause: error instanceof Error && error.cause instanceof Error ? error.cause.message : undefined,
  });
}
