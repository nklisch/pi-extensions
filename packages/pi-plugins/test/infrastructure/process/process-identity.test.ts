import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return { ...actual, readFileSync: vi.fn(actual.readFileSync) };
});

import { readFileSync } from "node:fs";
import { classifyProcessIdentity } from "../../../src/infrastructure/process/process-identity.js";

const mockedReadFileSync = vi.mocked(readFileSync);

function statWithStartToken(token: string): string {
  return `1 (node) S ${Array.from({ length: 18 }, () => "0").join(" ")} ${token}`;
}

describe("process identity", () => {
  const kill = vi.spyOn(process, "kill");

  beforeEach(() => {
    kill.mockImplementation(() => true);
    mockedReadFileSync.mockReturnValue(statWithStartToken("42"));
  });

  afterAll(() => {
    kill.mockRestore();
  });

  it("classifies matching live process-start evidence as live", () => {
    expect(classifyProcessIdentity({ pid: 123, startToken: "42" })).toBe("live");
  });

  it("classifies a token mismatch as dead to prevent PID-reuse takeover", () => {
    expect(classifyProcessIdentity({ pid: 123, startToken: "41" })).toBe("dead");
  });

  it("classifies ESRCH as dead", () => {
    kill.mockImplementation(() => {
      const error = Object.assign(new Error("missing process"), { code: "ESRCH" });
      throw error;
    });

    expect(classifyProcessIdentity({ pid: 123, startToken: "42" })).toBe("dead");
  });

  it("classifies non-ESRCH signal failures as unknown", () => {
    kill.mockImplementation(() => {
      const error = Object.assign(new Error("permission denied"), { code: "EPERM" });
      throw error;
    });

    expect(classifyProcessIdentity({ pid: 123, startToken: "42" })).toBe("unknown");
  });

  it("classifies unreadable process-start evidence as unknown", () => {
    mockedReadFileSync.mockImplementation(() => {
      throw new Error("proc unavailable");
    });

    expect(classifyProcessIdentity({ pid: 123, startToken: "42" })).toBe("unknown");
  });
});
