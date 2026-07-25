import { describe, expect, it } from "vitest";
import { createProcessRefreshClaimOwner } from "../../../src/infrastructure/process/refresh-claim-owner.js";

describe("process refresh claim ownership", () => {
  it("distinguishes the live process from a reused PID on Linux", () => {
    const owners = createProcessRefreshClaimOwner();
    const current = owners.current();
    if (process.platform !== "linux") {
      expect(current).toBeUndefined();
      return;
    }
    expect(current).toBeDefined();
    expect(owners.status(current!)).toBe("live");
    expect(owners.status({
      pid: current!.pid,
      startToken: `${BigInt(current!.startToken) + 1n}`,
    })).toBe("dead");
  });
});
