import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import type { CleanE2ESandbox } from "./environment.js";
import { acquireExclusiveFile, fixturePath } from "./environment.js";
import { configuredGitPort, E2E_TIMEOUTS } from "./constants.js";
import { ManagedProcess, runChecked } from "./process.js";

export type GitFixtureRepository = Readonly<{
  working: string;
  bare: string;
  name: string;
}>;

export type GitService = Readonly<{
  process: ManagedProcess;
  url: string;
  phaseFile: string;
  requestFile: string;
  controlFile: string;
  requestCount(): Promise<number>;
  requests(): Promise<readonly Readonly<{ method: string; path: string; query: string; protocol: string }>[]>;
  pause(): void;
  resume(): void;
  kill(): Promise<void>;
  stop(): Promise<void>;
}>;

async function assertPortFree(port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", (cause) => reject(new Error(`configured E2E Git port ${port} is occupied`, { cause })));
    server.listen({ host: "127.0.0.1", port, exclusive: true }, () => server.close((error) => error === undefined ? resolve() : reject(error)));
  });
}

export async function createGitFixtureRepository(
  sandbox: CleanE2ESandbox,
  name = "marketplace",
): Promise<GitFixtureRepository> {
  const root = join(sandbox.root, "git-fixture");
  const working = join(root, `${name}-working`);
  const repositories = join(root, "repositories");
  const bare = join(repositories, `${name}.git`);
  await mkdir(repositories, { recursive: true });
  await cp(fixturePath("marketplace"), working, { recursive: true });
  await runChecked(sandbox.capabilities.git, ["init", "--quiet", "-b", "main"], { cwd: working, env: sandbox.env });
  await runChecked(sandbox.capabilities.git, ["config", "user.email", "e2e@example.invalid"], { cwd: working, env: sandbox.env });
  await runChecked(sandbox.capabilities.git, ["config", "user.name", "Pi Plugin Host E2E"], { cwd: working, env: sandbox.env });
  await runChecked(sandbox.capabilities.git, ["add", "."], { cwd: working, env: sandbox.env });
  await runChecked(sandbox.capabilities.git, ["commit", "--quiet", "-m", "fixture v1"], { cwd: working, env: sandbox.env });
  await runChecked(sandbox.capabilities.git, ["clone", "--quiet", "--bare", working, bare], { cwd: root, env: sandbox.env });
  await runChecked(sandbox.capabilities.git, ["remote", "add", "origin", bare], { cwd: working, env: sandbox.env });
  await runChecked(sandbox.capabilities.git, ["--git-dir", bare, "update-server-info"], { env: sandbox.env });
  return Object.freeze({ working, bare, name });
}

export async function publishFixtureConfigurationFreeRevision(
  sandbox: CleanE2ESandbox,
  repository: GitFixtureRepository,
  version: string,
): Promise<string> {
  const manifestPath = join(repository.working, "plugins", "core-local", ".claude-plugin", "plugin.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
  manifest.version = version;
  delete manifest.userConfig;
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  await runChecked(sandbox.capabilities.git, ["add", "."], { cwd: repository.working, env: sandbox.env });
  await runChecked(sandbox.capabilities.git, ["commit", "--quiet", "-m", `fixture configuration-free ${version}`], { cwd: repository.working, env: sandbox.env });
  await runChecked(sandbox.capabilities.git, ["push", "--quiet", "origin", "main"], { cwd: repository.working, env: sandbox.env });
  await runChecked(sandbox.capabilities.git, ["--git-dir", repository.bare, "update-server-info"], { env: sandbox.env });
  return (await runChecked(sandbox.capabilities.git, ["rev-parse", "HEAD"], { cwd: repository.working, env: sandbox.env })).stdout.trim();
}

export async function publishFixtureRevision(
  sandbox: CleanE2ESandbox,
  repository: GitFixtureRepository,
  version: string,
  marker: string,
): Promise<string> {
  const manifestPath = join(repository.working, "plugins", "core-local", ".claude-plugin", "plugin.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
  manifest.version = version;
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(join(repository.working, "plugins", "core-local", "skills", "core-local", "SKILL.md"), `---\nname: core-local\ndescription: Packed E2E skill ${version}.\n---\n\n# Core Local ${version}\n`);
  await writeFile(join(repository.working, "plugins", "core-local", "hooks", "marker.mjs"), `import { appendFileSync } from "node:fs";\nappendFileSync(process.env.PLUGIN_DATA + "/hook-events.log", ${JSON.stringify(`${marker}\\n`)});\n`);
  await runChecked(sandbox.capabilities.git, ["add", "."], { cwd: repository.working, env: sandbox.env });
  await runChecked(sandbox.capabilities.git, ["commit", "--quiet", "-m", `fixture ${version}`], { cwd: repository.working, env: sandbox.env });
  await runChecked(sandbox.capabilities.git, ["push", "--quiet", "origin", "main"], { cwd: repository.working, env: sandbox.env });
  await runChecked(sandbox.capabilities.git, ["--git-dir", repository.bare, "update-server-info"], { env: sandbox.env });
  const revision = await runChecked(sandbox.capabilities.git, ["rev-parse", "HEAD"], { cwd: repository.working, env: sandbox.env });
  return revision.stdout.trim();
}

export async function startGitService(
  sandbox: CleanE2ESandbox,
  repository: GitFixtureRepository,
): Promise<GitService> {
  const port = configuredGitPort();
  const releaseLock = await acquireExclusiveFile(join("/tmp", `pi-plugin-host-e2e-git-${port}.lock`), `${process.pid}\n`);
  try { await assertPortFree(port); }
  catch (error) { await releaseLock(); throw error; }
  const phaseFile = join(sandbox.logs, "git-service-phases.jsonl");
  const requestFile = join(sandbox.logs, "git-service-requests.jsonl");
  const controlFile = join(sandbox.logs, "git-service-control.txt");
  await Promise.all([phaseFile, requestFile, controlFile].map((path) => writeFile(path, "")));
  const service = fixturePath("..", "services", "git-smart-http.mjs");
  const env = {
    ...sandbox.env,
    E2E_GIT_PORT: String(port),
    E2E_GIT_PROJECT_ROOT: join(sandbox.root, "git-fixture", "repositories"),
    E2E_GIT_HTTP_BACKEND: sandbox.capabilities.gitHttpBackend,
    E2E_GIT_PHASE_FILE: phaseFile,
    E2E_GIT_REQUEST_FILE: requestFile,
    E2E_GIT_CONTROL_FILE: controlFile,
    E2E_GIT_TLS_KEY: fixturePath("tls", "localhost-key.pem"),
    E2E_GIT_TLS_CERT: fixturePath("tls", "localhost-cert.pem"),
  };
  const child = ManagedProcess.start(sandbox.capabilities.node, [service], {
    cwd: sandbox.project,
    env,
    label: `Git smart-HTTP fixture ${port}`,
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
  sandbox.env.GIT_SSL_CAINFO = fixturePath("tls", "localhost-ca.pem");
  sandbox.env.GIT_SSL_VERIFY = "true";
  const url = `https://127.0.0.1:${port}/${repository.name}.git`;
  // The production policy remains fail-closed; the local TLS fixture is an
  // exact operator-approved private origin for this isolated E2E process.
  sandbox.env.PI_PLUGIN_HOST_PRIVATE_ORIGINS = JSON.stringify([`https://127.0.0.1:${port}`]);
  const value: GitService = Object.freeze({
    process: child,
    url,
    phaseFile,
    requestFile,
    controlFile,
    async requestCount(): Promise<number> {
      const text = await readFile(requestFile, "utf8");
      return text.split("\n").filter(Boolean).length;
    },
    async requests() {
      const text = await readFile(requestFile, "utf8");
      return Object.freeze(text.split("\n").filter(Boolean).map((line) => {
        const request = JSON.parse(line) as { method: string; path: string; query: string; protocol: string };
        return Object.freeze({ method: request.method, path: request.path, query: request.query, protocol: request.protocol });
      }));
    },
    pause(): void { child.signal("SIGSTOP"); },
    resume(): void { child.signal("SIGCONT"); },
    async kill(): Promise<void> { child.signal("SIGKILL"); await child.waitForExit(E2E_TIMEOUTS.shutdown); },
    stop,
  });
  return value;
}
