import { describe, expect, it } from "vitest";
import {
  DEFAULT_HOST_PRECEDENCE,
  HostPrecedenceSchema,
  hostRank,
} from "../../src/domain/host-precedence.js";

describe("host precedence", () => {
  it("accepts each host exactly once in either order", () => {
    expect(HostPrecedenceSchema.parse(["claude", "codex"])).toEqual(["claude", "codex"]);
    expect(HostPrecedenceSchema.parse(["codex", "claude"])).toEqual(["codex", "claude"]);
  });

  it("rejects duplicates, missing hosts, and unknown hosts", () => {
    expect(HostPrecedenceSchema.safeParse(["claude", "claude"]).success).toBe(false);
    expect(HostPrecedenceSchema.safeParse(["codex", "codex"]).success).toBe(false);
    expect(HostPrecedenceSchema.safeParse(["claude"]).success).toBe(false);
    expect(HostPrecedenceSchema.safeParse(["claude", "codex", "claude"]).success).toBe(false);
    expect(HostPrecedenceSchema.safeParse(["claude", "other"]).success).toBe(false);
  });

  it("keeps the canonical default Claude-first", () => {
    expect(DEFAULT_HOST_PRECEDENCE).toEqual(["claude", "codex"]);
  });

  it("ranks hosts by their index in the precedence ordering", () => {
    expect(hostRank(["claude", "codex"], "claude")).toBe(0);
    expect(hostRank(["claude", "codex"], "codex")).toBe(1);
    expect(hostRank(["codex", "claude"], "codex")).toBe(0);
    expect(hostRank(["codex", "claude"], "claude")).toBe(1);
  });
});
