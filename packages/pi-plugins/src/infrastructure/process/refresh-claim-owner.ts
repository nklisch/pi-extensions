import type { RefreshClaimOwnerPort } from "../../application/ports/refresh-claim-owner.js";
import { classifyProcessIdentity, readLinuxProcessStartToken } from "./process-identity.js";

/** Linux PID + start-token authority; unsupported hosts remain safely unknown. */
export function createProcessRefreshClaimOwner(): RefreshClaimOwnerPort {
  const startToken = readLinuxProcessStartToken(process.pid);
  const current = startToken === undefined
    ? undefined
    : Object.freeze({ pid: process.pid, startToken });
  return Object.freeze({
    current: () => current,
    status: (owner: Parameters<RefreshClaimOwnerPort["status"]>[0]) => classifyProcessIdentity(owner),
  });
}
