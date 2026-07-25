import { describe, expect, it } from "vitest";
import { createHostStatusService } from "../../src/composition/host-status-service.js";
import { createUpdateSchedulerStatusProjection } from "../../src/application/update-scheduler-status.js";

const startup = {
  status: "ready" as const,
  blocked: [],
  capabilities: {
    mcp: { status: "unavailable" as const, explanation: "optional" },
    subagents: { status: "unavailable" as const, explanation: "optional" },
    piReload: { status: "available" as const, explanation: "available" },
    secrets: { status: "unavailable" as const, explanation: "optional" },
  },
};

describe("host status service", () => {
  it("keeps optional absent runtimes ready on a clean host", () => {
    const status = createHostStatusService({ startup });
    expect(status.snapshot()).toMatchObject({ status: "ready", local: { recovery: "settled", runtime: "reconciled" } });
  });

  it("projects the scheduler's safe ownership without lease identifiers", () => {
    const schedulerStatus = createUpdateSchedulerStatusProjection();
    const status = createHostStatusService({ startup, schedulerStatus });
    schedulerStatus.publish({ state: "standby", scopes: [{ scope: { kind: "user" }, ownership: "other", nextAt: 10 }] });
    const snapshot = status.snapshot();
    expect(snapshot.update).toMatchObject({ state: "standby", scopes: [{ ownership: "other", nextAt: 10 }] });
    expect(JSON.stringify(snapshot)).not.toContain("lease-v1");
  });

  it("reports background failure as degraded while preserving local readiness", () => {
    const status = createHostStatusService({ startup });
    status.update({ scheduler: "degraded", unreadCount: 2, unresolvedCount: 3 });
    expect(status.snapshot()).toMatchObject({ status: "degraded", local: { recovery: "settled", runtime: "reconciled" }, update: { unreadCount: 2, unresolvedCount: 3 } });
  });
});
