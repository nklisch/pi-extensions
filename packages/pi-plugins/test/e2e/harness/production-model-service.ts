import { createServer } from "node:net";
import { join } from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import { configuredModelPort, E2E_TIMEOUTS } from "./constants.js";
import { acquireExclusiveFile, fixturePath, type CleanE2ESandbox } from "./environment.js";
import { ManagedProcess } from "./process.js";

export type ProductionModelScenario = "mcp" | "subagent-v1" | "subagent-v2";
export type ProductionModelService = Readonly<{
  baseUrl: string;
  requestFile: string;
  selectScenario(id: ProductionModelScenario): Promise<void>;
  stop(): Promise<void>;
}>;

async function assertPortFree(port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", (cause) => reject(new Error(`configured E2E model port ${port} is occupied`, { cause })));
    server.listen({ host: "127.0.0.1", port, exclusive: true }, () => server.close((error) => error === undefined ? resolve() : reject(error)));
  });
}

export async function startProductionModelService(
  sandbox: CleanE2ESandbox,
): Promise<ProductionModelService> {
  const port = configuredModelPort();
  const releaseLock = await acquireExclusiveFile(join("/tmp", `pi-plugin-host-e2e-model-${port}.lock`), `${process.pid}\n`);
  try { await assertPortFree(port); }
  catch (error) { await releaseLock(); throw error; }
  const controlFile = join(sandbox.logs, "production-model-control.txt");
  const requestFile = join(sandbox.logs, "production-model-requests.jsonl");
  await Promise.all([writeFile(controlFile, "mcp\n"), writeFile(requestFile, "")]);
  const modelTemplate = JSON.parse(await readFile(fixturePath("model", "models.json"), "utf8")) as any;
  modelTemplate.providers["production-e2e"].baseUrl = `http://127.0.0.1:${port}/v1`;
  await writeFile(join(sandbox.agentDir, "models.json"), `${JSON.stringify(modelTemplate, null, 2)}\n`);
  const child = ManagedProcess.start(sandbox.capabilities.node, [fixturePath("..", "services", "deterministic-openai.mjs")], {
    cwd: sandbox.project,
    env: {
      ...sandbox.env,
      E2E_MODEL_PORT: String(port),
      E2E_MODEL_CONTROL_FILE: controlFile,
      E2E_MODEL_REQUEST_FILE: requestFile,
    },
    label: `deterministic OpenAI fixture ${port}`,
  });
  let stopped = false;
  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    try {
      await child.terminate();
      child.assertGroupReleased();
    } finally { await releaseLock(); }
  };
  sandbox.cleanups.push(stop);
  try { await child.waitForOutput(`"type":"ready","port":${port}`, { timeoutMs: E2E_TIMEOUTS.startup }); }
  catch (error) { await stop(); throw error; }
  sandbox.diagnostics.push({ name: "production-model", capture: () => ({ output: child.output() }) });
  return Object.freeze({
    baseUrl: `http://127.0.0.1:${port}/v1`,
    requestFile,
    async selectScenario(id: ProductionModelScenario): Promise<void> { await writeFile(controlFile, `${id}\n`); },
    stop,
  });
}
