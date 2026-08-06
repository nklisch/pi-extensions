import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  type ConfigRepairReport,
  repairExistingConfigFiles,
} from "./persistence.ts";

export type ConfigRepairRunner = () => Promise<ConfigRepairReport>;

/** Run the non-creating install repair for existing user-owned config files. */
export async function main(
  repair: ConfigRepairRunner = repairExistingConfigFiles,
): Promise<void> {
  const report = await repair();

  for (const result of report.results) {
    if (result.action === "unchanged") {
      continue;
    }
    if (result.action === "skipped-symlink") {
      console.warn(
        `Pi Clearance skipped symlinked config path ${result.path}; install repair does not follow or replace symlinks.`,
      );
      continue;
    }
    console.log(`Pi Clearance ${result.action} ${result.path}`);
  }

  for (const error of report.errors) {
    console.warn(
      `Pi Clearance could not repair ${error.path}: ${error.message}`,
    );
  }
  if (report.errors.length > 0) {
    throw new Error(
      `Pi Clearance install repair failed for ${report.errors.length} existing config file${report.errors.length === 1 ? "" : "s"}.`,
    );
  }
}

export function isDirectExecution(
  invokedPath: string | undefined,
  modulePath: string,
): boolean {
  return (
    invokedPath !== undefined &&
    path.resolve(invokedPath) === path.resolve(modulePath)
  );
}

if (isDirectExecution(process.argv[1], fileURLToPath(import.meta.url))) {
  await main();
}
