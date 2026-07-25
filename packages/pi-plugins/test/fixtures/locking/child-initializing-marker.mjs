import { readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

const [databasePath, rootIdentity, databaseName] = process.argv.slice(2);
if (![databasePath, rootIdentity, databaseName].every((value) => typeof value === "string" && value.length > 0)) {
  throw new Error("databasePath, rootIdentity, and databaseName are required");
}

function processStartTime(pid) {
  const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  const closingParenthesis = stat.lastIndexOf(")");
  return stat.slice(closingParenthesis + 2).trim().split(/\s+/)[19];
}

const marker = {
  protocol: "pi-plugin-host-scope-lock-database",
  version: 1,
  rootIdentity,
  database: databaseName,
  state: "initializing",
  owner: { pid: process.pid, startTime: processStartTime(process.pid) },
};
const claimPath = `${databasePath}.initializing`;
const markerPath = `${databasePath}.identity`;
const claimTemp = `${claimPath}.${randomUUID()}.tmp`;
const markerTemp = `${markerPath}.${randomUUID()}.tmp`;
writeFileSync(claimTemp, `${JSON.stringify(marker)}\n`, { flag: "wx", mode: 0o600 });
renameSync(claimTemp, claimPath);
writeFileSync(markerTemp, `${JSON.stringify(marker)}\n`, { flag: "wx", mode: 0o600 });
renameSync(markerTemp, markerPath);
process.stdout.write("initializing\n");
process.stdin.resume();
process.stdin.on("data", () => {});
process.on("SIGTERM", () => process.exit(0));
