import { execFile as execFileCallback } from "node:child_process";
import { chmod, lstat, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { join } from "node:path";
import type { PackagedPluginHost } from "../../src/composition/packaged-plugin-host-contract.js";
import { NativeControlCommandSchema } from "../../src/application/native-control-registry.js";

const execFile = promisify(execFileCallback);

export function fakePi() {
  const handlers = new Map<string, Array<(event: unknown, context: unknown) => unknown>>();
  return {
    api: {
      on(name: string, handler: (event: unknown, context: unknown) => unknown) {
        handlers.set(name, [...(handlers.get(name) ?? []), handler]);
      },
      sendMessage() {},
      setSessionName() {},
    },
    handlers,
  };
}

export function extensionContext(cwd: string, trusted = true, sessionId = "marketplace-session") {
  return {
    cwd,
    mode: "interactive",
    sessionManager: { getSessionId: () => sessionId, getSessionFile: () => undefined },
    isProjectTrusted: () => trusted,
  };
}

const invocation = { grammarVersion: "plugin-control/v1" as const, output: "json" as const, nonInteractive: true, input: { kind: "none" as const } };
type TestMarketplace = ReturnType<typeof marketplaceAdapter>;

function marketplaceAdapter(control: import("../../src/application/native-control-service.js").NativePluginControlService, signal: AbortSignal) {
  async function execute(command: string, request: unknown) {
    const report = await control.execute(NativeControlCommandSchema.parse({ command, request, invocation }), { mode: "direct", output: "json" }, signal);
    return report.envelope.data as any;
  }
  return {
    registration: {
      add: (request: any) => execute("marketplace.add", { source: request.source }),
      remove: (request: any) => execute("marketplace.remove", { registrationId: request.registrationId, confirmed: true }),
      list: (request: any) => execute("marketplace.list", { limit: request.limit ?? 50 }),
    },
    refresh: {
      refresh: (request: any) => execute("marketplace.refresh", { ...(request.registrationIds === undefined ? {} : { registrationIds: request.registrationIds }) }),
    },
    catalog: {
      search: (request: any) => execute("browse", { query: request.query ?? "", scope: request.scope ?? "all-current", ...(request.marketplaceIds === undefined ? {} : { marketplaceIds: request.marketplaceIds }), ...(request.availability === undefined ? {} : { availability: request.availability }), ...(request.cursor === undefined ? {} : { cursor: request.cursor }), limit: request.limit ?? 50 }),
      async detail(request: any) {
        const page = await execute("browse", { query: "", scope: "all-current", limit: 100 });
        const candidate = page.candidates.find((entry: any) => entry.id === request.candidateId && entry.snapshot === request.snapshot);
        return candidate === undefined ? { kind: "candidate-missing" } : { kind: "found", candidate: { ...candidate, marketplaceRevision: candidate.available?.marketplaceRevision } };
      },
    },
    adoption: {
      preview: (_request: any) => execute("marketplace.adopt.preview", {}),
      import: (request: any) => execute("marketplace.adopt.import", { candidateIds: request.candidateIds, confirmed: true }),
    },
  };
}

export function runMarketplaceOperation<T>(
  host: Pick<PackagedPluginHost, "runWithPiOperationContext">,
  context: ReturnType<typeof extensionContext>,
  use: (marketplace: TestMarketplace, signal: AbortSignal) => Promise<T>,
  signal = new AbortController().signal,
): Promise<T> {
  return host.runWithPiOperationContext(
    context as never,
    signal,
    (application) => use(marketplaceAdapter(application.control, signal), signal),
  );
}

async function makeDirectoriesWritable(root: string): Promise<void> {
  const stat = await lstat(root).catch(() => undefined);
  if (stat === undefined || !stat.isDirectory() || stat.isSymbolicLink()) return;
  await chmod(root, 0o700).catch(() => undefined);
  for (const name of await readdir(root).catch(() => [])) await makeDirectoriesWritable(join(root, name));
}

/** Tests own their temporary root and may remove sealed immutable payloads. */
export async function removePackagedMarketplaceFixture(root: string): Promise<void> {
  await makeDirectoriesWritable(root);
  await rm(root, { recursive: true, force: true });
}

export async function createLocalMarketplace(root: string, name = "community"): Promise<string> {
  const repository = join(root, `${name}-marketplace`);
  await mkdir(join(repository, ".claude-plugin"), { recursive: true });
  await mkdir(join(repository, "plugins", "demo"), { recursive: true });
  await writeFile(join(repository, ".claude-plugin", "marketplace.json"), JSON.stringify({
    name,
    plugins: [{ name: "demo", source: "./plugins/demo", description: "Offline demo", strict: false }],
  }), "utf8");
  await writeFile(join(repository, "plugins", "demo", "index.js"), "export const demo = true;\n", "utf8");
  await execFile("git", ["init", "--quiet", "-b", "main"], { cwd: repository });
  await execFile("git", ["config", "user.email", "fixture@example.test"], { cwd: repository });
  await execFile("git", ["config", "user.name", "fixture"], { cwd: repository });
  await execFile("git", ["add", "."], { cwd: repository });
  await execFile("git", ["commit", "--quiet", "-m", "fixture"], { cwd: repository });
  return repository;
}
