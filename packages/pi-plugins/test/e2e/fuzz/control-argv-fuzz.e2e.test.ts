import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { E2E_SEED, E2E_SECRET_CANARY } from "../harness/constants.js";
import { cleanupSandbox, createCleanE2ESandbox, type CleanE2ESandbox } from "../harness/environment.js";
import { startPackedRpc } from "../harness/journey.js";
import { mutateOpaqueToken, mutationCorpus, type MutationVector } from "../harness/mutation-corpus.js";
import { publicStateDigest } from "../harness/state-inspector.js";

let sandbox: CleanE2ESandbox | undefined;
afterEach(async (context) => {
  if (sandbox !== undefined) await cleanupSandbox(sandbox, context);
  sandbox = undefined;
});

function selectedCorpus(): readonly MutationVector[] {
  const all = mutationCorpus({ seed: E2E_SEED, cases: 128, maxBytes: 8_192 });
  const selected = process.env.PI_PLUGIN_HOST_E2E_CASE;
  return selected === undefined ? all : all.filter((entry) => entry.caseId === selected);
}

describe("bounded packed /plugin grammar and token fuzz", () => {
  it("generates a byte-identical fixed corpus with replay receipts", () => {
    const first = mutationCorpus({ seed: E2E_SEED, cases: 128, maxBytes: 8_192 });
    const second = mutationCorpus({ seed: E2E_SEED, cases: 128, maxBytes: 8_192 });
    expect(second).toEqual(first);
    expect(first).toHaveLength(128);
    expect(Math.max(...first.map((entry) => entry.bytes))).toBeLessThanOrEqual(8_192);
    expect(first.every((entry) => entry.replay.includes(entry.caseId))).toBe(true);
    expect(createHash("sha256").update(JSON.stringify(first)).digest("hex")).toBe("b8741b0a2afa0c77bfe39fa466c50e4674756810a0c9f82603e111e146e51edf");
  });

  it("rejects 128 hostile command vectors with bounded safe output and no authority change", async () => {
    sandbox = await createCleanE2ESandbox("fuzz-control-argv");
    const rpc = await startPackedRpc(sandbox);
    const baseline = await publicStateDigest(rpc);
    for (const vector of selectedCorpus()) {
      try {
        const report = await rpc.plugin(vector.text, undefined, 15_000);
        const output = JSON.stringify(report.envelope);
        expect(report.envelope.exit.code).not.toBe(0);
        expect(output.length).toBeLessThanOrEqual(65_536);
        expect(output).not.toContain(E2E_SECRET_CANARY);
        expect(output).not.toContain("\u001b");
        expect(output).not.toContain(sandbox.root);
        expect(await publicStateDigest(rpc)).toBe(baseline);
      } catch (cause) {
        const reason = cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause);
        throw new Error(`fuzz failure ${vector.caseId}; replay: ${vector.replay}; reason=${reason}; bytes=${JSON.stringify(vector.text)}`, { cause });
      }
    }
    expect(rpc.events.some((event) => event.type === "agent_start")).toBe(false);
    await rpc.shutdown();
  }, 120_000);

  it("never retargets valid-looking opaque token mutations", async () => {
    sandbox = await createCleanE2ESandbox("fuzz-opaque-token");
    const rpc = await startPackedRpc(sandbox);
    const baseline = await publicStateDigest(rpc);
    const token = `trusted-install-session-v1:123e4567-e89b-42d3-a456-426614174000.${"a".repeat(64)}`;
    for (const mutation of mutateOpaqueToken(token)) {
      const report = await rpc.plugin(`--non-interactive operation status ${mutation.value}`, undefined);
      expect(report.envelope.status, mutation.id).toMatch(/failed|not-found|stale/u);
      expect(report.envelope.exit.code).not.toBe(0);
      expect(await publicStateDigest(rpc)).toBe(baseline);
    }
    await rpc.shutdown();
  });
});
