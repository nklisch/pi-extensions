import { describe, expect, it } from "vitest";
import * as api from "../src/index.js";

describe("hook adaptation package boundary", () => {
  it("does not expose planning, Pi, roots, signals, aliases, or execution claims", () => {
    for (const name of [
      "createHookEventPlanner", "HookEventPlanSchema", "createPiHookEventAdapter", "PiHookEventAdapter",
      "PlannedCommandHookSchema", "HookToolIdentitySchema", "HookToolAliasDefinitionRegistry", "HookCancellationSchema",
    ]) expect(name in api).toBe(false);
    expect(api.CompatibilityPolicyRegistry.hookEvents.supported).toHaveLength(9);
  });
});
