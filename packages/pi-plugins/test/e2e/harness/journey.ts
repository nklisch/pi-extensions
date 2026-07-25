import { E2E_TIMEOUTS } from "./constants.js";
import type { CleanE2ESandbox } from "./environment.js";
import { installPackedProduct } from "./environment.js";
import { createGitFixtureRepository, startGitService, type GitFixtureRepository, type GitService } from "./git-service.js";
import { PiRpcProcess, type ControlReport, type PiRpcStartOptions } from "./pi-rpc.js";
import { waitForCondition } from "./process.js";

export type RemoteMarketplaceJourney = Readonly<{
  repository: GitFixtureRepository;
  git: GitService;
  rpc: PiRpcProcess;
  registration: ControlReport;
  browse: ControlReport;
}>;

export async function startPackedRpc(sandbox: CleanE2ESandbox, offline = true): Promise<PiRpcProcess> {
  sandbox.env.PI_OFFLINE = offline ? "1" : "0";
  await installPackedProduct(sandbox);
  return PiRpcProcess.start({ sandbox });
}

export async function seedRemoteMarketplace(
  sandbox: CleanE2ESandbox,
  options: Omit<PiRpcStartOptions, "sandbox"> = {},
): Promise<RemoteMarketplaceJourney> {
  await installPackedProduct(sandbox);
  const repository = await createGitFixtureRepository(sandbox);
  const git = await startGitService(sandbox, repository);
  sandbox.env.PI_OFFLINE = "0";
  const rpc = await PiRpcProcess.start({ sandbox, ...options });
  const registration = await rpc.plugin(
    `--non-interactive marketplace add ${git.url} --source-kind git`,
    "marketplace.add",
    E2E_TIMEOUTS.network,
  );
  if (!["ok", "no-change"].includes(registration.envelope.status)) {
    throw new Error(`marketplace registration failed: ${JSON.stringify(registration)}`);
  }
  const browse = await waitForCondition(
    "remote marketplace catalog publication",
    async () => {
      const report = await rpc.plugin("--non-interactive browse --scope user --limit 50", "browse", E2E_TIMEOUTS.network);
      return Array.isArray(report.envelope.data?.candidates) && report.envelope.data.candidates.length >= 6 ? report : undefined;
    },
    E2E_TIMEOUTS.network,
  );
  let consecutiveIdle = 0;
  await waitForCondition(
    "remote marketplace refresh ownership release",
    async () => {
      const report = await rpc.plugin("--non-interactive marketplace list --limit 50", "marketplace.list");
      const idle = (report.envelope.data?.registrations ?? []).every((entry: any) => entry.refresh?.claim === undefined);
      consecutiveIdle = idle ? consecutiveIdle + 1 : 0;
      return consecutiveIdle >= 2 ? true : undefined;
    },
    E2E_TIMEOUTS.network,
  );
  return Object.freeze({ repository, git, rpc, registration, browse });
}

export function candidate(report: ControlReport, plugin: string): any {
  const value = report.envelope.data?.candidates?.find((entry: any) => entry.plugin === plugin);
  if (value === undefined) throw new Error(`candidate ${plugin} not found in ${JSON.stringify(report.envelope.data)}`);
  return value;
}
