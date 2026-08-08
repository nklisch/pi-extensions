import type { RefreshClaimOwnerPort } from "../../application/ports/refresh-claim-owner.js";
import { classifyProcessIdentity, readProcessStartToken } from "./process-identity.js";

/** Cross-platform PID + start-token authority; unavailable probes remain safely unknown. */
export function createProcessRefreshClaimOwner(): RefreshClaimOwnerPort {
  const startToken = readProcessStartToken(process.pid);
  const current = startToken === undefined
    ? undefined
    : Object.freeze({ pid: process.pid, startToken });
  return Object.freeze({
    current: () => current,
    status: (owner: Parameters<RefreshClaimOwnerPort["status"]>[0]) => classifyProcessIdentity(owner),
  });
}
