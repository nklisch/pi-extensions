import { describe, expect, it } from "vitest";
import {
  NativeUpdateAcknowledgmentRequestSchema,
  NativeUpdateNotificationViewSchema,
} from "../../src/application/native-update-contract.js";
import { UpdatePolicyChangeSchema } from "../../src/domain/update-policy.js";

const id = `update-notice-v1:sha256:${"a".repeat(64)}`;

describe("native update contracts", () => {
  it("rejects global inheritance and unknown policy fields", () => {
    expect(UpdatePolicyChangeSchema.safeParse({ kind: "application", target: { kind: "global" }, mode: "inherit" }).success).toBe(false);
    expect(UpdatePolicyChangeSchema.safeParse({ kind: "cadence", target: { kind: "global" }, cadence: "balanced", path: "/secret" }).success).toBe(false);
  });

  it("keeps unread separate from unresolved and rejects duplicate acknowledgments", () => {
    expect(NativeUpdateNotificationViewSchema.parse({
      id,
      scope: { kind: "user" },
      plugin: "demo@community",
      installed: "1.0.0",
      available: "1.1.0",
      disposition: "automatic-applied",
      unread: true,
      unresolved: false,
      discoveredAt: 1,
    })).toMatchObject({ unread: true, unresolved: false });
    expect(NativeUpdateAcknowledgmentRequestSchema.safeParse({ ids: [id, id] }).success).toBe(false);
  });
});
