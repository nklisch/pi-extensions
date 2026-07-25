import { describe, expect, it, vi } from "vitest";
import { createNativeControlService } from "../../src/composition/create-native-control-service.js";

describe("native control composition", () => {
  it("is construction-inert and exposes one cohesive facade", () => {
    const ids = { issue: vi.fn() };
    const applications = { marketplace: { registration: {}, refresh: {}, catalog: {}, adoption: {} }, inspection: {}, trustedInstallation: {}, operations: {}, updates: {}, status: { snapshot: vi.fn() }, currentProject: { current: vi.fn() } };
    const service = createNativeControlService({ applications: applications as never, ids: ids as never, timeouts: { arm: vi.fn() } as never });
    expect(Object.keys(service).sort()).toEqual(["cancel", "close", "complete", "execute", "grammarVersion", "help", "parseArgv", "parseText", "poll", "quiesce", "runArgv", "runText"]);
    expect(ids.issue).not.toHaveBeenCalled();
    expect(applications.status.snapshot).not.toHaveBeenCalled();
  });
});
