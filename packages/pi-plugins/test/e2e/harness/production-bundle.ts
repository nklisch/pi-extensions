import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import type { CleanE2ESandbox } from "./environment.js";
import type { GitFixtureRepository } from "./git-service.js";
import type { PiRpcProcess } from "./pi-rpc.js";
import { E2E_TIMEOUTS } from "./constants.js";
import { runChecked, waitForCondition } from "./process.js";
import { fileInventory } from "./state-inspector.js";
import type { ProductionModelService } from "./production-model-service.js";

export const PRODUCTION_PLUGIN = "production-bundle@native-e2e-market" as const;
export const productionModelArgs = Object.freeze(["--provider", "production-e2e", "--model", "production-model"]);

export type ProductionBundleRevision = "v1" | "v2";
export type ProductionBundleObservation = Readonly<{
  revision: ProductionBundleRevision;
  skill: "present" | "absent";
  ordinaryHooks: "active" | "inactive";
  subagent: "injected-and-continued" | "inactive";
  mcp: "registered" | "absent";
  alias: "runtime-unavailable-omission";
}>;

export async function installProductionBundle(input: Readonly<{
  sandbox: CleanE2ESandbox;
  rpc: PiRpcProcess;
  version: ProductionBundleRevision;
}>): Promise<Readonly<{ plugin: typeof PRODUCTION_PLUGIN; revision: string }>> {
  const opened = await input.rpc.plugin(
    `--non-interactive install open ${PRODUCTION_PLUGIN} --scope user`,
    "install.open",
  );
  if (opened.envelope.status !== "ok" || opened.envelope.data?.kind !== "opened") {
    throw new Error(`production bundle install did not open: ${JSON.stringify(opened)}`);
  }
  const applied = await input.rpc.plugin(`install apply ${opened.envelope.data.session.token}`, "install.apply");
  if (applied.envelope.status !== "ok" || applied.envelope.data?.kind !== "succeeded") {
    throw new Error(`production bundle install failed: ${JSON.stringify(applied)}`);
  }
  expect(applied.envelope.data).toMatchObject({
    plugin: PRODUCTION_PLUGIN,
    components: { skills: 1, hooks: 3, mcpServers: 2 },
  });
  return Object.freeze({ plugin: PRODUCTION_PLUGIN, revision: applied.envelope.data.revision });
}

export async function runProductionModelTurn(rpc: PiRpcProcess, message: string): Promise<string> {
  const cursor = rpc.events.length;
  await rpc.request({ type: "prompt", message }, E2E_TIMEOUTS.lifecycle);
  await waitForCondition(
    `settled production model turn for ${message}`,
    async () => rpc.events.slice(cursor).some((event) => event?.type === "agent_settled") ? true : undefined,
    E2E_TIMEOUTS.lifecycle,
  );
  const events = rpc.events.slice(cursor);
  const ended = [...events].reverse().find((event) => event?.type === "agent_end");
  return JSON.stringify({ ended, events });
}

async function ownedFileText(sandbox: CleanE2ESandbox, suffix: string): Promise<string> {
  const files = (await fileInventory(sandbox.agentDir)).filter((entry) => entry.kind === "file" && entry.path.endsWith(suffix));
  if (files.length === 0) return "";
  return (await Promise.all(files.map((entry) => readFile(join(sandbox.agentDir, entry.path), "utf8")))).join("\n");
}

export type ProductionHookEvidence = Readonly<{
  event: string;
  revision: ProductionBundleRevision;
  agentId?: string;
  sessionId?: string;
  runId?: string;
  continuationRound?: number;
}>;

/** Durable plugin-owned evidence used to distinguish a fresh hook run from history. */
export async function productionHookEvidence(sandbox: CleanE2ESandbox): Promise<readonly ProductionHookEvidence[]> {
  const text = await ownedFileText(sandbox, "production-hooks.jsonl");
  return Object.freeze(text.split("\n").filter(Boolean).map((line) => Object.freeze(JSON.parse(line)) as ProductionHookEvidence));
}

export async function observeProductionBundle(
  rpc: PiRpcProcess,
  expected: ProductionBundleObservation,
  model?: ProductionModelService,
): Promise<void> {
  const [commands, status, detail, diagnosis] = await Promise.all([
    rpc.request({ type: "get_commands" }),
    rpc.plugin("--non-interactive status", "status"),
    rpc.plugin(`--non-interactive show ${PRODUCTION_PLUGIN} --scope user`, "inspection.show"),
    rpc.plugin(`--non-interactive diagnose ${PRODUCTION_PLUGIN} --scope user`, "inspection.diagnose"),
  ]);
  const skill = commands.data.commands.some((command: any) => command.name === "skill:production-bundle" && command.source === "skill");
  expect(skill).toBe(expected.skill === "present");
  expect(status.envelope.data?.capabilities).toMatchObject({
    mcp: { status: "available" },
    subagents: { status: "available" },
  });
  const serializedDetail = JSON.stringify({ status: status.envelope.data, detail: detail.envelope.data, diagnosis: diagnosis.envelope.data });
  if (expected.skill === "present") {
    expect(detail.envelope).toMatchObject({ status: "ok", data: { kind: "found" } });
    expect(serializedDetail).toContain("RUNTIME_ALIAS_UNAVAILABLE");
    expect(serializedDetail).not.toMatch(/@nklisch\/pi-(?:mcp-adapter|subagents)/u);
  }

  const hooks = await ownedFileText(rpc.sandbox, "production-hooks.jsonl");
  if (expected.ordinaryHooks === "active") expect(hooks).toContain(`\"revision\":\"${expected.revision}\"`);

  if (expected.mcp === "registered") {
    if (model === undefined) throw new Error("production MCP observation requires the external model boundary");
    await model.selectScenario("mcp");
    const observed = await runProductionModelTurn(rpc, "PRODUCTION_MCP_JOURNEY");
    expect(observed).toContain("PARENT_MCP_OBSERVED");
    expect(observed).toContain(`\\\"revision\\\":\\\"${expected.revision}\\\"`);
    expect(observed).toContain("e2e-value");
    expect(await ownedFileText(rpc.sandbox, "production-mcp.jsonl")).toContain(`\"revision\":\"${expected.revision}\"`);
  } else if (model !== undefined) {
    await model.selectScenario("mcp");
    expect(await runProductionModelTurn(rpc, "PRODUCTION_MCP_JOURNEY_ABSENT")).toContain("PARENT_MCP_ABSENT");
  }

  if (expected.subagent === "injected-and-continued") {
    if (model === undefined) throw new Error("production subagent observation requires the external model boundary");
    await model.selectScenario(expected.revision === "v1" ? "subagent-v1" : "subagent-v2");
    const observed = await runProductionModelTurn(rpc, `PRODUCTION_SUBAGENT_JOURNEY_${expected.revision}`);
    expect(observed).toContain(`PARENT_OBSERVED_${expected.revision}`);
    expect(observed).toContain(`CHILD_FINAL_${expected.revision}`);
    expect(observed).toContain("SAME_SESSION_CONTINUATION");
    const evidence = await productionHookEvidence(rpc.sandbox);
    const starts = evidence.filter((entry) => entry.event === "SubagentStart" && entry.revision === expected.revision);
    const stops = evidence.filter((entry) => entry.event === "SubagentStop" && entry.revision === expected.revision);
    expect(starts.length).toBeGreaterThan(0);
    const start = starts.at(-1)!;
    const runStops = stops.filter((entry) => entry.runId === start.runId);
    expect(runStops.map((entry) => entry.continuationRound)).toEqual([0, 1]);
    expect(new Set([start.agentId, ...runStops.map((entry) => entry.agentId)]).size).toBe(1);
    expect(new Set([start.sessionId, ...runStops.map((entry) => entry.sessionId)]).size).toBe(1);
    expect(new Set([start.runId, ...runStops.map((entry) => entry.runId)]).size).toBe(1);
  } else if (model !== undefined) {
    const beforeEvidence = (await ownedFileText(rpc.sandbox, "production-hooks.jsonl")).split("\n").filter(Boolean).length;
    await model.selectScenario(expected.revision === "v1" ? "subagent-v1" : "subagent-v2");
    const observed = await runProductionModelTurn(rpc, `PRODUCTION_SUBAGENT_JOURNEY_${expected.revision}_INACTIVE`);
    expect(observed).toContain(`PARENT_SUBAGENT_UNINJECTED_${expected.revision}`);
    const afterEvidence = (await ownedFileText(rpc.sandbox, "production-hooks.jsonl")).split("\n").filter(Boolean).length;
    expect(afterEvidence).toBe(beforeEvidence);
  }
}

export async function publishProductionBundleRevision(
  sandbox: CleanE2ESandbox,
  repository: GitFixtureRepository,
  revision: ProductionBundleRevision,
): Promise<string> {
  if (revision !== "v2") throw new Error("the committed fixture is production bundle v1");
  const root = join(repository.working, "plugins", "production-bundle");
  const manifestPath = join(root, ".claude-plugin", "plugin.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as any;
  manifest.version = "2.0.0";
  manifest.mcpServers.identity.env.BUNDLE_REVISION = "v2";
  manifest.mcpServers.failing.env.BUNDLE_REVISION = "v2";
  await Promise.all([
    writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`),
    writeFile(join(root, "revision.txt"), "v2\n"),
    writeFile(join(root, "skills", "production-bundle", "SKILL.md"), "---\nname: production-bundle\ndescription: Production full-bundle acceptance skill v2.\n---\n\n# Production Bundle V2\n\nMarker: `PRODUCTION_SKILL_v2`.\n"),
  ]);
  await runChecked(sandbox.capabilities.git, ["add", "."], { cwd: repository.working, env: sandbox.env });
  await runChecked(sandbox.capabilities.git, ["commit", "--quiet", "-m", "production bundle v2"], { cwd: repository.working, env: sandbox.env });
  await runChecked(sandbox.capabilities.git, ["push", "--quiet", "origin", "main"], { cwd: repository.working, env: sandbox.env });
  await runChecked(sandbox.capabilities.git, ["--git-dir", repository.bare, "update-server-info"], { env: sandbox.env });
  return (await runChecked(sandbox.capabilities.git, ["rev-parse", "HEAD"], { cwd: repository.working, env: sandbox.env })).stdout.trim();
}
