import { createNodeTransitionJournal } from "../../../src/infrastructure/recovery/sqlite-transition-journal.js";
import { createProcessRevisionLeaseStore } from "../../../src/infrastructure/recovery/process-revision-leases.js";

const [mode] = process.argv.slice(2);
const hostRoot = process.env.RECOVERY_HOST_ROOT;
if (typeof mode !== "string" || typeof hostRoot !== "string") throw new Error("mode and RECOVERY_HOST_ROOT are required");

const pendingCommands = [];
const commandWaiters = new Map();
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  for (const command of chunk.split(/\r?\n/u).filter(Boolean)) {
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

function command(name) {
  const index = pendingCommands.indexOf(name);
  if (index !== -1) {
    pendingCommands.splice(index, 1);
    return Promise.resolve();
  }
  return new Promise((resolve) => commandWaiters.set(name, resolve));
}

function event(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

const signal = new AbortController().signal;

if (mode === "journal") {
  const recordJson = process.env.RECOVERY_RECORD_JSON;
  const preparedAt = Number(process.env.RECOVERY_PREPARED_AT ?? "10");
  if (typeof recordJson !== "string") throw new Error("RECOVERY_RECORD_JSON is required");
  const journal = await createNodeTransitionJournal({ hostRoot, verifyLocalFilesystem: async () => {} });
  event({ event: "ready" });
  await command("prepare");
  try {
    const result = await journal.prepare({ record: JSON.parse(recordJson), preparedAt }, signal);
    event({ event: "prepared", result });
    await command("release");
  } catch (error) {
    event({ event: "error", code: error?.code, message: error instanceof Error ? error.message : String(error), cause: error?.cause instanceof Error ? error.cause.message : undefined, stack: error instanceof Error ? error.stack : undefined });
  }
  process.exit(0);
}

if (mode === "lease") {
  const artifactsJson = process.env.RECOVERY_ARTIFACTS_JSON;
  if (typeof artifactsJson !== "string") throw new Error("RECOVERY_ARTIFACTS_JSON is required");
  const store = await createProcessRevisionLeaseStore({ hostRoot, verifyLocalFilesystem: async () => {} });
  const lease = await store.acquire({
    sessionId: "child-recovery-session",
    artifacts: JSON.parse(artifactsJson),
    at: 10,
  }, signal);
  event({ event: "acquired", leaseId: lease.leaseId });
  await command("release");
  await store.release(lease, 11, signal);
  event({ event: "released" });
  process.exit(0);
}

throw new Error(`unknown recovery child mode: ${mode}`);
