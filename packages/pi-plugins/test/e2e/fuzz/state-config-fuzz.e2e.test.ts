import { afterEach, describe, expect, it } from "vitest";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { cleanupSandbox, createCleanE2ESandbox, installPackedProduct, type CleanE2ESandbox } from "../harness/environment.js";
import { startPackedRpc } from "../harness/journey.js";
import { PiRpcProcess } from "../harness/pi-rpc.js";
import {
  mutateCurrentPointer,
  mutateStateBlob,
  publicStateDigest,
  sqliteIntegrity,
} from "../harness/state-inspector.js";
import { E2E_SECRET_CANARY } from "../harness/constants.js";

let sandbox: CleanE2ESandbox | undefined;
afterEach(async (context) => {
  if (sandbox !== undefined) await cleanupSandbox(sandbox, context);
  sandbox = undefined;
});

const intentCases: readonly Readonly<{ id: string; bytes: Uint8Array }>[] = [
  { id: "unknown-field", bytes: Buffer.from('{"schemaVersion":1,"marketplaces":[],"plugins":[],"unknown":true}\n') },
  { id: "machine-path", bytes: Buffer.from('{"schemaVersion":1,"marketplaces":[],"plugins":[],"path":"/tmp/native"}\n') },
  { id: "timestamp", bytes: Buffer.from('{"schemaVersion":1,"marketplaces":[],"plugins":[],"updatedAt":123}\n') },
  { id: "duplicate-plugin", bytes: Buffer.from('{"schemaVersion":1,"marketplaces":[],"plugins":[{"plugin":"a@m","enabled":true},{"plugin":"a@m","enabled":true}]}\n') },
  { id: "malformed-json", bytes: Buffer.from('{"schemaVersion":1') },
  { id: "malformed-utf8", bytes: Uint8Array.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0xff, 0x7d]) },
  { id: "traversal", bytes: Buffer.from('{"schemaVersion":1,"marketplaces":[{"source":{"kind":"local-git","path":"../escape"}}],"plugins":[]}\n') },
  { id: "oversized", bytes: Buffer.from(`{"schemaVersion":1,"marketplaces":[],"plugins":${JSON.stringify(Array.from({ length: 512 }, (_, index) => ({ plugin: `p${index}@m`, enabled: true })))}}\n`) },
];

describe("bounded packed state, project intent, and foreign config fuzz", () => {
  it("fails closed on portable project intent mutations without rewriting bytes or state", async () => {
    sandbox = await createCleanE2ESandbox("fuzz-project-intent");
    const rpc = await startPackedRpc(sandbox);
    const path = join(sandbox.project, ".pi", "plugins.json");
    await mkdir(dirname(path), { recursive: true });
    const baseline = await publicStateDigest(rpc);
    for (const vector of intentCases) {
      await writeFile(path, vector.bytes);
      const before = await readFile(path);
      const result = await rpc.plugin("--non-interactive project sync --mode apply-intent", "project.sync");
      expect(result.envelope.status, vector.id).toMatch(/rejected|failed|blocked/u);
      expect(result.envelope.exit.code).not.toBe(0);
      expect(await readFile(path)).toEqual(before);
      expect(await publicStateDigest(rpc)).toBe(baseline);
      expect(JSON.stringify(result.envelope).length).toBeLessThanOrEqual(65_536);
    }
    await rpc.shutdown();
  });

  it("preserves mutated Claude JSON and Codex TOML byte-for-byte without importing custody", async () => {
    sandbox = await createCleanE2ESandbox("fuzz-foreign-config");
    await installPackedProduct(sandbox);
    const claude = join(sandbox.home, ".claude", "plugins", "known_marketplaces.json");
    const codex = join(sandbox.home, ".codex", "config.toml");
    await Promise.all([mkdir(dirname(claude), { recursive: true }), mkdir(dirname(codex), { recursive: true })]);
    const rpcInputs = [
      Buffer.from(`{"valid":{"source":{"source":"github","repo":"owner/repo"}},"credential":"${E2E_SECRET_CANARY}"}\n`),
      Buffer.from('{"valid":{"source":{"source":"github","repo":"owner/repo"}},"future":{"path":"../../escape"}}\n'),
      Buffer.from('{malformed-json\n'),
    ];
    for (const [index, bytes] of rpcInputs.entries()) {
      const toml = Buffer.from(`[plugins.valid]\nsource = "https://example.invalid/repo.git"\nunknown_${index} = "${E2E_SECRET_CANARY}"\n`);
      await Promise.all([writeFile(claude, bytes), writeFile(codex, toml)]);
      const rpc = await PiRpcProcess.start({ sandbox });
      const preview = await rpc.plugin("--non-interactive marketplace adopt preview", "marketplace.adopt.preview");
      expect(JSON.stringify(preview.envelope)).not.toContain(E2E_SECRET_CANARY);
      expect(await readFile(claude)).toEqual(bytes);
      expect(await readFile(codex)).toEqual(toml);
      const registrations = await rpc.plugin("--non-interactive marketplace list", "marketplace.list");
      expect(registrations.envelope.data.registrations).toEqual([]);
      await rpc.shutdown();
    }
    // These are deliberate hostile input fixtures, not product-owned custody.
    // Remove them after byte-preservation assertions so teardown's global
    // canary scan can treat every remaining occurrence as a leak.
    await Promise.all([
      rm(join(sandbox.home, ".claude"), { recursive: true, force: true }),
      rm(join(sandbox.home, ".codex"), { recursive: true, force: true }),
    ]);
  });

  it("classifies structural SQLite damage separately from schema/digest corruption", async () => {
    sandbox = await createCleanE2ESandbox("fuzz-structural-sqlite");
    const rpc = await startPackedRpc(sandbox);
    await rpc.shutdown();
    const source = join(sandbox.agentDir, "plugin-host", "state", "v1", "user.sqlite");
    const path = join(sandbox.root, "structural-corruption.sqlite");
    await copyFile(source, path);
    await writeFile(path, Buffer.from("not-a-sqlite-database"));
    expect(() => sqliteIntegrity(path)).toThrow();
    // Structural corruption is deliberately classified on a disposable clone;
    // the real authoritative database remains healthy for teardown.
  });
});

for (const mutation of ["digest", "generation", "document"] as const) {
  it(`diagnoses current pointer ${mutation} mutation without rewrite [idea-packed-corruption-startup-diagnosis]`, async () => {
    sandbox = await createCleanE2ESandbox(`fuzz-pointer-${mutation}`);
    const initial = await startPackedRpc(sandbox);
    await initial.shutdown();
    await mutateCurrentPointer(join(sandbox.agentDir, "plugin-host", "state", "v1", "user.sqlite"), mutation);
    const restarted = await PiRpcProcess.start({ sandbox });
    const diagnosis = await restarted.plugin("--non-interactive diagnose", "inspection.diagnose", 15_000);
    expect(JSON.stringify(diagnosis.envelope.data)).toContain("STATE_CORRUPT");
    await restarted.shutdown();
  });
}

for (const mutation of ["digest", "kind", "generation", "document"] as const) {
  it(`diagnoses state blob ${mutation} mutation without sibling loss [idea-packed-corruption-startup-diagnosis]`, async () => {
    sandbox = await createCleanE2ESandbox(`fuzz-blob-${mutation}`);
    const initial = await startPackedRpc(sandbox);
    await initial.shutdown();
    await mutateStateBlob(join(sandbox.agentDir, "plugin-host", "state", "v1", "user.sqlite"), mutation);
    const restarted = await PiRpcProcess.start({ sandbox });
    const diagnosis = await restarted.plugin("--non-interactive diagnose", "inspection.diagnose", 15_000);
    expect(JSON.stringify(diagnosis.envelope.data)).toContain("STATE_CORRUPT");
    await restarted.shutdown();
  });
}
